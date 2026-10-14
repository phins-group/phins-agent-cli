import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** Starts or joins service-owned work without waiting for its result. */
  readonly schedule: (work: Effect.Effect<A, E>) => Effect.Effect<void>
  readonly wake: (work: Effect.Effect<A, E>) => Effect.Effect<void>
  readonly startShell: (
    work: Effect.Effect<A, E>, ready?: Latch.Latch,
    source?: "local" | "remote",
    onUserStop?: () => void,
  ) => Effect.Effect<A, E | RunBusy>
  readonly cancel: Effect.Effect<void>
  /** An explicit local Stop, distinct from shutdown or lost execution authority. */
  readonly requestStop: Effect.Effect<void>
  /** Cancel only the captured execution handle, never its successor. */
  readonly cancelOwner: (id: number, requested?: boolean) => Effect.Effect<boolean>
  /** Cancel captured scheduled work, even if it has since become the runner. */
  readonly cancelScheduled: (
    done: Deferred.Deferred<A, E | RunCancelled>,
  ) => Effect.Effect<boolean>
}

export class RunCancelled extends Schema.TaggedErrorClass<RunCancelled>()("RunnerCancelled", {}) {}
export class RunBusy extends Schema.TaggedErrorClass<RunBusy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | RunCancelled>
  ready: Deferred.Deferred<void>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  source: "local" | "remote"
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
  onUserStop?: () => void
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | RunCancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E>; readonly wake?: Effect.Effect<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }
  | { readonly _tag: "Stopping"; readonly id: number; readonly source: "local" | "remote"; readonly stopped: Deferred.Deferred<void>; readonly pending?: PendingHandle<A, E> }

