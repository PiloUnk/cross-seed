import bencode from "bencode";
import chalk from "chalk";
import type { Knex } from "knex";
import { readFile, stat, unlink, utimes, writeFile } from "fs/promises";
import ms from "ms";
import path from "path";
import { appDir } from "./configuration.js";
import {
	ANIME_GROUP_REGEX,
	Decision,
	isAnyMatchedDecision,
	MatchMode,
	parseSource,
	REPACK_PROPER_REGEX,
	RES_STRICT_REGEX,
	SEASON_REGEX,
	TORRENT_CACHE_FOLDER,
} from "./constants.js";
import { db } from "./db.js";
import { Label, logger } from "./logger.js";
import { Metafile, Torrent } from "./parseTorrent.js";
import { Candidate } from "./pipeline.js";
import {
	findBlockedStringInReleaseMaybe,
	isSingleEpisode,
} from "./preFilter.js";
import { getRuntimeConfig, RuntimeConfig } from "./runtimeConfig.js";
import {
	File,
	getFuzzySizeFactor,
	getMediaType,
	getMinSizeRatio,
	getReleaseGroup,
	Searchee,
	SearcheeLabel,
	SearcheeWithLabel,
} from "./searchee.js";
import {
	findAllTorrentFilesInDir,
	getKnownTrackersForInfoHash,
	parseTorrentFromPath,
	snatch,
	SnatchError,
} from "./torrent.js";
import {
	exists,
	extractInt,
	getLogString,
	Mutex,
	sanitizeInfoHash,
	stripExtension,
	withMutex,
} from "./utils.js";
import { getClients } from "./clients/TorrentClient.js";

export interface ResultAssessment {
	decision: Decision;
	metafile?: Metafile;
	metaCached?: boolean;
	trackerMismatch?: TrackerMismatchInfo;
}

interface TrackerMismatchInfo {
	candidateTrackers: string[];
	knownTrackers: string[];
}

type ConflictRuleRow = {
	priority: number;
	all_indexers: number | boolean | null;
	trackers: string | null;
};

function getTorrentPrivateFlag(meta: Metafile | null): boolean | null {
	if (!meta) return null;
	const flag = meta.raw?.info?.private;
	if (flag === 1) return true;
	if (flag === 0) return false;
	return null;
}
async function canRecordPrivateCollision(
	candidateMetafile: Metafile | null,
	context?: {
		name?: string;
		tracker?: string;
		infoHash?: string | null;
	},
): Promise<boolean> {
	const candidateFlag = getTorrentPrivateFlag(candidateMetafile);
	if (candidateFlag !== true) {
		const infoHash = context?.infoHash
			? sanitizeInfoHash(context.infoHash)
			: "unknown";
		logger.verbose({
			label: Label.DECIDE,
			message: `Skipping collision record for ${context?.name ?? "candidate"} (${context?.tracker ?? "unknown"}) [${infoHash}]: candidate torrent is not private`,
		});
		return false;
	}
	return true;
}

async function upsertCollisionRecord(
	decisionId: number,
	trackerMismatch: TrackerMismatchInfo,
	firstSeen: number,
	lastSeen: number,
	trx?: Knex.Transaction,
): Promise<void> {
	const dbOrTrx = trx ?? db;
	const payload = {
		decision_id: decisionId,
		candidate_trackers: JSON.stringify(trackerMismatch.candidateTrackers),
		known_trackers: JSON.stringify(trackerMismatch.knownTrackers),
		first_seen: firstSeen,
		last_seen: lastSeen,
		updated_at: Date.now(),
	};
	const decisionRow = await dbOrTrx("decision")
		.select("info_hash", "searchee_id")
		.where({ id: decisionId })
		.first();
	if (decisionRow?.info_hash && decisionRow?.searchee_id) {
		const searcheeRow = await dbOrTrx("searchee")
			.select("name")
			.where({ id: decisionRow.searchee_id })
			.first();
		if (searcheeRow?.name) {
			const existing = await dbOrTrx("collisions")
				.join("decision", "collisions.decision_id", "decision.id")
				.join("searchee", "decision.searchee_id", "searchee.id")
				.where({
					"decision.info_hash": decisionRow.info_hash,
					"searchee.name": searcheeRow.name,
					"collisions.candidate_trackers": payload.candidate_trackers,
					"collisions.known_trackers": payload.known_trackers,
				})
				.whereNot("collisions.decision_id", decisionId)
				.select({ decisionId: "collisions.decision_id" })
				.first();
			if (existing?.decisionId) {
				await dbOrTrx("collisions")
					.where({ decision_id: existing.decisionId })
					.update({
						last_seen: payload.last_seen,
						updated_at: payload.updated_at,
					});
				await dbOrTrx("collisions")
					.where({ decision_id: decisionId })
					.del();
				return;
			}
		}
	}
	await dbOrTrx("collisions")
		.insert(payload)
		.onConflict("decision_id")
		.merge({
			candidate_trackers: payload.candidate_trackers,
			known_trackers: payload.known_trackers,
			last_seen: payload.last_seen,
			updated_at: payload.updated_at,
		});
}

async function deleteCollisionRecord(
	decisionId: number,
	trx?: Knex.Transaction,
): Promise<void> {
	const dbOrTrx = trx ?? db;
	await dbOrTrx("collisions").where({ decision_id: decisionId }).del();
}

