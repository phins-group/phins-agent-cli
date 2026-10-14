import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005143808_session_run_input_owner",
  // The earlier run-state migration rebuilds this projection on fresh installs.
  runOnFreshSchema: true,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_run_state\` ADD \`input_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
