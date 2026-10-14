import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731023300_event_owner_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`event_sequence\` ADD \`owner_generation\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