function normalizeTrackers(trackers: string[] | undefined): string[] {
	return Array.from(
		new Set(
			(trackers ?? []).map((tracker) => tracker.trim()).filter(Boolean),
		),
	).sort();
}

function normalizeTrackerKey(value: string): string {
	return value.trim().toLowerCase();
}

function parseTrackersJson(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item) => typeof item === "string");
	} catch {
		return [];
	}
}

async function getIndexerTrackerSet(): Promise<Set<string>> {
	const rows: { trackers: string | null }[] =
		await db("indexer").select("trackers");
	const trackerSet = new Set<string>();
	for (const row of rows) {
		for (const tracker of parseTrackersJson(row.trackers)) {
			trackerSet.add(normalizeTrackerKey(tracker));
		}
	}
	return trackerSet;
}

async function getConflictRules() {
	const rows: ConflictRuleRow[] = await db("conflict_rules")
		.select("priority", "all_indexers", "trackers")
		.orderBy("priority", "asc");
	return rows.map((row) => ({
		priority: row.priority,
		allIndexers: Boolean(row.all_indexers),
		trackers: normalizeTrackers(parseTrackersJson(row.trackers)),
	}));
}

function getTrackerPriority(
	tracker: string,
	rules: { allIndexers: boolean; trackers: string[] }[],
	indexerTrackers: Set<string>,
): number | null {
	const normalized = normalizeTrackerKey(tracker);
	for (let i = 0; i < rules.length; i += 1) {
		const rule = rules[i];
		if (rule.allIndexers && indexerTrackers.has(normalized)) return i;
		if (rule.trackers.some((t) => normalizeTrackerKey(t) === normalized)) {
			return i;
		}
	}
	return null;
}

function getBestTrackerPriority(
	trackers: string[],
	rules: { allIndexers: boolean; trackers: string[] }[],
	indexerTrackers: Set<string>,
): number | null {
	let bestPriority = Number.POSITIVE_INFINITY;
	for (const tracker of trackers) {
		const priority = getTrackerPriority(tracker, rules, indexerTrackers);
		if (priority === null) continue;
		bestPriority = Math.min(bestPriority, priority);
	}
	return bestPriority === Number.POSITIVE_INFINITY ? null : bestPriority;
}

async function removeTorrentFromClients(
	infoHash: string,
	searcheeName: string,
): Promise<boolean> {
	const rows: { client_host: string | null }[] = await db("client_searchee")
		.select("client_host")
		.where({ info_hash: infoHash });
	if (!rows.length) return false;
	const clients = getClients();
	logger.verbose({
		label: Label.DECIDE,
		message: `${chalk.yellow("Attempting to remove existing torrent")} ${chalk.magenta(searcheeName)} [${sanitizeInfoHash(infoHash)}] from ${rows.length} client(s)`,
	});
	for (const row of rows) {
		if (!row.client_host) return false;
		const client = clients.find((c) => c.clientHost === row.client_host);
		if (!client) return false;
		logger.verbose({
			label: Label.DECIDE,
			message: `${chalk.yellow("Removing torrent")} ${chalk.magenta(searcheeName)} [${sanitizeInfoHash(infoHash)}] from ${client.label}`,
		});
		const removeRes = await client.removeTorrent(infoHash, {
			deleteData: false,
		});
		if (removeRes.isErr() || !removeRes.unwrap()) {
			const errMessage = removeRes.isErr()
				? removeRes.unwrapErr().message
				: "client returned false";
			logger.verbose({
				label: Label.DECIDE,
				message: `Failed to remove torrent ${searcheeName} [${sanitizeInfoHash(infoHash)}] from ${client.label}: ${errMessage}`,
			});
			return false;
		}
		const exists = await client.isTorrentInClient(infoHash);
		if (exists.isErr() || exists.unwrap()) {
			const errMessage = exists.isErr()
				? exists.unwrapErr().message
				: "torrent still present";
			logger.verbose({
				label: Label.DECIDE,
				message: `Removal verification failed for ${searcheeName} [${sanitizeInfoHash(infoHash)}] on ${client.label}: ${errMessage}`,
			});
			return false;
		}
		await db("client_searchee")
			.where({ info_hash: infoHash, client_host: row.client_host })
			.del();
		logger.verbose({
			label: Label.DECIDE,
			message: `Removed torrent ${searcheeName} [${sanitizeInfoHash(infoHash)}] from ${client.label}`,
		});
	}
	return true;
}

