import path from "node:path"
import { Effect } from "effect"
import { Flock } from "../../shared/flock"

/**
 * Serializes publication of non-SQL snapshot roots with destructive retention
 * maintenance. Database roots are captured by maintenance in a short WAL read
 * transaction while this process-wide barrier remains held.
 */
export const withSnapshotRetentionBarrier = <A, E, R>(stateDirectory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect("snapshot-retention-maintenance", {
        dir: path.join(stateDirectory, "locks"),
      })
      return yield* effect
    }),
  )
