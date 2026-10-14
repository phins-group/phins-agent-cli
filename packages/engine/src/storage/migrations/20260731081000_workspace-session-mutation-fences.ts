import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731081000_workspace-session-mutation-fences",
  runOnFreshSchema: true,
  up(tx) {
    return Effect.gen(function* () {
      // workspace_id is an opaque ownership ID in dedicated processes: the
      // authoritative Workspace row can live in a different SQLite database.
      // These guards therefore fence local mutations/removal only; they must
      // not impose a same-database foreign-key invariant.
      yield* tx.run(`
        CREATE TRIGGER session_workspace_insert_guard
        BEFORE INSERT ON session
        WHEN NEW.workspace_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'workspace removal in progress')
          WHERE EXISTS (
            SELECT 1
            FROM workspace_mutation_lease
            WHERE resource_key = 'workspace:' || NEW.workspace_id
              AND operation = 'workspace-remove'
              AND (
                lease_token IS NULL
                OR lease_expires_at IS NULL
                OR lease_expires_at >
                  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              )
          );
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER session_workspace_update_guard
        BEFORE UPDATE OF workspace_id ON session
        BEGIN
          SELECT RAISE(ABORT, 'workspace removal in progress')
          WHERE EXISTS (
            SELECT 1
            FROM workspace_mutation_lease
            WHERE operation = 'workspace-remove'
              AND (
                lease_token IS NULL
                OR lease_expires_at IS NULL
                OR lease_expires_at >
                  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              )
              AND (
                resource_key = 'workspace:' || OLD.workspace_id
                OR resource_key = 'workspace:' || NEW.workspace_id
              )
          );
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER workspace_session_delete_guard
        BEFORE DELETE ON workspace
        BEGIN
          SELECT RAISE(ABORT, 'workspace has attached sessions')
          WHERE EXISTS (
            SELECT 1 FROM session WHERE workspace_id = OLD.id
          );
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
