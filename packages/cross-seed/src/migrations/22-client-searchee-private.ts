import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	await knex.schema.alterTable("client_searchee", (table) => {
		table.boolean("private");
	});
}

function down(): void {
	// no rollback
}

export default { name: "22-client-searchee-private", up, down };
