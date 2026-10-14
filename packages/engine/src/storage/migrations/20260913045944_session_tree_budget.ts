import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913045944_session_tree_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tree_budget\` (
          \`session_id\` text PRIMARY KEY,
          \`token_limit\` integer NOT NULL,
          \`cost_limit_micros\` integer NOT NULL,
          \`reserved_tokens\` integer DEFAULT 0 NOT NULL,
          \`reserved_cost_micros\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_tree_budget_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
