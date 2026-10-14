import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731015112_verification_attempt_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`verification_receipt\` ADD \`attempt_generation\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`verification_receipt\` ADD \`attempt_token\` text;`)
      yield* tx.run(`ALTER TABLE \`verification_receipt\` ADD \`attempt_lease_expires\` integer;`)
      yield* tx.run(
        `CREATE INDEX \`verification_request_outbox_time_session_idx\` ON \`verification_request_outbox\` (\`time_requested\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