async function resolveConflictRules(
	infoHash: string,
	candidateTrackers: string[],
	searcheeName: string,
): Promise<boolean> {
	const rules = await getConflictRules();
	if (!rules.length) {
		logger.verbose({
			label: Label.DECIDE,
			message: `No conflict rules found for ${searcheeName} [${sanitizeInfoHash(infoHash)}]`,
		});
		return false;
	}
	const indexerTrackers = await getIndexerTrackerSet();
	const candidatePriority = getBestTrackerPriority(
		candidateTrackers,
		rules,
		indexerTrackers,
	);
	if (candidatePriority === null) {
		logger.verbose({
			label: Label.DECIDE,
			message: `Conflict rules: candidate [${candidateTrackers.join(", ")}] has no priority for ${searcheeName} [${sanitizeInfoHash(infoHash)}]`,
		});
		return false;
	}
	const rows: { trackers: string | null }[] = await db("client_searchee")
		.select("trackers")
		.where({ info_hash: infoHash });
	if (!rows.length) return false;
	const existingTrackers = rows.flatMap((row) =>
		parseTrackersJson(row.trackers),
	);
	const matchedExistingPriority = getBestTrackerPriority(
		existingTrackers,
		rules,
		indexerTrackers,
	);
	const bestExistingPriority =
		matchedExistingPriority === null
			? rules.length
			: matchedExistingPriority;
	if (candidatePriority >= bestExistingPriority) {
		logger.verbose({
			label: Label.DECIDE,
			message: `Conflict rules: candidate [${candidateTrackers.join(", ")}] (priority ${candidatePriority}) does not outrank current [${existingTrackers.join(", ")}] (priority ${bestExistingPriority}) for ${searcheeName} [${sanitizeInfoHash(infoHash)}]`,
		});
		return false;
	}
	logger.verbose({
		label: Label.DECIDE,
		message: `Conflict rules: candidate [${candidateTrackers.join(", ")}] (priority ${candidatePriority}) outranks current [${existingTrackers.join(", ")}] (priority ${bestExistingPriority}) for ${searcheeName} [${sanitizeInfoHash(infoHash)}]`,
	});
	const removed = await removeTorrentFromClients(infoHash, searcheeName);
	const candidateLabel = candidateTrackers.length
		? candidateTrackers.join(", ")
		: "unknown";
	const existingLabel = existingTrackers.length
		? existingTrackers.join(", ")
		: "unknown";
	if (removed) {
		logger.info({
			label: Label.DECIDE,
			message: `${chalk.yellow("Removed existing torrent")} ${chalk.magenta(searcheeName)} [${sanitizeInfoHash(infoHash)}] seeding on tracker ${chalk.yellow(existingLabel)} based on conflict rules for ${chalk.green(candidateLabel)}`,
		});
	} else {
		logger.warn({
			label: Label.DECIDE,
			message: `Failed to remove existing torrent ${sanitizeInfoHash(infoHash)} seeding on tracker ${existingLabel} for conflict rules on ${candidateLabel}`,
		});
	}
	return removed;
}

export async function resolveConflictRulesForCollision(
	infoHash: string,
	candidateTrackers: string[],
	searcheeName: string,
): Promise<boolean> {
	return resolveConflictRules(infoHash, candidateTrackers, searcheeName);
}

function trackersAreEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

async function logAnnounceMismatch(
	metafile: Metafile,
): Promise<TrackerMismatchInfo | null> {
	const known = await getKnownTrackersForInfoHash(metafile.infoHash);
	if (!known) return null;

	const candidateTrackers = normalizeTrackers(metafile.trackers);
	const knownTrackers = normalizeTrackers(known.trackers);
	if (!candidateTrackers.length && !knownTrackers.length) return null;
	if (trackersAreEqual(candidateTrackers, knownTrackers)) return null;

	return { candidateTrackers, knownTrackers };
}

function logDecision(
	searchee: Searchee,
	candidate: Candidate,
	decision: Decision,
	metafile: Metafile | undefined,
	tracker: string,
	trackerMismatch: TrackerMismatchInfo | undefined,
	options?: { configOverride: Partial<RuntimeConfig> },
): void {
	const { blockList, matchMode } = getRuntimeConfig(options?.configOverride);

	let reason: string;
	let match = "no match";
	switch (decision) {
		case Decision.RELEASE_GROUP_MISMATCH:
			reason = `it has a different release group: ${getReleaseGroup(
				stripExtension(searchee.title),
			)} -> ${getReleaseGroup(stripExtension(candidate.name))}`;
			break;
		case Decision.RESOLUTION_MISMATCH:
			reason = `its resolution does not match: ${
				searchee.title.match(RES_STRICT_REGEX)?.groups?.res
			} -> ${candidate.name.match(RES_STRICT_REGEX)?.groups?.res}`;
			break;
		case Decision.SOURCE_MISMATCH:
			reason = `it has a different source: ${parseSource(searchee.title)} -> ${parseSource(candidate.name)}`;
			break;
		case Decision.PROPER_REPACK_MISMATCH:
			reason = `one is a different subsequent release: ${
				searchee.title.match(REPACK_PROPER_REGEX)?.groups?.type ??
				"INITIAL"
			} -> ${candidate.name.match(REPACK_PROPER_REGEX)?.groups?.type ?? "INITIAL"}`;
			break;
		case Decision.FUZZY_SIZE_MISMATCH:
			reason = `the total sizes are outside of the fuzzySizeThreshold range: ${Math.abs((candidate.size! - searchee.length) / searchee.length).toFixed(3)} > ${getFuzzySizeFactor(searchee)}`;
			break;
		case Decision.MATCH:
			match = decision;
			reason =
				"all file sizes and file names match: torrent progress will be 100%";
			break;
		case Decision.MATCH_SIZE_ONLY:
			match = decision;
			reason = "all file sizes match: torrent progress will be 100%";
			break;
		case Decision.MATCH_PARTIAL:
			match = decision;
			reason = `most file sizes match: torrent progress will be ~${(getPartialSizeRatio(metafile!, searchee) * 100).toFixed(3)}%`;
			break;
		case Decision.PARTIAL_SIZE_MISMATCH:
			reason = `too many files are missing or have different sizes: torrent progress would be ${(getPartialSizeRatio(metafile!, searchee) * 100).toFixed(3)}%`;
			break;
		case Decision.SIZE_MISMATCH:
			reason = `some files are missing or have different sizes${compareFileTreesPartial(metafile!, searchee) ? ` (will match in partial match mode)` : ""}`;
			break;
		case Decision.SAME_INFO_HASH:
			reason = "the infoHash is the same";
			break;
		case Decision.INFO_HASH_ALREADY_EXISTS:
			reason = "the infoHash matches a torrent you already have";
			break;
		case Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER:
			reason =
				"the infoHash matches a torrent you already have on another tracker:";
			if (trackerMismatch?.candidateTrackers.length) {
				reason += ` candidate=[${trackerMismatch.candidateTrackers.join(", ")}]`;
			}
			if (trackerMismatch?.knownTrackers.length) {
				reason += ` existing=[${chalk.yellow(trackerMismatch.knownTrackers.join(", "))}]`;
			}
			break;
		case Decision.FILE_TREE_MISMATCH:
			reason = `it has a different file tree${matchMode === MatchMode.STRICT ? " (will match in flexible or partial matchMode)" : ""}`;
			break;
		case Decision.MAGNET_LINK:
			reason = "the torrent is a magnet link";
			break;
		case Decision.RATE_LIMITED:
			reason = "cross-seed has reached this tracker's rate limit";
			break;
		case Decision.DOWNLOAD_FAILED:
			reason = "the torrent file failed to download";
			break;
		case Decision.NO_DOWNLOAD_LINK:
			reason = "it doesn't have a download link";
			break;
		case Decision.BLOCKED_RELEASE:
			reason = `it matches the blocklist: ${
				findBlockedStringInReleaseMaybe(searchee, blockList) ??
				findBlockedStringInReleaseMaybe(metafile!, blockList)
			}`;
			break;
		default:
			reason = decision;
			break;
	}
	logger.verbose({
		label: `${searchee.label}/${Label.DECIDE}`,
		message: `${getLogString(searchee)} - ${match} for ${tracker} torrent ${candidate.name}${metafile ? ` [${sanitizeInfoHash(metafile.infoHash)}]` : ""} - ${reason}`,
	});
}

