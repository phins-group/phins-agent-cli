import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731022945_verification_attempt_timeout",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`verification_receipt\` ADD \`attempt_timeout_ms\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
