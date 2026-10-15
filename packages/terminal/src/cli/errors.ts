import { Effect, Runtime as EffectRuntime } from "effect"
import { writeSync } from "node:fs"

export function reportCommandFailure(cause: unknown, fallback: string) {
  const message = typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message : fallback
  // Preserve command output and avoid duplicate runtime stack traces.
  const error = Object.assign(
    new Error(message, { cause }),
    { [EffectRuntime.errorReported]: false },
  )
  return Effect.sync(() => {
    if (process.platform === "win32") writeSync(2, error.message + "\n")
    else process.stderr.write(error.message + "\n")
  }).pipe(
    Effect.andThen(Effect.fail(error)),
  )
}