export function compareFileTrees(
	candidate: Metafile,
	searchee: Searchee,
): boolean {
	let cmp: (elOfA: File, elOfB: File) => boolean;
	if (!searchee.infoHash && !searchee.path) {
		// Absolute path so need name
		cmp = (elOfA: File, elOfB: File) => {
			const lengthsAreEqual = elOfB.length === elOfA.length;
			const namesAreEqual = elOfB.name === elOfA.name;
			return lengthsAreEqual && namesAreEqual;
		};
	} else {
		cmp = (elOfA: File, elOfB: File) => {
			const lengthsAreEqual = elOfB.length === elOfA.length;
			const pathsAreEqual = elOfB.path === elOfA.path;
			return lengthsAreEqual && pathsAreEqual;
		};
	}

	return candidate.files.every((elOfA) =>
		searchee.files.some((elOfB) => cmp(elOfA, elOfB)),
	);
}

export function compareFileTreesIgnoringNames(
	candidate: Metafile,
	searchee: Searchee,
): boolean {
	const availableFiles = searchee.files.slice();
	for (const candidateFile of candidate.files) {
		let matchedSearcheeFiles = availableFiles.filter(
			(searcheeFile) => searcheeFile.length === candidateFile.length,
		);
		if (matchedSearcheeFiles.length > 1) {
			matchedSearcheeFiles = matchedSearcheeFiles.filter(
				(searcheeFile) => searcheeFile.name === candidateFile.name,
			);
		}
		if (matchedSearcheeFiles.length === 0) {
			return false;
		}
		const index = availableFiles.indexOf(matchedSearcheeFiles[0]);
		availableFiles.splice(index, 1);
	}
	return true;
}

export function getPartialSizeRatio(
	candidate: Metafile,
	searchee: Searchee,
): number {
	let matchedSizes = 0;
	for (const candidateFile of candidate.files) {
		const searcheeHasFileSize = searchee.files.some(
			(searcheeFile) => searcheeFile.length === candidateFile.length,
		);
		if (searcheeHasFileSize) {
			matchedSizes += candidateFile.length;
		}
	}
	return matchedSizes / candidate.length;
}

export function compareFileTreesPartial(
	candidate: Metafile,
	searchee: Searchee,
): boolean {
	let matchedSizes = 0;
	const availableFiles = searchee.files.slice();
	for (const candidateFile of candidate.files) {
		let matchedSearcheeFiles = availableFiles.filter(
			(searcheeFile) => searcheeFile.length === candidateFile.length,
		);
		if (matchedSearcheeFiles.length > 1) {
			matchedSearcheeFiles = matchedSearcheeFiles.filter(
				(searcheeFile) => searcheeFile.name === candidateFile.name,
			);
		}
		if (matchedSearcheeFiles.length) {
			matchedSizes += candidateFile.length;
			const index = availableFiles.indexOf(matchedSearcheeFiles[0]);
			availableFiles.splice(index, 1);
		}
	}
	const totalPieces = Math.ceil(candidate.length / candidate.pieceLength);
	const availablePieces = Math.floor(matchedSizes / candidate.pieceLength);
	return availablePieces / totalPieces >= getMinSizeRatio(searchee);
}

