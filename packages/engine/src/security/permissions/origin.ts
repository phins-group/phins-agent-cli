export * as PermissionOrigin from "./origin"

import { Permission } from "../../contracts/security/permission"
import { SessionID } from "../../contracts/session/id"
import { Context, Effect } from "effect"
import { Wildcard } from "../../shared/wildcard"

/** Internal ceiling supplied by a trusted command owner, never an HTTP payload. */
export interface Constraint {
  readonly sessionID: typeof SessionID.Type
  readonly rules: ReadonlyArray<Permission.Rule>
  /** Recheck identity, grant and attempt validity; uncertainty must return false. */
  readonly valid: Effect.Effect<boolean>
}

const Current = Context.Reference<ReadonlyArray<Constraint>>(
  "@phins/PermissionOrigin",
  { defaultValue: () => [] },
)

export const capture: Effect.Effect<ReadonlyArray<Constraint>> = Current

/** Restricts only this fiber and its children; nested scopes cannot widen rights. */
export function restrict<A, E, R>(
  constraint: Constraint,
  work: Effect.Effect<A, E, R>,
) {
  const snapshot = Object.freeze({
    sessionID: constraint.sessionID,
    rules: Object.freeze(
      constraint.rules.map((rule) => Object.freeze({ ...rule })),
    ),
    valid: constraint.valid,
  })
  return Effect.gen(function* () {
    const parent = yield* Current
    return yield* work.pipe(
      Effect.provideService(Current, Object.freeze([...parent, snapshot])),
    )
  })
}

/** Missing rules and `ask` are not grants. Approval cannot raise this ceiling. */
export const permits = Effect.fn("PermissionOrigin.permits")(function* (
  input: {
    readonly sessionID: typeof SessionID.Type
    readonly action: string
    readonly resources: ReadonlyArray<string>
  },
  constraints: ReadonlyArray<Constraint>,
) {
  for (const constraint of constraints) {
    if (
      constraint.sessionID !== input.sessionID ||
      input.resources.length === 0
    )
      return false
    for (const resource of input.resources) {
      const rule = constraint.rules.findLast(
        (rule) =>
          Wildcard.match(input.action, rule.action) &&
          Wildcard.match(resource, rule.resource),
      )
      if (rule?.effect !== "allow") return false
    }
  }
  for (const constraint of constraints)
    if (!(yield* constraint.valid)) return false
  return true
})
