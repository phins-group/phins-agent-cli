import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722030810_rolling_work_context_epoch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_context_epoch\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`epoch\` integer NOT NULL,
          \`phase\` text NOT NULL,
          \`status\` text NOT NULL,
          \`baseline_message_count\` integer NOT NULL,
          \`baseline_prefix_hash\` text NOT NULL,
          \`checkpoint\` text NOT NULL,
          \`prefix_messages\` text NOT NULL,
          \`selected_provider\` text NOT NULL,
          \`selected_model\` text NOT NULL,
          \`route_decision_id\` text,
          \`prompt_prefix_hash\` text,
          \`input_target_tokens\` integer NOT NULL,
          \`rollover_reserve_tokens\` integer NOT NULL,
          \`rollover_reason\` text NOT NULL,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`cached_input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_closed\` integer,
          CONSTRAINT \`fk_work_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_context_epoch_session_epoch_idx\` ON \`work_context_epoch\` (\`session_id\`,\`epoch\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_context_epoch_session_status_idx\` ON \`work_context_epoch\` (\`session_id\`,\`status\`,\`epoch\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
