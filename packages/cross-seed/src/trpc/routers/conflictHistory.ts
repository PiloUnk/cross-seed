import { z } from "zod";
import { router, authedProcedure } from "../index.js";
import { db } from "../../db.js";

const DEFAULT_LIMIT = 25;

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

export const conflictHistoryRouter = router({
	filters: authedProcedure.query(async () => {
		const rows = await db("conflict_removals").select({
			removedTrackers: "removed_trackers",
			candidateTrackers: "candidate_trackers",
		});

		const removedTrackerSet = new Set<string>();
		const candidateTrackerSet = new Set<string>();

		for (const row of rows) {
			for (const tracker of parseTrackerList(row.removedTrackers)) {
				removedTrackerSet.add(tracker);
			}
			for (const tracker of parseTrackerList(row.candidateTrackers)) {
				candidateTrackerSet.add(tracker);
			}
		}

		return {
			removedTrackers: Array.from(removedTrackerSet).sort(),
			candidateTrackers: Array.from(candidateTrackerSet).sort(),
		};
	}),
	list: authedProcedure
		.input(
			z
				.object({
					limit: z
						.number()
						.int()
						.min(1)
						.max(200)
						.default(DEFAULT_LIMIT),
					offset: z.number().int().min(0).default(0),
					removedTracker: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional(),
					candidateTracker: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional(),
					includeClientInfo: z.boolean().optional().default(false),
				})
				.default({
					limit: DEFAULT_LIMIT,
					offset: 0,
				}),
		)
		.query(async ({ input }) => {
			const {
				limit,
				offset,
				removedTracker,
				candidateTracker,
				includeClientInfo,
			} = input;

			const escapeLikeValue = (value: string) =>
				value.replace(/[\\%_]/g, "\\$&");
			const buildLikePattern = (value: string) =>
				`%"${escapeLikeValue(value)}"%`;

			let query = db("conflict_removals");

			if (removedTracker) {
				query = query.whereRaw("removed_trackers like ? escape '\\'", [
					buildLikePattern(removedTracker),
				]);
			}

			if (candidateTracker) {
				query = query.whereRaw(
					"candidate_trackers like ? escape '\\'",
					[buildLikePattern(candidateTracker)],
				);
			}

			const [{ count }] = await query
				.clone()
				.count<{ count: string | number }>({ count: "*" });

			const rows = await query
				.clone()
				.select({
					id: "id",
					timestamp: "timestamp",
					searcheeName: "searchee_name",
					infoHash: "info_hash",
					removedTrackers: "removed_trackers",
					candidateTrackers: "candidate_trackers",
					appliedRulePriority: "applied_rule_priority",
					removedClientHost: "removed_client_host",
					injectedClientHost: "injected_client_host",
				})
				.orderBy("timestamp", "desc")
				.limit(limit)
				.offset(offset);

			const items = rows.map((row) => ({
				id: row.id,
				timestamp: new Date(row.timestamp).toISOString(),
				searcheeName: row.searcheeName,
				infoHash: row.infoHash,
				removedTrackers: parseTrackerList(row.removedTrackers),
				candidateTrackers: parseTrackerList(row.candidateTrackers),
				appliedRulePriority: row.appliedRulePriority,
				...(includeClientInfo && {
					removedClientHost: row.removedClientHost,
					injectedClientHost: row.injectedClientHost,
				}),
			}));

			return {
				total: Number(count),
				items,
			};
		}),
});
