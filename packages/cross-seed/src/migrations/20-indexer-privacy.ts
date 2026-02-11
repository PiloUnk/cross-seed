import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	await knex.schema.alterTable("indexer", (table) => {
		table.string("privacy");
	});
}

function down(): void {
	// no rollback
}

export default { name: "20-indexer-privacy", up, down };
