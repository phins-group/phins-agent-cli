import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { ToolAdmission } from "../src/tools/admission"

test("parallel readers overlap and unknown mutations wait", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const admit = ToolAdmission.make()
        const release = yield* Deferred.make<void>()
        const both = yield* Deferred.make<void>()
        let readers = 0
        let wrote = false
        const read = Effect.gen(function* () {
          if (++readers === 2) yield* Deferred.succeed(both, undefined)
          yield* Deferred.await(release)
          readers--
        })
        const a = yield* Effect.forkScoped(admit(read, true))
        const b = yield* Effect.forkScoped(admit(read, true))
        yield* Deferred.await(both)
        const write = yield* Effect.forkScoped(
          admit(
            Effect.sync(() => {
              expect(readers).toBe(0)
              wrote = true
            }),
          ),
        )
        yield* Effect.yieldNow
        expect(wrote).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(a)
        yield* Fiber.join(b)
        yield* Fiber.join(write)
        expect(wrote).toBe(true)
      }),
    ),
  ))

test("cancelled queued mutation never runs and does not leak permits", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const admit = ToolAdmission.make()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const active = yield* Effect.forkScoped(
          admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        )
        yield* Deferred.await(entered)
        const controller = new AbortController()
        let calls = 0
        const queued = yield* Effect.forkScoped(
          admit(
            Effect.sync(() => {
              calls++
            }),
            false,
            controller.signal,
          ),
        )
        controller.abort()
        yield* Fiber.await(queued)
        expect(calls).toBe(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(active)
        yield* admit(
          Effect.sync(() => {
            calls++
          }),
        )
        expect(calls).toBe(1)
      }),
    ),
  ))
