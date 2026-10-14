import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729040943_verification_request_outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`verification_request_outbox\` (
          \`receipt_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text,
          \`location_key\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`mutation_epoch\` integer NOT NULL,
          \`subject_snapshot\` text,
          \`verifier\` text,
          \`time_requested\` integer NOT NULL,
          CONSTRAINT \`fk_verification_request_outbox_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_verification_request_outbox_location_key_verification_location_state_location_key_fk\` FOREIGN KEY (\`location_key\`) REFERENCES \`verification_location_state\`(\`location_key\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_pending_time_idx\` ON \`verification_receipt\` (\`verdict\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`verification_request_outbox_event_idx\` ON \`verification_request_outbox\` (\`event_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_request_outbox_session_time_idx\` ON \`verification_request_outbox\` (\`session_id\`,\`time_requested\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
