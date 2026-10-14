export * as SessionRunCoordinator from "./coordinator"

import { Deferred, Effect, Fiber, Scope } from "effect"
import { SessionRunLifecycle } from "./lifecycle"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Acknowledges scheduling without waiting or forcing an active run's successor. */
  readonly schedule: (key: Key) => Effect.Effect<void>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Runs idle-only work in the service scope, using the same owner as the agent loop. */
  readonly exclusive: (
    key: Key,
    work: Effect.Effect<void, E>,
    source?: "local" | "remote",
    lifetime?: "service" | "caller",
    onUserStop?: () => void,
  ) => Effect.Effect<void, E | SessionRunLifecycle.RunBusy>
  /** Observes this key's current owner and cleanup without starting execution. */
  readonly wait: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key, options?: { readonly requested: true }) => Effect.Effect<void>
  /** Capture an owner before asynchronous authorization; stale handles fail closed. */
  readonly captureInterrupt: (
    key: Key,
  ) => Effect.Effect<Effect.Effect<boolean> | undefined>
  /** Local execution only, including shell/skill work before projection. */
  readonly captureLocalInterrupt: (
    key: Key,
    options?: { readonly includeScheduled: boolean },
  ) => Effect.Effect<Effect.Effect<boolean> | undefined>
  /** Checks only the captured live owner; never starts a successor. */
  readonly captureOwner: (
    key: Key,
  ) => Effect.Effect<Effect.Effect<boolean> | undefined>
  /** Waits for all current owners, queued wakeups and cleanup to become idle. */
  readonly awaitIdle: Effect.Effect<void>
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  readonly onStop?: (key: Key) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const active = new Map<Key, SessionRunLifecycle.Runner<void, E>>()
    const completion = new Map<Key, Deferred.Deferred<void>>()
    let idle = Deferred.makeUnsafe<void>()
    const runner = (key: Key) => {
      const existing = active.get(key)
      if (existing) return existing
      if (active.size === 0) idle = Deferred.makeUnsafe<void>()
      const done = Deferred.makeUnsafe<void>()
      completion.set(key, done)
      const next = SessionRunLifecycle.createRunLifecycle<void, E>(scope, {
        onIdle: Effect.suspend(() => {
          if (active.get(key) === next) {
            active.delete(key)
            completion.delete(key)
          }
          return Deferred.succeed(done, undefined).pipe(
            Effect.andThen(
              active.size === 0
                ? Deferred.succeed(idle, undefined)
                : Effect.void,
            ),
            Effect.asVoid,
          )
        }),
        onInterrupt: Effect.interrupt,
        onStop: Effect.suspend(() => options.onStop?.(key) ?? Effect.void),
      })
      active.set(key, next)
      return next
    }
    const captureInterrupt = (
      key: Key, localOnly = false, includeScheduled = true,
    ) =>
      Effect.sync(() => {
        const owner = active.get(key)
        if (!owner) return undefined
        const state = owner.state
        const scheduled = (
          done: Parameters<typeof owner.cancelScheduled>[0],
        ) => Effect.suspend(() =>
          active.get(key) === owner
            ? owner.cancelScheduled(done)
            : Effect.succeed(false),
        )
        if (localOnly && state._tag === "Stopping") {
          if (!includeScheduled) return undefined
          const pending = state.pending && scheduled(state.pending.done)
          return state.source === "local"
            ? (pending ?? Effect.void).pipe(
                Effect.andThen(Deferred.await(state.stopped)), Effect.as(true),
              )
            : pending
        }
        if (
          localOnly &&
          (state._tag === "Shell" || state._tag === "ShellThenRun") &&
          state.shell.source === "remote"
        ) return includeScheduled && state._tag === "ShellThenRun"
          ? scheduled(state.run.done)
          : undefined
        const id = state._tag === "Running"
          ? state.run.id
          : state._tag === "Shell" || state._tag === "ShellThenRun"
            ? state.shell.id
            : undefined
        if (id === undefined) return undefined
        return Effect.suspend(() =>
          active.get(key) === owner
            ? owner.cancelOwner(id)
            : Effect.succeed(false),
        )
      })
    return {
      run: (key) =>
        Effect.suspend(() =>
          runner(key).ensureRunning(
            Effect.suspend(() => options.drain(key, true)),
          ),
        ),
      schedule: (key) =>
        Effect.suspend(() =>
          runner(key).schedule(Effect.suspend(() => options.drain(key, true))),
        ),
      wake: (key) =>
        Effect.suspend(() =>
          runner(key).wake(Effect.suspend(() => options.drain(key, false))),
        ),
      exclusive: (key, work, source = "local", lifetime = "service", onUserStop) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const owner = runner(key)
            return owner.startShell(work, undefined, source, onUserStop).pipe(
              // The service owns this task, but closing its scope must still
              // cancel the task and its child work. Only registration is masked.
              Effect.interruptible,
              // Publish lifecycle ownership before another client can interrupt.
              Effect.forkIn(scope, { startImmediately: true }),
              Effect.flatMap((fiber) => restore(Fiber.join(fiber)).pipe(
                Effect.onInterrupt(() => lifetime === "caller"
                  ? Fiber.interrupt(fiber) : Effect.void),
              )),
            )
          }),
        ),
      wait: (key) =>
        Effect.suspend(() => {
          const done = completion.get(key)
          return done ? Deferred.await(done) : Effect.void
        }),
      interrupt: (key, input) => Effect.suspend(() => {
        const owner = active.get(key)
        return owner
          ? input?.requested ? owner.requestStop : owner.cancel
          : options.onStop?.(key) ?? Effect.void
      }),
      captureInterrupt: (key) => captureInterrupt(key),
      captureLocalInterrupt: (key, options) =>
        captureInterrupt(key, true, options?.includeScheduled ?? true),
      captureOwner: (key) =>
        Effect.sync(() => {
          const owner = active.get(key)
          if (!owner) return undefined
          const state = owner.state
          const id =
            state._tag === "Running"
              ? state.run.id
              : state._tag === "Shell" || state._tag === "ShellThenRun"
                ? state.shell.id
                : undefined
          if (id === undefined) return undefined
          return Effect.sync(() => {
            if (active.get(key) !== owner) return false
            const current = owner.state
            return current._tag === "Running"
              ? current.run.id === id
              : (current._tag === "Shell" || current._tag === "ShellThenRun") &&
                  current.shell.id === id
          })
        }),
      awaitIdle: Effect.suspend(() =>
        active.size === 0 ? Effect.void : Deferred.await(idle),
      ),
    }
  })
