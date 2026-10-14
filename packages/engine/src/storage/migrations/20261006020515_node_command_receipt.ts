import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006020515_node_command_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`node_command_receipt\` (
          \`id\` text PRIMARY KEY,
          \`binding_hash\` text NOT NULL,
          \`status\` text NOT NULL,
          \`result\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