function fuzzySizeDoesMatch(resultSize: number, searchee: Searchee) {
	const fuzzySizeFactor = getFuzzySizeFactor(searchee);

	const { length } = searchee;
	const lowerBound = length - fuzzySizeFactor * length;
	const upperBound = length + fuzzySizeFactor * length;
	return resultSize >= lowerBound && resultSize <= upperBound;
}

function resolutionDoesMatch(searcheeTitle: string, candidateName: string) {
	const searcheeRes = searcheeTitle
		.match(RES_STRICT_REGEX)
		?.groups?.res?.trim()
		?.toLowerCase();
	const candidateRes = candidateName
		.match(RES_STRICT_REGEX)
		?.groups?.res?.trim()
		?.toLowerCase();
	if (!searcheeRes || !candidateRes) return true;
	return extractInt(searcheeRes) === extractInt(candidateRes);
}

function releaseGroupDoesMatch(searcheeTitle: string, candidateName: string) {
	const searcheeReleaseGroup = getReleaseGroup(
		stripExtension(searcheeTitle),
	)?.toLowerCase();
	const candidateReleaseGroup = getReleaseGroup(
		stripExtension(candidateName),
	)?.toLowerCase();

	if (!searcheeReleaseGroup || !candidateReleaseGroup) {
		return true; // Pass if missing -GRP
	}
	if (
		searcheeReleaseGroup.startsWith(candidateReleaseGroup) ||
		candidateReleaseGroup.startsWith(searcheeReleaseGroup)
	) {
		return true; // -GRP matches
	}

	// Anime naming can cause weird things to match as release groups
	const searcheeAnimeGroup = searcheeTitle
		.match(ANIME_GROUP_REGEX)
		?.groups?.group?.trim()
		?.toLowerCase();
	const candidateAnimeGroup = candidateName
		.match(ANIME_GROUP_REGEX)
		?.groups?.group?.trim()
		?.toLowerCase();
	if (!searcheeAnimeGroup && !candidateAnimeGroup) {
		return false;
	}

	// Most checks will never get here, below are rare edge cases
	if (searcheeAnimeGroup === candidateAnimeGroup) {
		return true;
	}
	if (searcheeAnimeGroup && searcheeAnimeGroup === candidateReleaseGroup) {
		return true;
	}
	if (candidateAnimeGroup && searcheeReleaseGroup === candidateAnimeGroup) {
		return true;
	}
	return false;
}

function sourceDoesMatch(searcheeTitle: string, candidateName: string) {
	const searcheeSource = parseSource(searcheeTitle);
	const candidateSource = parseSource(candidateName);
	if (!searcheeSource || !candidateSource) return true;
	return searcheeSource === candidateSource;
}

function releaseVersionDoesMatch(searcheeName: string, candidateName: string) {
	return (
		REPACK_PROPER_REGEX.test(searcheeName) ===
		REPACK_PROPER_REGEX.test(candidateName)
	);
}

