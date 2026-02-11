import knex from "knex";

export async function up(knex: knex.Knex): Promise<void> {
	await knex.schema.renameTable("candidates", "collisions");
}

export async function down(knex: knex.Knex): Promise<void> {
	await knex.schema.renameTable("collisions", "candidates");
}

export default { name: "19-collisions", up, down };
