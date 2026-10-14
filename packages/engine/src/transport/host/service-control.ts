/** Owns admission and drain completion for the registered standalone host. @module */
import { ConflictError, ServiceUnavailableError } from "../api/errors"
import { ServiceStatus } from "../api/resources/service"
import { Context, Deferred, Effect, Layer, Scope } from "effect"

export interface Interface {
  readonly status: Effect.Effect<typeof ServiceStatus.Type>
  readonly shutdown: (
    id: string,
    drain: Effect.Effect<void>,
  ) => Effect.Effect<void, ConflictError | ServiceUnavailableError>
  readonly withRequest: <A, E, R>(
    method: string,
    pathname: string,
    effect: Effect.Effect<A, E, R>,
    generation?: string,
    remote?: { sessionID: string; action: string },
  ) => Effect.Effect<A, E | ConflictError | ServiceUnavailableError, R>
  readonly awaitShutdown: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/LocalServiceControl",
) {}

// Replies and targeted interrupts must remain available to settle existing work.
function settlesWork(method: string, pathname: string) {
  if (method !== "POST") return false
  return (
    pathname === "/api/service/shutdown" ||
    pathname === "/native/node/settlement" ||
    pathname === "/api/node/account" ||
    /^\/api\/session\/[^/]+\/(?:interrupt|wait)$/.test(pathname) ||
    /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(pathname) ||
    /^\/api\/session\/[^/]+\/question\/[^/]+\/(?:reply|reject)$/.test(pathname)
  )
}

export type RemoteAdmission = <A, E, R>(
  target: { sessionID: string; action: string },
  work: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | ConflictError, R>

export const make = (id?: string, admitRemote?: RemoteAdmission) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const stopped = yield* Deferred.make<void>()
    let draining = false
    let shutdownPending = false
    let shutdownComplete = false
    let writes = 0
    let quiet = Deferred.makeUnsafe<void>()
    const awaitRequests = Effect.suspend(() =>
      writes === 0 ? Effect.void : Deferred.await(quiet),
    )

    const shutdown = Effect.fn("LocalServiceControl.shutdown")(function* (
      expected: string,
      drain: Effect.Effect<void>,
    ) {
      if (id === undefined)
        return yield* new ServiceUnavailableError({
          service: "local-daemon",
          message: "This host is not a registered local daemon",
        })
      if (id !== expected)
        return yield* new ConflictError({
          resource: "local-daemon",
          message:
            "The daemon generation has changed; rediscover it before requesting shutdown",
        })
      if (shutdownPending || shutdownComplete) return
      draining = true
      shutdownPending = true
      yield* awaitRequests.pipe(
        Effect.andThen(drain),
        Effect.andThen(awaitRequests),
        Effect.andThen(Effect.sync(() => { shutdownComplete = true })),
        Effect.andThen(Deferred.succeed(stopped, undefined)),
        Effect.catchCause((cause) =>
          Effect.logError(
            "Service drain failed; admission remains closed. Retry shutdown after resolving the failure.",
            cause,
          ),
        ),
        Effect.ensuring(Effect.sync(() => { shutdownPending = false })),
        Effect.forkIn(scope),
      )
    }, Effect.uninterruptible)

    const withRequest: Interface["withRequest"] = (
      method,
      pathname,
      effect,
      generation,
      remote,
    ) => {
      if (generation !== undefined && generation !== id)
        return Effect.fail(
          new ConflictError({
            resource: "local-daemon",
            message:
              "The service generation has changed; rediscover before sending commands",
          }),
        )
      if (id === undefined || method === "GET" || method === "HEAD")
        return effect
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (draining && !settlesWork(method, pathname))
            return yield* new ServiceUnavailableError({
              service: "local-daemon",
              message:
                "Service is draining. Wait for shutdown before starting new work",
            })
          if (writes === 0) quiet = Deferred.makeUnsafe<void>()
          writes++
        }),
        () => remote && admitRemote ? admitRemote(remote, effect) : effect,
        () =>
          Effect.suspend(() => {
            writes--
            return writes === 0
              ? Deferred.succeed(quiet, undefined).pipe(Effect.asVoid)
              : Effect.void
          }),
      )
    }

    return Service.of({
      status: Effect.sync(() =>
        id === undefined
          ? { mode: "unmanaged" }
          : { mode: "managed", id, state: draining ? "draining" : "running" },
      ),
      shutdown,
      withRequest,
      awaitShutdown: Deferred.await(stopped),
    })
  })

export const unmanagedLayer = Layer.effect(Service, make())
export * as ServiceControl from "./service-control"
