import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	const clientName = String(knex.client.config.client ?? "").toLowerCase();
	if (clientName.includes("sqlite")) {
		const columns = await knex.raw("PRAGMA table_info('indexer')");
		const columnRows =
			(columns as { rows?: { name: string }[] }).rows ?? [];
		const hasPrivacy = columnRows.some((row) => row.name === "privacy");
		if (!hasPrivacy) return;
		try {
			await knex.raw("ALTER TABLE indexer DROP COLUMN privacy");
		} catch {
			// Older SQLite versions do not support DROP COLUMN.
		}
		return;
	}
	const hasPrivacy = await knex.schema.hasColumn("indexer", "privacy");
	if (!hasPrivacy) return;
	await knex.schema.alterTable("indexer", (table) => {
		table.dropColumn("privacy");
	});
}

function down(): void {
	// no rollback
}

export default { name: "21-drop-indexer-privacy", up, down };
