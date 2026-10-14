import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731031224_session_warp_outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_warp_outbox\` (
          \`delivery_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`transfer_seq\` integer NOT NULL,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_attempt_at\` integer NOT NULL,
          \`lease_token\` text,
          \`lease_expires_at\` integer,
          \`last_error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_warp_outbox_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`),
          CONSTRAINT \`fk_session_warp_outbox_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`)
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_warp_outbox_event_role_idx\` ON \`session_warp_outbox\` (\`event_id\`,\`role\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_warp_outbox_due_idx\` ON \`session_warp_outbox\` (\`next_attempt_at\`,\`delivery_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_warp_outbox_session_seq_idx\` ON \`session_warp_outbox\` (\`session_id\`,\`transfer_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
