import path from "path"
import { Context, Effect, Function, Layer, Schema } from "effect"
import type { Scope } from "effect"
import { AppPaths } from "../runtime/paths"
import { ServiceGraph } from "../runtime/effect/service-graph"
import { Flock } from "./flock"

export namespace EffectFlock {
  export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>()("LockTimeoutError", {
    key: Schema.String,
  }) {}

  export class LockCompromisedError extends Schema.TaggedErrorClass<LockCompromisedError>()("LockCompromisedError", {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return this.detail
    }
  }

  export type LockError = LockTimeoutError | LockCompromisedError

  export interface Interface {
    readonly acquire: (key: string, dir?: string) => Effect.Effect<void, LockError, Scope.Scope>
    readonly withLock: {
      (key: string, dir?: string): <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockError, R>
      <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R>
    }
  }

  export class Service extends Context.Service<Service, Interface>()("EffectFlock") {}

  function detail(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function acquireError(key: string, cause: unknown): Effect.Effect<never, LockError> {
    const message = detail(cause)
    if (message.startsWith("Timed out waiting for lock:")) {
      return Effect.fail(new LockTimeoutError({ key }))
    }

    if (message.includes("compromised") || message.includes("owner token") || message.includes("non-file claim")) {
      return Effect.fail(new LockCompromisedError({ detail: message, cause }))
    }

    return Effect.die(cause)
  }

  export const layer: Layer.Layer<Service, never, AppPaths.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* AppPaths.Service
      const lockRoot = path.join(global.state, "locks")

      const acquireLease = (key: string, dir?: string): Effect.Effect<Flock.Lease, LockError> =>
        Effect.tryPromise({
          try: (signal) =>
            Flock.acquire(key, {
              dir: dir ?? lockRoot,
              signal,
            }),
          catch: (cause) => ({ cause }),
        }).pipe(Effect.catch(({ cause }) => acquireError(key, cause)))

      const acquire = Effect.fn("EffectFlock.acquire")(function* (key: string, dir?: string) {
        yield* Effect.acquireRelease(acquireLease(key, dir), (lease) =>
          Effect.tryPromise({
            try: () => lease.release(),
            catch: (cause) => ({ cause }),
          }).pipe(Effect.catch(({ cause }) => Effect.die(cause))),
        )
      })

      const withLock: Interface["withLock"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* acquire(key, dir)
              return yield* body
            }),
          ),
      )

      return Service.of({ acquire, withLock })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppPaths.layer))
  export const node = ServiceGraph.node(layer, [AppPaths.node])
}
