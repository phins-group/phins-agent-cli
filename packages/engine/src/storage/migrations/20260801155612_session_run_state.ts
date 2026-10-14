import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801155612_session_run_state",
  runOnFreshSchema: true,
  up(tx) {
    return Effect.gen(function* () {
      // Drizzle's SQLite full-schema renderer omits NOT NULL from inline text
      // primary keys even when the column builder declares it. Recreate this
      // new, empty projection on fresh installs so runtime and incremental
      // installs enforce the same fencing invariant.
      yield* tx.run(`DROP TABLE IF EXISTS \`session_run_state\`;`)
      yield* tx.run(`
        CREATE TABLE \`session_run_state\` (
          \`session_id\` text PRIMARY KEY NOT NULL,
          \`run_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`attempt\` integer,
          \`next_retry_at\` integer,
          \`error\` text,
          \`time_started\` integer NOT NULL,
          \`time_settled\` integer,
          CONSTRAINT \`fk_session_run_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_run_state_run_id_idx\` ON \`session_run_state\` (\`run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_run_state_retry_due_idx\` ON \`session_run_state\` (\`status\`,\`next_retry_at\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
