import ms from "ms";
import { Action, Decision } from "./constants.js";
import { cleanupDB, db } from "./db.js";
import { injectSavedTorrents } from "./inject.js";
import { Label, logger, exitOnCrossSeedErrors } from "./logger.js";
import { bulkSearch, bulkSearchByNames, scanRssFeeds } from "./pipeline.js";
import { getRuntimeConfig, RuntimeConfig } from "./runtimeConfig.js";
import { updateCaps } from "./torznab.js";
import { humanReadableDate, Mutex, withMutex } from "./utils.js";

export enum JobName {
	RSS = "rss",
	SEARCH = "search",
	UPDATE_INDEXER_CAPS = "updateIndexerCaps",
	INJECT = "inject",
	CLEANUP = "cleanup",
	COLLISION_RECHECK = "collisionRecheck",
}

const jobs: Job[] = [];

class Job {
	name: JobName;
	cadence: number;
	exec: () => Promise<void>;
	isActive: boolean;
	runAheadOfSchedule: boolean;
	delayNextRun: boolean;
	configOverride: Partial<RuntimeConfig>;
	shouldRunFn: () => boolean;

	constructor(
		name: JobName,
		cadence: number,
		exec: () => Promise<void>,
		shouldRunFn: () => boolean = () => true,
	) {
		this.name = name;
		this.cadence = cadence;
		this.exec = exec;
		this.isActive = false;
		this.runAheadOfSchedule = false;
		this.delayNextRun = false;
		this.configOverride = {};
		this.shouldRunFn = shouldRunFn;
	}

	shouldRun(): boolean {
		return this.shouldRunFn();
	}

	async run(): Promise<boolean> {
		if (this.isActive) return false;
		this.isActive = true;
		try {
			logger.info({
				label: Label.SCHEDULER,
				message: `starting job: ${this.name}`,
			});
			if (this.runAheadOfSchedule && this.name === JobName.SEARCH) {
				await bulkSearch({ configOverride: this.configOverride });
			} else {
				await this.exec();
			}
		} finally {
			this.isActive = false;
			this.runAheadOfSchedule = false;
			this.configOverride = {};
		}
		return true;
	}
}

function createJobs(): void {
	const { action, rssCadence, searchCadence } = getRuntimeConfig();
	if (rssCadence) {
		jobs.push(
			new Job(
				JobName.RSS,
				rssCadence,
				scanRssFeeds,
				() => !!getRuntimeConfig().rssCadence,
			),
		);
	}
	if (searchCadence) {
		jobs.push(
			new Job(
				JobName.SEARCH,
				searchCadence,
				bulkSearch,
				() => !!getRuntimeConfig().searchCadence,
			),
		);
	}
	jobs.push(new Job(JobName.UPDATE_INDEXER_CAPS, ms("1 day"), updateCaps));
	if (action === Action.INJECT) {
		jobs.push(new Job(JobName.INJECT, ms("1 hour"), injectSavedTorrents));
	}
	jobs.push(new Job(JobName.CLEANUP, ms("1 day"), cleanupDB));
	jobs.push(
		new Job(
			JobName.COLLISION_RECHECK,
			ms("1 hour"),
			checkResolvedCollisions,
			() => getRuntimeConfig().useClientTorrents,
		),
	);
}

export function getJobs(): Job[] {
	return jobs;
}

function logNextRun(
	name: string,
	cadence: number,
	lastRun: number | undefined | null,
) {
	const now = Date.now();

	const eligibilityTs = lastRun ? lastRun + cadence : now;

	const lastRunStr = !lastRun
		? "never"
		: now >= lastRun
			? `${ms(now - lastRun)} ago`
			: `at ${humanReadableDate(lastRun - cadence)}`;
	const nextRunStr =
		now >= eligibilityTs ? "now" : `in ${ms(eligibilityTs - now)}`;

	logger.info({
		label: Label.SCHEDULER,
		message: `${name}: last run ${lastRunStr}, next run ${nextRunStr}`,
	});
}

