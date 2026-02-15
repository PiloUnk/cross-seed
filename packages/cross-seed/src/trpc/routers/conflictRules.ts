import { z } from "zod";
import { authedProcedure, router } from "../index.js";
import { db } from "../../db.js";

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

function parseTrackersJson(value: unknown): string[] {
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

async function getIndexerTrackers(): Promise<string[]> {
	const rows: { trackers: string | null }[] =
		await db("indexer").select("trackers");
	const trackerSet = new Set<string>();
	for (const row of rows) {
		for (const tracker of parseTrackerList(row.trackers)) {
			trackerSet.add(tracker);
		}
	}
	return Array.from(trackerSet).sort();
}

export const conflictRulesRouter = router({
	getRules: authedProcedure.query(async () => {
		const rows: {
			id: number;
			priority: number;
			all_indexers: number | boolean | null;
			trackers: string | null;
		}[] = await db("conflict_rules")
			.select("id", "priority", "all_indexers", "trackers")
			.orderBy("priority", "asc");
		const rules = rows.map((row) => ({
			id: row.id,
			priority: row.priority,
			allIndexers: Boolean(row.all_indexers),
			trackers: parseTrackersJson(row.trackers),
		}));
		return { rules };
	}),

	saveRules: authedProcedure
		.input(
			z.object({
				rules: z
					.array(
						z.object({
							allIndexers: z.boolean(),
							trackers: z.array(z.string()).default([]),
						}),
					)
					.default([]),
			}),
		)
		.mutation(async ({ input }) => {
			const now = Date.now();
			await db.transaction(async (trx) => {
				await trx("conflict_rules").del();
				if (!input.rules.length) return;
				const payload = input.rules.map((rule, index) => ({
					priority: index + 1,
					all_indexers: rule.allIndexers,
					trackers: JSON.stringify(normalizeTrackers(rule.trackers)),
					created_at: now,
					updated_at: now,
				}));
				await trx("conflict_rules").insert(payload);
			});
			return { success: true };
		}),

	getTrackerOptions: authedProcedure.query(async () => {
		const trackers = await getIndexerTrackers();
		return { trackers };
	}),

	getThirdPartyTrackers: authedProcedure
		.input(
			z
				.object({
					includePublic: z.boolean().optional().default(false),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			const knownTrackers = new Set(await getIndexerTrackers());
			const includePublic = input?.includePublic ?? false;
			let query = db("client_searchee").whereNotNull("trackers");
			if (!includePublic) {
				query = query.where("private", 1);
			}
			const rows: { trackers: string | null }[] =
				await query.select("trackers");
			const unregistered = new Set<string>();
			for (const row of rows) {
				for (const tracker of parseTrackerList(row.trackers)) {
					if (!knownTrackers.has(tracker)) {
						unregistered.add(tracker);
					}
				}
			}
			return { trackers: Array.from(unregistered).sort() };
		}),
});
