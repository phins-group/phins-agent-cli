export * as ToolAdmission from "./admission"

import { Effect, Semaphore } from "effect"

/** One gate per active turn. Cross-session file safety stays in path locks. */
export function make() {
  const permits = 64
  const gate = Semaphore.makeUnsafe(permits)
  return <A, E, R>(work: Effect.Effect<A, E, R>, parallel = false, signal?: AbortSignal): Effect.Effect<A, E, R> => {
    const count = parallel ? 1 : permits
    let started = false
    const aborted = Effect.callback<never>((resume) => {
      if (!signal) return
      const cancel = () => {
        if (!started) resume(Effect.interrupt)
      }
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      return Effect.sync(() => signal.removeEventListener("abort", cancel))
    })
    const running = gate.withPermits(count)(
      Effect.suspend(() => {
        started = true
        return signal?.aborted ? Effect.interrupt : work
      }),
    )
    return signal ? Effect.raceFirst(running, aborted) : running
  }
}
