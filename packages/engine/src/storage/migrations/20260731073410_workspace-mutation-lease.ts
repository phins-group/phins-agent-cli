import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731073410_workspace-mutation-lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace_mutation_lease\` (
          \`resource_key\` text PRIMARY KEY,
          \`resource_kind\` text NOT NULL,
          \`resource_id\` text NOT NULL,
          \`operation\` text,
          \`lease_token\` text,
          \`lease_generation\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`workspace_mutation_lease_expiry_idx\` ON \`workspace_mutation_lease\` (\`lease_expires_at\`,\`resource_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workspace_mutation_lease_resource_idx\` ON \`workspace_mutation_lease\` (\`resource_kind\`,\`resource_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
