/** A local parent's policy ceiling; unlike a remote origin, asks remain asks. */
import { Context, Effect } from "effect"
import type { Permission } from "../../contracts/security/permission"
import type { Session as SessionSchema } from "../../contracts/session/info"

export interface Ceiling {
  readonly sessionID: SessionSchema.ID
  readonly rules: ReadonlyArray<Permission.Rule>
  readonly valid: Effect.Effect<boolean>
}
export const Current = Context.Reference<Ceiling | undefined>(
  "@phins/DelegationPermissionCeiling",
  { defaultValue: () => undefined },
)

export function restrict<A, E, R>(
  ceiling: Ceiling,
  work: Effect.Effect<A, E, R>,
) {
  const snapshot = Object.freeze({
    ...ceiling,
    rules: Object.freeze(
      ceiling.rules.map((rule) => Object.freeze({ ...rule })),
    ),
  })
  return Effect.gen(function* () {
    // Foreground subtasks deliberately cannot nest or replace an inherited
    // ceiling. This service never represents platform authorization.
    if (yield* Current) return yield* Effect.interrupt
    return yield* work.pipe(Effect.provideService(Current, snapshot))
  })
}