async function checkResolvedCollisions(): Promise<void> {
	logger.verbose({
		label: Label.SCHEDULER,
		message: "Checking for resolved collisions...",
	});
	const rows: {
		decision_id: number;
		info_hash: string | null;
		searchee_name: string | null;
	}[] = await db("collisions")
		.join("decision", "collisions.decision_id", "decision.id")
		.leftJoin("searchee", "decision.searchee_id", "searchee.id")
		.leftJoin(
			"client_searchee",
			"decision.info_hash",
			"client_searchee.info_hash",
		)
		.where(
			"decision.decision",
			Decision.INFO_HASH_ALREADY_EXISTS_ANOTHER_TRACKER,
		)
		.whereNull("client_searchee.info_hash")
		.select({
			decision_id: "collisions.decision_id",
			info_hash: "decision.info_hash",
			searchee_name: "searchee.name",
		});

	if (!rows.length) return;

	const decisionIds = Array.from(new Set(rows.map((row) => row.decision_id)));
	const searcheeNames = Array.from(
		new Set(
			rows
				.map((row) => row.searchee_name)
				.filter((name): name is string => Boolean(name)),
		),
	);

	await db("collisions").whereIn("decision_id", decisionIds).del();

	if (!searcheeNames.length) return;

	const { attempted, requested, totalFound } = await bulkSearchByNames(
		searcheeNames,
		{ configOverride: { excludeRecentSearch: 1 } },
	);
	logger.info({
		label: Label.SEARCH,
		message: `Collision recheck: searched ${attempted}/${requested}, found ${totalFound}`,
	});
}

export async function getJobLastRun(
	name: JobName,
): Promise<number | undefined> {
	return (await db("job_log").select("last_run").where({ name }).first())
		?.last_run;
}

export async function checkJobs(
	options = { isFirstRun: false, useQueue: false },
): Promise<void> {
	return withMutex(
		Mutex.CHECK_JOBS,
		{ useQueue: options.useQueue },
		async () => {
			const now = Date.now();
			for (const job of jobs) {
				if (!job.shouldRun()) {
					continue;
				}

				const lastRun = await getJobLastRun(job.name);
				const eligibilityTs = lastRun ? lastRun + job.cadence : now;
				if (options.isFirstRun) {
					logNextRun(job.name, job.cadence, lastRun);
				}

				if (!job.runAheadOfSchedule) {
					if (jobs.find((j) => j.name === JobName.RSS)?.isActive) {
						continue;
					}
					if (
						job.name === JobName.CLEANUP ||
						job.name === JobName.COLLISION_RECHECK
					) {
						if (jobs.some((j) => j.isActive)) {
							logger.verbose({
								label: Label.SCHEDULER,
								message: `skipping job ${job.name}: another job is active`,
							});
							continue;
						}
					}
				}

				if (job.runAheadOfSchedule || now >= eligibilityTs) {
					job.run()
						.then(async (didRun) => {
							if (!didRun) return; // upon success, update the log
							const toDelay = job.delayNextRun;
							job.delayNextRun = false;
							const last_run = toDelay ? now + job.cadence : now;
							await db("job_log")
								.insert({ name: job.name, last_run })
								.onConflict("name")
								.merge();
							const cadence = toDelay
								? job.cadence * 2
								: job.cadence;
							logNextRun(job.name, cadence, now);
						})
						.catch(exitOnCrossSeedErrors)
						.catch((e) => void logger.error(e));
				}
			}
		},
	);
}

export async function jobsLoop(): Promise<void> {
	createJobs();

	setInterval(checkJobs, ms("1 minute"));
	await checkJobs({ isFirstRun: true, useQueue: false });
	// jobs take too long to run to completion so let process.exit take care of stopping
	return new Promise(() => {});
}