export async function assessCandidate(
	metaOrCandidate: Metafile | Candidate,
	searchee: SearcheeWithLabel,
	infoHashesToExclude: Set<string>,
	blockList: string[],
	options?: { configOverride: Partial<RuntimeConfig> },
	candidateTracker?: string,
): Promise<ResultAssessment> {
	const { includeSingleEpisodes, matchMode } = getRuntimeConfig(
		options?.configOverride,
	);

	// When metaOrCandidate is a Metafile, skip straight to the
	// main matching algorithms as we don't need pre-download filtering.
	const isCandidate = !(metaOrCandidate instanceof Metafile);
	if (isCandidate) {
		const name = metaOrCandidate.name;
		if (!releaseGroupDoesMatch(searchee.title, name)) {
			return { decision: Decision.RELEASE_GROUP_MISMATCH };
		}
		if (!resolutionDoesMatch(searchee.title, name)) {
			return { decision: Decision.RESOLUTION_MISMATCH };
		}
		if (!sourceDoesMatch(searchee.title, name)) {
			return { decision: Decision.SOURCE_MISMATCH };
		}
		if (!releaseVersionDoesMatch(searchee.title, name)) {
			return { decision: Decision.PROPER_REPACK_MISMATCH };
		}
		const size = metaOrCandidate.size;
		if (size && !fuzzySizeDoesMatch(size, searchee)) {
			return { decision: Decision.FUZZY_SIZE_MISMATCH };
		}
		if (!metaOrCandidate.link) {
			return { decision: Decision.NO_DOWNLOAD_LINK };
		}
	}

	let metaCached = !isCandidate;

	if (findBlockedStringInReleaseMaybe(searchee, blockList)) {
		return {
			decision: Decision.BLOCKED_RELEASE,
			metafile: !isCandidate ? metaOrCandidate : undefined,
			metaCached,
		};
	}

	let metafile: Metafile;
	if (isCandidate) {
		const res = await snatch(metaOrCandidate, searchee.label, {
			retries: 4,
			delayMs:
				searchee.label === Label.ANNOUNCE
					? ms("5 minutes")
					: ms("1 minute"),
		});
		if (res.isErr()) {
			const err = res.unwrapErr();
			return err === SnatchError.MAGNET_LINK
				? { decision: Decision.MAGNET_LINK }
				: err === SnatchError.RATE_LIMITED
					? { decision: Decision.RATE_LIMITED }
					: { decision: Decision.DOWNLOAD_FAILED };
		}
		metafile = res.unwrap();
		metaCached = await cacheTorrentFile(
			metafile,
			metaOrCandidate,
			searchee.label,
		);
		metaOrCandidate.size = metafile.length; // Trackers can be wrong
	} else {
		metafile = metaOrCandidate;
	}

	if (searchee.infoHash === metafile.infoHash) {
		const trackerMismatch = await logAnnounceMismatch(metafile);
		return {
			decision: trackerMismatch
				? Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER
				: Decision.SAME_INFO_HASH,
			metafile,
			metaCached,
			trackerMismatch: trackerMismatch ?? undefined,
		};
	}

	if (infoHashesToExclude.has(metafile.infoHash)) {
		const trackerMismatch = await logAnnounceMismatch(metafile);
		const candidateTrackers = trackerMismatch?.candidateTrackers.length
			? trackerMismatch.candidateTrackers
			: candidateTracker
				? [candidateTracker]
				: [];
		if (candidateTrackers.length) {
			const resolved = await resolveConflictRules(
				metafile.infoHash,
				candidateTrackers,
				searchee.title,
			);
			if (resolved) {
				infoHashesToExclude.delete(metafile.infoHash);
			}
		}
		if (infoHashesToExclude.has(metafile.infoHash)) {
			return {
				decision: trackerMismatch
					? Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER
					: Decision.INFO_HASH_ALREADY_EXISTS,
				metafile,
				metaCached,
				trackerMismatch: trackerMismatch ?? undefined,
			};
		}
	}

	if (findBlockedStringInReleaseMaybe(metafile, blockList)) {
		return { decision: Decision.BLOCKED_RELEASE, metafile, metaCached };
	}

	// Prevent candidate episodes from matching searchee season packs
	if (
		!includeSingleEpisodes &&
		SEASON_REGEX.test(searchee.title) &&
		isSingleEpisode(metafile, getMediaType(metafile))
	) {
		return { decision: Decision.FILE_TREE_MISMATCH, metafile, metaCached };
	}

	const perfectMatch = compareFileTrees(metafile, searchee);
	if (perfectMatch) {
		return { decision: Decision.MATCH, metafile, metaCached };
	}

	const sizeMatch = compareFileTreesIgnoringNames(metafile, searchee);
	if (sizeMatch && matchMode !== MatchMode.STRICT) {
		return { decision: Decision.MATCH_SIZE_ONLY, metafile, metaCached };
	}

	if (matchMode === MatchMode.PARTIAL) {
		const partialSizeMatch =
			getPartialSizeRatio(metafile, searchee) >=
			getMinSizeRatio(searchee);
		if (!partialSizeMatch) {
			return {
				decision: Decision.PARTIAL_SIZE_MISMATCH,
				metafile,
				metaCached,
			};
		}
		const partialMatch = compareFileTreesPartial(metafile, searchee);
		if (partialMatch) {
			return { decision: Decision.MATCH_PARTIAL, metafile, metaCached };
		}
	} else if (!sizeMatch) {
		return { decision: Decision.SIZE_MISMATCH, metafile, metaCached };
	}

	return { decision: Decision.FILE_TREE_MISMATCH, metafile, metaCached };
}

export function getCachedTorrentName(infoHash: string): string {
	return `${infoHash}.cached.torrent`;
}

async function existsInTorrentCache(infoHash: string): Promise<string | null> {
	const torrentPath = path.join(
		appDir(),
		TORRENT_CACHE_FOLDER,
		getCachedTorrentName(infoHash),
	);
	if (await exists(torrentPath)) return torrentPath;
	return null;
}

async function getCachedTorrent(
	infoHash: string | undefined,
	searcheeLabel: SearcheeLabel,
): Promise<{ meta: Metafile; torrentPath: string } | null> {
	if (!infoHash) return null;
	const torrentPath = await existsInTorrentCache(infoHash);
	if (!torrentPath) return null;
	let meta: Metafile;
	try {
		meta = await parseTorrentFromPath(torrentPath);
	} catch (e) {
		logger.error({
			label: `${searcheeLabel}/${Label.DECIDE}`,
			message: `Failed to parse cached torrent ${torrentPath.replace(infoHash, sanitizeInfoHash(infoHash))} - deleting: ${e.message}`,
		});
		logger.debug(e);
		try {
			await unlink(torrentPath); // cleanup job handles db entries
		} catch (e) {
			if (await exists(torrentPath)) {
				logger.error({
					label: `${searcheeLabel}/${Label.DECIDE}`,
					message: `Failed to delete corrupted cached torrent ${torrentPath.replace(infoHash, sanitizeInfoHash(infoHash))}: ${e.message}`,
				});
				logger.debug(e);
			}
		}
		return null;
	}
	await utimes(torrentPath, new Date(), (await stat(torrentPath)).mtime);
	return { meta, torrentPath };
}

