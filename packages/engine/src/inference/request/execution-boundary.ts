export * as ExecutionBoundary from "./execution-boundary"

import { Context, Effect } from "effect"
import type { LLMRequest } from "../schema"

/** Consumer-owned checks, independent of sessions, grants and providers. */
export interface Boundary {
  /** Runs after request defaults are resolved, before lowering or signing. */
  readonly request: (request: LLMRequest) => Effect.Effect<void>
  /** Runs immediately before each transport acquisition or send. */
  readonly attempt: Effect.Effect<void>
}

const Current = Context.Reference<ReadonlyArray<Boundary>>(
  "@phins/LLM/ExecutionBoundary",
  { defaultValue: () => [] },
)

/** Fiber-local and inherited by children; nested checks never replace parents. */
export function restrict<A, E, R>(
  boundary: Boundary,
  work: Effect.Effect<A, E, R>,
) {
  const snapshot = Object.freeze({ ...boundary })
  return Effect.gen(function* () {
    const parents = yield* Current
    return yield* work.pipe(
      Effect.provideService(Current, Object.freeze([...parents, snapshot])),
    )
  })
}

export const request = Effect.fn("ExecutionBoundary.request")(function* (
  request: LLMRequest,
) {
  for (const boundary of yield* Current) yield* boundary.request(request)
})

export const attempt = Effect.gen(function* () {
  for (const boundary of yield* Current) yield* boundary.attempt
})
