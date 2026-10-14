import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729010558_verification_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`verification_location_state\` (
          \`location_key\` text PRIMARY KEY,
          \`mutation_epoch\` integer NOT NULL,
          \`snapshot\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`verification_receipt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text,
          \`location_key\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`mutation_epoch\` integer NOT NULL,
          \`subject_snapshot\` text,
          \`verifier\` text,
          \`verdict\` text,
          \`checks\` text NOT NULL,
          \`reason\` text,
          \`time_requested\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_verification_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_verification_receipt_location_key_verification_location_state_location_key_fk\` FOREIGN KEY (\`location_key\`) REFERENCES \`verification_location_state\`(\`location_key\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_session_time_idx\` ON \`verification_receipt\` (\`session_id\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_location_epoch_idx\` ON \`verification_receipt\` (\`location_key\`,\`mutation_epoch\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