export const createRunLifecycle = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
    onStop?: Effect.Effect<void>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | RunCancelled>, exit: Exit.Exit<A, E>, release = Effect.void) =>
    settle(done,
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Exit.fail(new RunCancelled()) : exit,
      release,
    )

  const awaitDone = (done: Deferred.Deferred<A, E | RunCancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const finishRun = (id: number, done: Deferred.Deferred<A, E | RunCancelled>, exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Running" || st.run.id !== id) return [complete(done, exit), st] as const
        if (st.wake && !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))) {
          const joined = Exit.isSuccess(exit)
          const run = yield* startRun(
            Effect.yieldNow.pipe(Effect.andThen(st.wake)),
            joined ? done : Deferred.makeUnsafe<A, E | RunCancelled>(),
          )
          return [activate(run).pipe(Effect.andThen(joined ? Effect.void : complete(done, exit))), { _tag: "Running", run }] as const
        }
        return [complete(done, exit, idle), { _tag: "Idle" }] as const
      }),
    ).pipe(Effect.flatten)

  const startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | RunCancelled>): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const ready = Deferred.makeUnsafe<void>()
      const fiber = yield* Deferred.await(ready).pipe(
        Effect.andThen(work),
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return { id, done, ready, fiber } satisfies RunHandle<A, E>
    })

  // Publish ownership before executing user work, even for synchronous work.
  const activate = (run: RunHandle<A, E>) => Deferred.succeed(run.ready, undefined).pipe(Effect.asVoid)

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [activate(run), { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const registerRun = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Stopping": {
            const pending = st.pending ?? { id: next(), done: Deferred.makeUnsafe<A, E | RunCancelled>(), work }
            return [Effect.succeed(pending.done), { ...st, pending }] as const
          }
          case "Running":
          case "ShellThenRun":
            return [Effect.succeed(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | RunCancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [Effect.succeed(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | RunCancelled>()
            const run = yield* startRun(work, done)
            return [activate(run).pipe(Effect.as(done)), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten, Effect.uninterruptible)

  const ensureRunning = (work: Effect.Effect<A, E>) => registerRun(work).pipe(Effect.flatMap(awaitDone))
  const schedule = (work: Effect.Effect<A, E>) => registerRun(work).pipe(Effect.asVoid)

  const wake = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(ref, Effect.fnUntraced(function* (st) {
      switch (st._tag) {
        case "Running": return [Effect.void, { ...st, wake: work }] as const
        case "ShellThenRun": return [Effect.void, st] as const
        case "Stopping": return [Effect.void, {
          ...st,
          pending: st.pending ?? { id: next(), done: Deferred.makeUnsafe<A, E | RunCancelled>(), work },
        }] as const
        case "Shell": return [Effect.void, {
          _tag: "ShellThenRun" as const,
          shell: st.shell,
          run: { id: next(), done: Deferred.makeUnsafe<A, E | RunCancelled>(), work },
        }] as const
        case "Idle": {
          const run = yield* startRun(work, Deferred.makeUnsafe<A, E | RunCancelled>())
          return [activate(run), { _tag: "Running", run }] as const
        }
      }
    })).pipe(Effect.flatten)

  const startShell = (
    work: Effect.Effect<A, E>, ready?: Latch.Latch,
    source: "local" | "remote" = "local",
    onUserStop?: () => void,
  ): Effect.Effect<A, E | RunBusy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | RunBusy> = Effect.fail(new RunBusy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const activated = yield* Deferred.make<void>()
        const fiber = yield* Deferred.await(activated).pipe(
          Effect.andThen(work),
          Effect.ensuring(finishShell(id)),
          Effect.forkChild,
        )
        const shell = { id, source, cancelled, ready, fiber, onUserStop } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            // Publish the shell handle before any user work can observe it.
            yield* Deferred.succeed(activated, undefined)
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new RunCancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const finishStop = (id: number, stopped: Deferred.Deferred<void>) =>
    SynchronizedRef.modifyEffect(ref, Effect.fnUntraced(function* (st) {
      if (st._tag !== "Stopping" || st.id !== id) return [settle(stopped, Exit.void, Effect.void), st] as const
      if (st.pending) {
        const run = yield* startRun(st.pending.work, st.pending.done)
        return [settle(stopped, Exit.void, activate(run)), { _tag: "Running", run }] as const
      }
      return [settle(stopped, Exit.void, idle), { _tag: "Idle" }] as const
    })).pipe(Effect.flatten)

  // Keep ownership until cleanup finishes. New work is queued behind cleanup;
  // it cannot overlap an interrupted tool's finalizers or be erased by them.
  const cancelOwner = (expected?: number, requested = false) => SynchronizedRef.modify(ref, (st) => {
    const owner = st._tag === "Running" ? st.run.id
      : st._tag === "Shell" || st._tag === "ShellThenRun" ? st.shell.id : undefined
    if (expected !== undefined && owner !== expected) return [Effect.succeed(false), st] as const
    if (st._tag === "Idle") return [Effect.succeed(false), st] as const
    if (st._tag === "Stopping") return [Deferred.await(st.stopped).pipe(Effect.as(true)), st] as const
    // Mark only this exact live invocation, atomically with its Stop transition.
    // Duplicate/stale Stop and generic cleanup never authorize queue cancellation.
    if (requested && (st._tag === "Shell" || st._tag === "ShellThenRun"))
      st.shell.onUserStop?.()
    const id = next()
    const stopped = Deferred.makeUnsafe<void>()
    const stop = st._tag === "Running" ? Fiber.interrupt(st.run.fiber) : stopShell(st.shell)
    const pending = st._tag === "Running" || st._tag === "ShellThenRun"
      ? Deferred.fail(st.run.done, new RunCancelled()).pipe(Effect.asVoid)
      : Effect.void
    const source = st._tag === "Running" ? "local" : st.shell.source
    return [
      stop.pipe(
        Effect.ensuring(pending),
        Effect.ensuring(opts?.onStop ?? Effect.void),
        Effect.ensuring(finishStop(id, stopped)),
        Effect.as(true),
      ),
      { _tag: "Stopping", id, source, stopped } as const,
    ] as const
  }).pipe(Effect.flatten, Effect.uninterruptible)

  const cancelScheduled = (done: Deferred.Deferred<A, E | RunCancelled>) =>
    SynchronizedRef.modify(ref, (st) => {
      if (st._tag === "Running" && st.run.done === done)
        return [cancelOwner(st.run.id), st] as const
      if (st._tag === "ShellThenRun" && st.run.done === done)
        return [
          Deferred.fail(done, new RunCancelled()).pipe(Effect.as(true)),
          { _tag: "Shell", shell: st.shell } as const,
        ] as const
      if (st._tag === "Stopping" && st.pending?.done === done)
        return [
          Deferred.fail(done, new RunCancelled()).pipe(Effect.as(true)),
          { ...st, pending: undefined },
        ] as const
      return [Effect.succeed(false), st] as const
    }).pipe(Effect.flatten, Effect.uninterruptible)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    schedule,
    wake,
    startShell,
    cancel: cancelOwner().pipe(Effect.asVoid),
    requestStop: cancelOwner(undefined, true).pipe(Effect.asVoid),
    cancelOwner,
    cancelScheduled,
  }
}

/** A failed status publication must not strand callers or retain ownership. */
const settle = <A, E>(done: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>, release: Effect.Effect<void>) =>
  release.pipe(Effect.ensuring(Deferred.done(done, exit)), Effect.uninterruptible, Effect.asVoid)

export * as SessionRunLifecycle from "./lifecycle"
