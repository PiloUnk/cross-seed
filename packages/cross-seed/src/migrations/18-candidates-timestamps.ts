import knex from "knex";

export async function up(knex: knex.Knex): Promise<void> {
	await knex.schema.alterTable("candidates", (table) => {
		table.integer("first_seen");
		table.integer("last_seen");
	});

	await knex.raw(
		"UPDATE candidates SET first_seen = (SELECT first_seen FROM decision WHERE decision.id = candidates.decision_id) WHERE first_seen IS NULL",
	);
	await knex.raw(
		"UPDATE candidates SET last_seen = (SELECT last_seen FROM decision WHERE decision.id = candidates.decision_id) WHERE last_seen IS NULL",
	);
}

export async function down(knex: knex.Knex): Promise<void> {
	await knex.schema.alterTable("candidates", (table) => {
		table.dropColumn("first_seen");
		table.dropColumn("last_seen");
	});
}

export default { name: "18-candidates-timestamps", up, down };