async function cacheTorrentFile(
	meta: Metafile,
	candidate: Candidate,
	searcheeLabel: SearcheeLabel,
): Promise<boolean> {
	let cached = false;
	try {
		const torrentPath = path.join(
			appDir(),
			TORRENT_CACHE_FOLDER,
			getCachedTorrentName(meta.infoHash),
		);
		await writeFile(torrentPath, new Uint8Array(meta.encode()));
		cached = true;
		if (candidate.indexerId && meta.trackers.length) {
			const dbIndexer = await db("indexer")
				.where({ id: candidate.indexerId })
				.first();
			const dbTrackers: string[] = dbIndexer?.trackers
				? JSON.parse(dbIndexer.trackers)
				: [];
			let added = false;
			for (const tracker of meta.trackers) {
				if (dbTrackers.includes(tracker)) continue;
				dbTrackers.push(tracker);
				added = true;
			}
			if (added) {
				await db("indexer")
					.where({ id: candidate.indexerId })
					.update({ trackers: JSON.stringify(dbTrackers) });
			}
		}
		return cached;
	} catch (e) {
		logger.error({
			label: `${searcheeLabel}/${Label.DECIDE}`,
			message: `Error while caching torrent ${getLogString(meta)}: ${e.message}`,
		});
		logger.debug(e);
		return cached;
	}
}

export async function updateTorrentCache(
	oldStr: string,
	newStr: string,
): Promise<void> {
	const torrentCacheDir = path.join(appDir(), TORRENT_CACHE_FOLDER);
	const torrentPaths = await findAllTorrentFilesInDir(torrentCacheDir);
	console.log(`Found ${torrentPaths.length} files in cache, processing...`);
	let count = 0;
	for (const torrentPath of torrentPaths) {
		try {
			const torrent: Torrent = bencode.decode(
				await readFile(torrentPath),
			);
			const announce = torrent.announce?.toString();
			const announceList = torrent["announce-list"]?.map((tier) =>
				tier.map((url) => url.toString()),
			);
			if (
				!announce?.includes(oldStr) &&
				!announceList?.some((t) =>
					t.some((url) => url.includes(oldStr)),
				)
			) {
				continue;
			}
			count++;
			console.log(`#${count}: ${torrentPath}`);
			let updated = false;
			if (announce) {
				const newAnnounce = announce.replace(oldStr, newStr);
				if (announce !== newAnnounce) {
					updated = true;
					console.log(`--- ${announce} -> ${newAnnounce}`);
					torrent.announce = Buffer.from(newAnnounce);
				}
			}
			if (announceList) {
				torrent["announce-list"] = announceList.map((tier) =>
					tier.map((url) => {
						const newAnnounce = url.replace(oldStr, newStr);
						if (url === newAnnounce) return Buffer.from(url);
						updated = true;
						console.log(`--- ${url} -> ${newAnnounce}`);
						return Buffer.from(newAnnounce);
					}),
				);
			}
			if (updated) {
				await writeFile(
					torrentPath,
					new Uint8Array(bencode.encode(torrent)),
				);
			}
		} catch (e) {
			console.error(`Error reading ${torrentPath}: ${e}`);
		}
	}
}

async function assessAndSaveResults(
	metaOrCandidate: Metafile | Candidate,
	searchee: SearcheeWithLabel,
	guid: string,
	infoHashesToExclude: Set<string>,
	firstSeen: number,
	guidInfoHashMap: Map<string, string>,
	candidateTracker: string,
	options?: { configOverride: Partial<RuntimeConfig> },
) {
	const { blockList } = getRuntimeConfig(options?.configOverride);
	const assessment = await assessCandidate(
		metaOrCandidate,
		searchee,
		infoHashesToExclude,
		blockList,
		options,
		candidateTracker,
	);

	if (assessment.metaCached && assessment.metafile) {
		await withMutex(
			Mutex.GUID_INFO_HASH_MAP,
			{ useQueue: true },
			async () => {
				guidInfoHashMap.set(guid, assessment.metafile!.infoHash);
				await db.transaction(async (trx) => {
					const { id } = (await trx("searchee")
						.select("id")
						.where({ name: searchee.title })
						.first())!;
					await trx("decision")
						.insert({
							searchee_id: id,
							guid: guid,
							info_hash: assessment.metafile!.infoHash,
							decision: assessment.decision,
							first_seen: firstSeen,
							last_seen: Date.now(),
							fuzzy_size_factor: getFuzzySizeFactor(searchee),
						})
						.onConflict(["searchee_id", "guid"])
						.merge();
					const decisionRow = await trx("decision")
						.select("id")
						.where({ searchee_id: id, guid })
						.first();
					if (!decisionRow?.id) return;
					if (
						assessment.decision ===
							Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER &&
						assessment.trackerMismatch
					) {
						const shouldRecord = await canRecordPrivateCollision(
							assessment.metafile ??
								(metaOrCandidate instanceof Metafile
									? metaOrCandidate
									: null),
							metaOrCandidate instanceof Metafile
								? undefined
								: {
										name: metaOrCandidate.name,
										tracker: metaOrCandidate.tracker,
										infoHash:
											assessment.metafile?.infoHash ??
											null,
									},
						);
						if (shouldRecord) {
							await upsertCollisionRecord(
								decisionRow.id,
								assessment.trackerMismatch,
								firstSeen,
								Date.now(),
								trx,
							);
						} else {
							await deleteCollisionRecord(decisionRow.id, trx);
						}
					} else {
						await deleteCollisionRecord(decisionRow.id, trx);
					}
				});
			},
		);
	}

	return assessment;
}

