import knex from "knex";

export async function up(knex: knex.Knex): Promise<void> {
	await knex.schema.createTable("candidates", (table) => {
		table
			.integer("decision_id")
			.primary()
			.references("decision.id")
			.onDelete("CASCADE");
		table.json("candidate_trackers");
		table.json("known_trackers");
		table.integer("updated_at");
	});
}

export async function down(knex: knex.Knex): Promise<void> {
	await knex.schema.dropTable("candidates");
}

export default { name: "17-candidates", up, down };
