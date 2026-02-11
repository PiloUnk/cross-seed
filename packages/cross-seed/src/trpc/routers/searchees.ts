import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../index.js";
import { db } from "../../db.js";
import { findAllSearchees, bulkSearchByNames } from "../../pipeline.js";
import { Label } from "../../logger.js";
import { getSearcheeSource } from "../../searchee.js";
import { getAllIndexers, getEnabledIndexers } from "../../indexers.js";
import { getClients } from "../../clients/TorrentClient.js";
import { Decision } from "../../constants.js";

const DEFAULT_LIMIT = 50;
const MAX_BULK_SEARCH = 20;
const DEFAULT_CANDIDATE_LIMIT = 50;

function normalizeTrackers(trackers: string[] | undefined): string[] {
	return Array.from(
		new Set(
			(trackers ?? []).map((tracker) => tracker.trim()).filter(Boolean),
		),
	).sort();
}

function parseTrackerList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return normalizeTrackers(
			value.filter((item) => typeof item === "string"),
		);
	}
	if (typeof value === "string" && value.length) {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) {
				return normalizeTrackers(
					parsed.filter((item) => typeof item === "string"),
				);
			}
		} catch {
			return [];
		}
	}
	return [];
}

export const searcheesRouter = router({
	list: authedProcedure
		.input(
			z
				.object({
					search: z.string().trim().min(1).max(200).optional(),
					limit: z
						.number()
						.int()
						.min(1)
						.max(200)
						.default(DEFAULT_LIMIT),
					offset: z.number().int().min(0).default(0),
				})
				.default({
					limit: DEFAULT_LIMIT,
					offset: 0,
				}),
		)
		.query(async ({ input }) => {
			const { search, limit, offset } = input;

			let query = db("searchee");
			if (search) {
				query = query.where("searchee.name", "like", `%${search}%`);
			}

			const [{ count }] = await query
				.clone()
				.count<{ count: string | number }>({ count: "*" });

			const rows = await query
				.clone()
				.leftJoin("timestamp", "searchee.id", "timestamp.searchee_id")
				.select({
					dbId: "searchee.id",
					name: "searchee.name",
				})
				.min({
					firstSearched: "timestamp.first_searched",
				})
				.max({
					lastSearched: "timestamp.last_searched",
				})
				.countDistinct({
					indexerCount: "timestamp.indexer_id",
				})
				.groupBy("searchee.id", "searchee.name")
				.orderBy("lastSearched", "desc")
				.orderBy("firstSearched", "desc")
				.orderBy("name", "asc")
				.limit(limit)
				.offset(offset);

			const [allSearchees, allIndexers, enabledIndexers] =
				await Promise.all([
					findAllSearchees(Label.SEARCH),
					getAllIndexers(),
					getEnabledIndexers(),
				]);

			// TODO: drop the in-memory metadata lookup when searchee rows expose persistent IDs directly via TRPC.
			const searcheeMeta = new Map<
				string,
				(typeof allSearchees)[number]
			>();
			for (const searchee of allSearchees) {
				const keyCandidates = [searchee.title, searchee.name].filter(
					(candidate): candidate is string =>
						typeof candidate === "string" && candidate.length > 0,
				);
				for (const key of keyCandidates) {
					if (!searcheeMeta.has(key)) {
						searcheeMeta.set(key, searchee);
					}
				}
			}

			const items = rows.map((row) => {
				const displayName =
					// @ts-expect-error something funky going on with knex types
					typeof row.name === "string" && row.name.length
						? row.name
						: "(unknown)";
				const meta =
					searcheeMeta.get(displayName) ??
					searcheeMeta.get(displayName.trim());

				const idCandidate =
					(typeof row.dbId === "number"
						? row.dbId
						: row.dbId != null
							? Number(row.dbId)
							: null) ??
					meta?.infoHash ??
					meta?.path ??
					displayName;

				return {
					id:
						typeof idCandidate === "number"
							? idCandidate
							: String(idCandidate),
					name: displayName,
					indexerCount:
						typeof row.indexerCount === "number"
							? row.indexerCount
							: Number(row.indexerCount ?? 0),
					firstSearchedAt:
						row.firstSearched != null
							? new Date(Number(row.firstSearched)).toISOString()
							: null,
					lastSearchedAt:
						row.lastSearched != null
							? new Date(Number(row.lastSearched)).toISOString()
							: null,
					label: meta?.label ?? null,
					source: meta ? getSearcheeSource(meta) : null,
					length: meta?.length ?? null,
					clientHost: meta?.clientHost ?? null,
				};
			});

			return {
				total: Number(count ?? 0),
				pagination: {
					limit,
					offset,
				},
				indexerTotals: {
					configured: allIndexers.length,
					enabled: enabledIndexers.length,
				},
				items,
			};
		}),
	candidates: authedProcedure
		.input(
			z
				.object({
					limit: z
						.number()
						.int()
						.min(1)
						.max(200)
						.default(DEFAULT_CANDIDATE_LIMIT),
					offset: z.number().int().min(0).default(0),
					includeKnownTrackers: z.boolean().optional().default(false),
				})
				.default({
					limit: DEFAULT_CANDIDATE_LIMIT,
					offset: 0,
					includeKnownTrackers: false,
				}),
		)
		.query(async ({ input }) => {
			const { limit, offset, includeKnownTrackers } = input;

			const query = db("candidates")
				.join("decision", "candidates.decision_id", "decision.id")
				.where({
					"decision.decision":
						Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER,
				})
				.whereNotNull("decision.info_hash");

			const [{ count }] = await query
				.clone()
				.count<{ count: string | number }>({ count: "*" });

			const rows = await query
				.clone()
				.join("searchee", "decision.searchee_id", "searchee.id")
				.select({
					searcheeId: "searchee.id",
					name: "searchee.name",
					infoHash: "decision.info_hash",
					guid: "decision.guid",
					firstSeen: "candidates.first_seen",
					lastSeen: "candidates.last_seen",
					candidateTrackers: "candidates.candidate_trackers",
					knownTrackers: "candidates.known_trackers",
				})
				.orderBy("decision.last_seen", "desc")
				.orderBy("searchee.name", "asc")
				.limit(limit)
				.offset(offset);

			const infoHashes = Array.from(
				new Set(
					rows
						.map((row) =>
							typeof row.infoHash === "string" &&
							row.infoHash.length
								? row.infoHash
								: null,
						)
						.filter((value): value is string => value !== null),
				),
			);

			const clientRows = infoHashes.length
				? await db("client_searchee")
						.select("info_hash", "client_host")
						.whereIn("info_hash", infoHashes)
						.whereNotNull("client_host")
				: [];

			const clients = getClients();
			const clientTypeMap = new Map(
				clients.map((client) => [client.clientHost, client.clientType]),
			);
			const clientHostMap = new Map<string, string[]>();
			for (const row of clientRows) {
				const infoHash = row.info_hash as string | null;
				const clientHost = row.client_host as string | null;
				if (!infoHash || !clientHost) continue;
				const current = clientHostMap.get(infoHash) ?? [];
				if (!current.includes(clientHost)) current.push(clientHost);
				clientHostMap.set(infoHash, current);
			}

			const items = rows.map((row) => {
				const infoHash =
					typeof row.infoHash === "string" && row.infoHash.length
						? row.infoHash
						: null;
				const candidateTrackers = parseTrackerList(
					row.candidateTrackers,
				);
				const knownTrackers = includeKnownTrackers
					? parseTrackerList(row.knownTrackers)
					: [];

				return {
					id: `${row.searcheeId}:${row.guid ?? row.infoHash ?? "unknown"}`,
					name:
						typeof row.name === "string" && row.name.length
							? row.name
							: "(unknown)",
					clientHosts:
						infoHash != null
							? (clientHostMap.get(infoHash) ?? [])
							: [],
					clientDisplay:
						infoHash != null
							? (clientHostMap.get(infoHash) ?? []).map(
									(host) => {
										const type = clientTypeMap.get(host);
										return type
											? `${type} - ${host}`
											: host;
									},
								)
							: [],
					infoHash,
					candidateTrackers,
					knownTrackers: includeKnownTrackers ? knownTrackers : null,
					firstSeenAt:
						row.firstSeen != null
							? new Date(Number(row.firstSeen)).toISOString()
							: null,
					lastSeenAt:
						row.lastSeen != null
							? new Date(Number(row.lastSeen)).toISOString()
							: null,
				};
			});

			return {
				total: Number(count ?? 0),
				pagination: {
					limit,
					offset,
				},
				items,
			};
		}),
	bulkSearch: authedProcedure
		.input(
			z.object({
				names: z
					.array(z.string().trim().min(1).max(500))
					.min(1, "Select at least one item")
					.max(
						MAX_BULK_SEARCH,
						`You can only bulk search up to ${MAX_BULK_SEARCH} items at a time`,
					),
				force: z.boolean().optional().default(false),
			}),
		)
		.mutation(async ({ input }) => {
			const uniqueNames = Array.from(
				new Set(
					input.names
						.map((name) => name.trim())
						.filter((name) => name.length > 0),
				),
			);

			if (!uniqueNames.length) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No valid item names provided for bulk search",
				});
			}

			const configOverride = input.force
				? {
						excludeRecentSearch: 1,
						excludeOlder: Number.MAX_SAFE_INTEGER,
					}
				: undefined;
			const { attempted, totalFound, requested } =
				await bulkSearchByNames(
					uniqueNames,
					configOverride ? { configOverride } : undefined,
				);

			return {
				requested,
				attempted,
				totalFound,
				skipped: Math.max(requested - attempted, 0),
			};
		}),
});
