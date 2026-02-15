import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	await knex.schema.createTable("conflict_rules", (table) => {
		table.increments("id").primary();
		table.integer("priority").notNullable();
		table.boolean("all_indexers").notNullable().defaultTo(false);
		table.json("trackers").notNullable();
		table.integer("created_at");
		table.integer("updated_at");
		table.unique(["priority"]);
	});
}

async function down(knex: Knex.Knex): Promise<void> {
	await knex.schema.dropTable("conflict_rules");
}

export default { name: "23-conflict-rules", up, down };