export const rawGuidInfoHashMap: Map<string, string> = new Map();
export async function rebuildGuidInfoHashMap(): Promise<void> {
	return withMutex(Mutex.GUID_INFO_HASH_MAP, { useQueue: true }, async () => {
		const res = await db("decision")
			.select("guid", "info_hash")
			.whereNotNull("info_hash");
		rawGuidInfoHashMap.clear(); // Needs to be async atomic for clearing and setting
		for (const { guid, info_hash } of res) {
			rawGuidInfoHashMap.set(guid, info_hash);
		}
	});
}
export async function getGuidInfoHashMap(): Promise<Map<string, string>> {
	if (!rawGuidInfoHashMap.size) await rebuildGuidInfoHashMap();
	return rawGuidInfoHashMap;
}

/**
 * Some trackers have alt titles which get their own guid but resolve to same torrent
 * @param guid The guid of the candidate
 * @param link The link of the candidate
 * @param guidInfoHashMap The map of guids to infoHashes. Necessary for optimal fuzzy lookups.
 * @returns The infoHash of the torrent if found
 */
function guidLookup(
	guid: string,
	link: string,
	guidInfoHashMap: Map<string, string>,
): string | undefined {
	const infoHash = guidInfoHashMap.get(guid) ?? guidInfoHashMap.get(link);
	if (infoHash) return infoHash;

	const torrentIdRegex = /\.tv\/torrent\/(\d+)\/group/;
	for (const guidOrLink of [guid, link]) {
		const torrentIdStr = guidOrLink.match(torrentIdRegex)?.[1];
		if (!torrentIdStr) continue;
		for (const [key, value] of guidInfoHashMap) {
			if (key.match(torrentIdRegex)?.[1] === torrentIdStr) return value;
		}
	}
}

export async function assessCandidateCaching(
	candidate: Candidate,
	searchee: SearcheeWithLabel,
	infoHashesToExclude: Set<string>,
	guidInfoHashMap: Map<string, string>,
	options?: { configOverride: Partial<RuntimeConfig> },
): Promise<ResultAssessment> {
	const { name, guid, link, tracker } = candidate;

	const cacheEntry = await db("decision")
		.select({
			id: "decision.id",
			infoHash: "decision.info_hash",
			decision: "decision.decision",
			firstSeen: "decision.first_seen",
			fuzzySizeFactor: "decision.fuzzy_size_factor",
		})
		.join("searchee", "decision.searchee_id", "searchee.id")
		.where({ name: searchee.title, guid })
		.first();
	const infoHash = guidLookup(guid, link, guidInfoHashMap);
	const res = await getCachedTorrent(infoHash, searchee.label);
	const metaOrCandidate = res?.meta ?? candidate;
	if (metaOrCandidate instanceof Metafile) {
		logger.verbose({
			label: `${searchee.label}/${Label.DECIDE}`,
			message: `Using cached torrent for ${tracker} assessment ${name}: ${getLogString(metaOrCandidate)}`,
		});
		candidate.size = metaOrCandidate.length; // Trackers can be wrong
	}

	let assessment: ResultAssessment;
	if (cacheEntry && infoHashesToExclude.has(cacheEntry.infoHash)) {
		const trackerMismatch =
			metaOrCandidate instanceof Metafile
				? await logAnnounceMismatch(metaOrCandidate)
				: null;
		const candidateTrackers = trackerMismatch?.candidateTrackers.length
			? trackerMismatch.candidateTrackers
			: tracker
				? [tracker]
				: [];
		if (candidateTrackers.length) {
			const resolved = await resolveConflictRules(
				cacheEntry.infoHash,
				candidateTrackers,
				searchee.title,
			);
			if (resolved) {
				infoHashesToExclude.delete(cacheEntry.infoHash);
				assessment = await assessAndSaveResults(
					metaOrCandidate,
					searchee,
					guid,
					infoHashesToExclude,
					cacheEntry.firstSeen ?? Date.now(),
					guidInfoHashMap,
					tracker,
					options,
				);
				return assessment;
			}
		}
		// Already injected fast path, preserve match decision
		assessment = {
			decision: trackerMismatch
				? Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER
				: Decision.INFO_HASH_ALREADY_EXISTS,
			trackerMismatch: trackerMismatch ?? undefined,
		};
		await db("decision")
			.where({ id: cacheEntry.id })
			.update({
				last_seen: Date.now(),
				decision: isAnyMatchedDecision(cacheEntry.decision)
					? cacheEntry.decision
					: trackerMismatch
						? Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER
						: Decision.INFO_HASH_ALREADY_EXISTS,
			});
		if (trackerMismatch) {
			if (
				await canRecordPrivateCollision(
					metaOrCandidate instanceof Metafile
						? metaOrCandidate
						: null,
					{
						name: candidate.name,
						tracker: candidate.tracker,
						infoHash: cacheEntry.infoHash ?? null,
					},
				)
			) {
				await upsertCollisionRecord(
					cacheEntry.id,
					trackerMismatch,
					cacheEntry.firstSeen ?? Date.now(),
					Date.now(),
				);
			} else {
				await deleteCollisionRecord(cacheEntry.id);
			}
		} else {
			await deleteCollisionRecord(cacheEntry.id);
		}
	} else {
		assessment = await assessAndSaveResults(
			metaOrCandidate,
			searchee,
			guid,
			infoHashesToExclude,
			cacheEntry?.firstSeen ?? Date.now(),
			guidInfoHashMap,
			tracker,
			options,
		);
	}

	logDecision(
		searchee,
		candidate,
		assessment.decision,
		assessment.metafile,
		tracker,
		assessment.trackerMismatch,
		options,
	);

	return assessment;
}
