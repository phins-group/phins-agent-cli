import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { SessionProjector } from "../src/sessions/projector"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionProjector readiness", () => {
  it.effect("waits for projector registration before exposing readiness", () =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>()
      const continueRegistration = yield* Deferred.make<void>()
      let first = true
      const project: EventBus.Interface["project"] = () =>
        Effect.gen(function* () {
          if (!first) return
          first = false
          yield* Deferred.succeed(registrationStarted, undefined)
          yield* Deferred.await(continueRegistration)
        })
      const events = Layer.mock(EventBus.Service, { project })
      const projector = SessionProjector.layer.pipe(
        Layer.provide(events),
        Layer.provide(Database.defaultLayer),
      )

      const building = yield* Layer.build(projector).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(registrationStarted)
      expect(building.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(continueRegistration, undefined)
      const context = yield* Fiber.join(building)
      expect(Context.get(context, SessionProjector.Readiness)).toEqual({ ready: true })
    }),
  )
})
