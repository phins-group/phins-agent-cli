import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009151628_session_command_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_command_receipt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`signature\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_command_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_command_receipt_session\` ON \`session_command_receipt\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
