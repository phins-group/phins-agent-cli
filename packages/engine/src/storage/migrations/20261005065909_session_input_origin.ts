import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005065909_session_input_origin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_input_origin\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`command_id\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`origin\` text NOT NULL,
          CONSTRAINT \`fk_session_input_origin_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_input_origin_session_idx\` ON \`session_input_origin\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_origin_node_command_idx\` ON \`session_input_origin\` (\`node_id\`,\`command_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
