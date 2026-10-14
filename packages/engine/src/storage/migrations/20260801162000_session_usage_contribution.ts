import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Add the minimal usage ledger before the transcript migration retires the
 * legacy message/part tables. Fresh databases receive this table from the
 * generated schema, so this migration intentionally has no runOnFreshSchema.
 */
export default {
  id: "20260801162000_session_usage_contribution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_usage_contribution\` (
          \`contribution_key\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`compatibility_message_id\` text,
          \`compatibility_message_time_created\` integer,
          \`canonical_message_id\` text,
          \`part_id\` text,
          \`event_seq\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`tokens_cache_write\` integer NOT NULL,
          CONSTRAINT \`fk_session_usage_contribution_session_id_session_id_fk\`
            FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_usage_contribution_part_idx\` ON \`session_usage_contribution\` (\`part_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_seq_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`event_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_compat_message_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`compatibility_message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_canonical_message_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`canonical_message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
