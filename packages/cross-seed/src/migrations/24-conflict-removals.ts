import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	await knex.schema.createTable("conflict_removals", (table) => {
		table.increments("id").primary();
		table.integer("timestamp").notNullable();
		table.string("searchee_name").notNullable();
		table.string("info_hash").notNullable();
		table.json("removed_trackers").notNullable();
		table.json("candidate_trackers").notNullable();
		table.integer("applied_rule_priority").notNullable();
		table.string("removed_client_host").nullable();
		table.string("injected_client_host").nullable();
		table.index("timestamp");
		table.index("searchee_name");
		table.index("info_hash");
	});
}

async function down(knex: Knex.Knex): Promise<void> {
	await knex.schema.dropTable("conflict_removals");
}

export default { name: "24-conflict-removals", up, down };
