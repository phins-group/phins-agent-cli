import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731074831_verification-execution-attestation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`verification_receipt\` ADD \`attestation\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
