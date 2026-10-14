import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { SessionRunCoordinator } from "../src/sessions/run/coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator", () => {
  it.effect("only explicit Stop marks the current remote invocation", () => Effect.gen(function* () {
    const coordinator = yield* SessionRunCoordinator.make<string, never>({ drain: () => Effect.void })
    let firstMarked = 0, nextMarked = 0
    const firstStarted = yield* Deferred.make<void>()
    const first = yield* coordinator.exclusive("session", Deferred.succeed(firstStarted, undefined)
      .pipe(Effect.andThen(Effect.never)), "remote", "service", () => { firstMarked++ })
      .pipe(Effect.forkChild)
    yield* Deferred.await(firstStarted)
    const stale = yield* coordinator.captureInterrupt("session")
    yield* coordinator.interrupt("session")
    expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
    const nextStarted = yield* Deferred.make<void>()
    const next = yield* coordinator.exclusive("session", Deferred.succeed(nextStarted, undefined)
      .pipe(Effect.andThen(Effect.never)), "remote", "service", () => { nextMarked++ })
      .pipe(Effect.forkChild)
    yield* Deferred.await(nextStarted)
    expect(yield* stale!).toBe(false)
    expect([firstMarked, nextMarked]).toEqual([0, 0])
    yield* coordinator.interrupt("session", { requested: true })
    expect(Exit.isFailure(yield* Fiber.await(next))).toBe(true)
    expect([firstMarked, nextMarked]).toEqual([0, 1])
  }))

  it.effect("local close rejects remote exclusive ownership before durable projection", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      let interrupted = false
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.void,
      })
      const remote = yield* coordinator.exclusive("session",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
          Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          )),
        ), "remote",
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* coordinator.captureLocalInterrupt("session")).toBeUndefined()
      expect(interrupted).toBe(false)
      const explicitStop = yield* coordinator.captureInterrupt("session")
      const stopping = yield* explicitStop!.pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      expect(yield* coordinator.captureLocalInterrupt("session")).toBeUndefined()
      yield* Deferred.succeed(cleanupGate, undefined)
      expect(yield* Fiber.join(stopping)).toBe(true)
      expect(interrupted).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(remote))).toBe(true)
    }),
  )

  it.effect("a captured local close never cancels a successor remote owner", () =>
    Effect.gen(function* () {
      const localStarted = yield* Deferred.make<void>()
      const localGate = yield* Deferred.make<void>()
      const remoteStarted = yield* Deferred.make<void>()
      const remoteGate = yield* Deferred.make<void>()
      let remoteInterrupted = false
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.void,
      })
      const local = yield* coordinator.exclusive("session",
        Deferred.succeed(localStarted, undefined).pipe(
          Effect.andThen(Deferred.await(localGate)),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(localStarted)
      const stop = yield* coordinator.captureLocalInterrupt("session")
      expect(stop).toBeDefined()
      yield* Deferred.succeed(localGate, undefined)
      yield* Fiber.join(local)
      const remote = yield* coordinator.exclusive("session",
        Deferred.succeed(remoteStarted, undefined).pipe(
          Effect.andThen(Deferred.await(remoteGate)),
          Effect.onInterrupt(() => Effect.sync(() => { remoteInterrupted = true })),
        ), "remote",
      ).pipe(Effect.forkChild)
      yield* Deferred.await(remoteStarted)
      expect(yield* stop!).toBe(false)
      expect(remoteInterrupted).toBe(false)
      yield* Deferred.succeed(remoteGate, undefined)
      yield* Fiber.join(remote)
    }),
  )

  it.effect("local close stops local exclusive work without a durable run row", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let cleaned = false
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.void,
      })
      const shell = yield* coordinator.exclusive("session",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => { cleaned = true })),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const stop = yield* coordinator.captureLocalInterrupt("session")
      expect(yield* stop!).toBe(true)
      expect(cleaned).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(shell))).toBe(true)
    }),
  )

  it.effect("local close cancels its queued successor without stopping the remote owner", () =>
    Effect.gen(function* () {
      for (const promoted of [false, true]) {
        const remoteStarted = yield* Deferred.make<void>()
        const remoteGate = yield* Deferred.make<void>()
        const localStarted = yield* Deferred.make<void>()
        let localRuns = 0,
          remoteInterrupted = false,
          localInterrupted = false
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () => Effect.sync(() => { localRuns++ }).pipe(
            Effect.andThen(Deferred.succeed(localStarted, undefined)),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => { localInterrupted = true })),
          ),
        })
        const remote = yield* coordinator.exclusive("session",
          Deferred.succeed(remoteStarted, undefined).pipe(
            Effect.andThen(Deferred.await(remoteGate)),
            Effect.onInterrupt(() => Effect.sync(() => { remoteInterrupted = true })),
          ), "remote",
        ).pipe(Effect.forkChild)
        yield* Deferred.await(remoteStarted)
        yield* coordinator.wake("session")
        expect(yield* coordinator.captureLocalInterrupt("session", {
          includeScheduled: false,
        })).toBeUndefined()
        const stop = yield* coordinator.captureLocalInterrupt("session")
        expect(stop).toBeDefined()
        if (promoted) {
          yield* Deferred.succeed(remoteGate, undefined)
          yield* Deferred.await(localStarted)
        }
        expect(yield* stop!).toBe(true)
        expect(remoteInterrupted).toBe(false)
        expect(localRuns).toBe(promoted ? 1 : 0)
        expect(localInterrupted).toBe(promoted)
        yield* Deferred.succeed(remoteGate, undefined)
        yield* Fiber.join(remote)
        yield* coordinator.wait("session")
        expect(localRuns).toBe(promoted ? 1 : 0)
      }
    }),
  )

  it.effect("local close clears a wake behind remote cleanup without waiting on that cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      let localRuns = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.sync(() => { localRuns++ }),
      })
      const remote = yield* coordinator.exclusive("session",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          )),
        ), "remote",
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const stopping = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      yield* coordinator.wake("session")
      const stop = yield* coordinator.captureLocalInterrupt("session")
      expect(yield* stop!).toBe(true)
      expect(stopping.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(stopping)
      expect(Exit.isFailure(yield* Fiber.await(remote))).toBe(true)
      yield* coordinator.wait("session")
      expect(localRuns).toBe(0)
    }),
  )

  it.effect("local close joins captured local cleanup without waiting on a remote successor", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.void,
      })
      const local = yield* coordinator.exclusive("session",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          )),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const explicit = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      const stop = yield* coordinator.captureLocalInterrupt("session")
      expect(stop).toBeDefined()
      const waiting = yield* stop!.pipe(Effect.forkChild)
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(explicit)
      expect(yield* Fiber.join(waiting)).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(local))).toBe(true)
    }),
  )

  it.effect(
    "a captured resume observes its owner without starting or joining a successor",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          gate = yield* Deferred.make<void>()
        const nextStarted = yield* Deferred.make<void>(),
          nextGate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Effect.suspend(() =>
              ++runs === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                  )
                : Deferred.succeed(nextStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(nextGate)),
                  ),
            ),
        })
        expect(yield* coordinator.captureOwner("session")).toBeUndefined()
        yield* coordinator.schedule("session")
        yield* Deferred.await(started)
        const owner = yield* coordinator.captureOwner("session")
        expect(yield* owner!).toBe(true)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(nextStarted)
        expect(yield* owner!).toBe(false)
        expect(runs).toBe(2)
        yield* Deferred.succeed(nextGate, undefined)
        yield* coordinator.wait("session")
      }),
  )
  it.effect(
    "a captured Stop cannot interrupt a replacement owner after authorization waits",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const nextStarted = yield* Deferred.make<void>()
        const nextGate = yield* Deferred.make<void>()
        let cleaned = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () => Effect.void,
        })
        const first = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(firstGate)),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const stop = yield* coordinator.captureInterrupt("session")
        expect(stop).toBeDefined()
        yield* Deferred.succeed(firstGate, undefined)
        yield* Fiber.join(first)
        const second = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(nextStarted, undefined).pipe(
              Effect.andThen(Deferred.await(nextGate)),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned++
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(nextStarted)
        expect(yield* stop!).toBe(false)
        expect(cleaned).toBe(0)
        yield* Deferred.succeed(nextGate, undefined)
        yield* Fiber.join(second)
      }),
  )

  it.effect(
    "a captured Stop cannot cancel a queued successor on the same lifecycle",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Effect.suspend(() =>
              ++runs === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(firstGate)),
                  )
                : Deferred.succeed(secondStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(secondGate)),
                  ),
            ),
        })
        yield* coordinator.schedule("session")
        yield* Deferred.await(firstStarted)
        const stop = yield* coordinator.captureInterrupt("session")
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        expect(yield* stop!).toBe(false)
        yield* Deferred.succeed(secondGate, undefined)
        yield* coordinator.wait("session")
        expect(runs).toBe(2)
      }),
  )

  it.effect(
    "targeted Stop waits for the captured owner's cleanup and never stops an idle key",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        let stopped = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () => Effect.void,
          onStop: () =>
            Effect.sync(() => {
              stopped++
            }),
        })
        expect(yield* coordinator.captureInterrupt("idle")).toBeUndefined()
        expect(stopped).toBe(0)
        const client = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupGate)),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const stop = yield* coordinator.captureInterrupt("session")
        expect(stop).toBeDefined()
        const waiter = yield* stop!.pipe(Effect.forkChild)
        yield* Deferred.await(cleaning)
        expect(waiter.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(cleanupGate, undefined)
        expect(yield* Fiber.join(waiter)).toBe(true)
        expect(Exit.isFailure(yield* Fiber.await(client))).toBe(true)
        expect(stopped).toBe(1)
        expect(yield* stop!).toBe(false)
      }),
  )

  it.effect(
    "closes exclusive work and its cleanup with the owning service scope",
    () =>
      Effect.gen(function* () {
        const serviceScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void))
        const started = yield* Deferred.make<void>()
        let cleaned = false
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () => Effect.void,
        }).pipe(Scope.provide(serviceScope))
        const client = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Scope.close(serviceScope, Exit.void)
        expect(cleaned).toBe(true)
        expect(Exit.isFailure(yield* Fiber.await(client))).toBe(true)
        yield* coordinator.awaitIdle
      }),
  )
  it.effect(
    "publishes exclusive ownership before a subsequent interrupt can observe idle",
    () =>
      Effect.gen(function* () {
        let stopped = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () => Effect.void,
          onStop: () =>
            Effect.sync(() => {
              stopped++
            }),
        })
        const client = yield* coordinator
          .exclusive("session", Effect.never)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* coordinator.interrupt("session")
        expect(stopped).toBe(1)
        expect(Exit.isFailure(yield* Fiber.await(client))).toBe(true)
        yield* coordinator.wait("session")
        yield* coordinator.awaitIdle
      }),
  )

  it.effect(
    "wait is idle-only observation and is isolated to the selected key",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Effect.gen(function* () {
              runs++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            }),
        })
        yield* coordinator.wait("idle")
        expect(runs).toBe(0)
        yield* coordinator.schedule("active")
        yield* Deferred.await(started)
        yield* coordinator.wait("other")
        const waiter = yield* coordinator
          .wait("active")
          .pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(complete)).toBe(false)
        yield* Fiber.interrupt(waiter)
        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.wait("active")
      }),
  )

  it.effect(
    "exclusive work survives client disconnect and queues an agent wake behind cleanup",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const runStarted = yield* Deferred.make<void>()
        const runGate = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Deferred.succeed(runStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runGate)),
            ),
        })
        const client = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupGate)),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* Fiber.interrupt(client)
        const waiter = yield* coordinator
          .wait("session")
          .pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
        expect(yield* Deferred.isDone(cleanupStarted)).toBe(false)
        yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(cleanupStarted)
        expect(yield* Deferred.isDone(runStarted)).toBe(false)
        expect(yield* Deferred.isDone(complete)).toBe(false)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Deferred.await(runStarted)
        expect(yield* Deferred.isDone(complete)).toBe(false)
        yield* Deferred.succeed(runGate, undefined)
        yield* Fiber.join(waiter)
        yield* coordinator.awaitIdle
      }),
  )

  it.effect(
    "rejects another exclusive operation before side effects while the agent or a command owns the key",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let commands = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
            ),
        })
        yield* coordinator.schedule("agent")
        yield* Deferred.await(started)
        expect(
          (yield* coordinator
            .exclusive(
              "agent",
              Effect.sync(() => {
                commands++
              }),
            )
            .pipe(Effect.flip))._tag,
        ).toBe("RunnerBusy")
        const commandStarted = yield* Deferred.make<void>()
        const commandGate = yield* Deferred.make<void>()
        const command = yield* coordinator
          .exclusive(
            "command",
            Deferred.succeed(commandStarted, undefined).pipe(
              Effect.andThen(Deferred.await(commandGate)),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(commandStarted)
        expect(
          (yield* coordinator
            .exclusive(
              "command",
              Effect.sync(() => {
                commands++
              }),
            )
            .pipe(Effect.flip))._tag,
        ).toBe("RunnerBusy")
        expect(commands).toBe(0)
        yield* Deferred.succeed(commandGate, undefined)
        yield* Fiber.join(command)
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.awaitIdle
      }),
  )

  it.effect(
    "interrupt waits for exclusive cleanup without stopping another session",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const otherStarted = yield* Deferred.make<void>()
        const otherGate = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Deferred.succeed(otherStarted, undefined).pipe(
              Effect.andThen(Deferred.await(otherGate)),
            ),
        })
        const command = yield* coordinator
          .exclusive(
            "command",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupGate)),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.schedule("other")
        yield* Deferred.await(otherStarted)
        const interrupt = yield* coordinator
          .interrupt("command")
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const waiter = yield* coordinator
          .wait("command")
          .pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(complete)).toBe(false)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Fiber.join(waiter)
        expect(Exit.isFailure(yield* Fiber.await(command))).toBe(true)
        yield* Deferred.succeed(otherGate, undefined)
        yield* coordinator.awaitIdle
      }),
  )

  it.effect(
    "failed exclusive work releases the owner and preserves its typed failure",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make<string, string>({
          drain: () => Effect.void,
        })
        expect(
          yield* coordinator
            .exclusive("session", Effect.fail("command failed"))
            .pipe(Effect.flip),
        ).toBe("command failed")
        yield* coordinator.wait("session")
        yield* coordinator.awaitIdle
        yield* coordinator.exclusive("session", Effect.void)
        yield* coordinator.awaitIdle
      }),
  )

  it.effect(
    "awaitIdle tracks every owner and its queued wakeups without interrupting work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gates = [
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
          ]
          const started = [
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
          ]
          const complete = yield* Deferred.make<void>()
          let firstRuns = 0
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: (key) =>
              Effect.gen(function* () {
                const index = key === "first" ? firstRuns++ : 2
                yield* Deferred.succeed(started[index], undefined)
                yield* Deferred.await(gates[index])
              }),
          })
          yield* coordinator.awaitIdle
          yield* coordinator.wake("first")
          yield* coordinator.wake("second")
          yield* Deferred.await(started[0])
          yield* Deferred.await(started[2])
          yield* coordinator.wake("first")
          const idle = yield* coordinator.awaitIdle.pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
          yield* Deferred.succeed(gates[0], undefined)
          yield* Deferred.await(started[1])
          yield* Deferred.succeed(gates[2], undefined)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(complete)).toBe(false)
          yield* Deferred.succeed(gates[1], undefined)
          yield* Fiber.join(idle)
          expect(firstRuns).toBe(2)
        }),
      ),
  )

  it.effect(
    "awaitIdle remains pending through interruption cleanup and a queued successor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const cleanupStarted = yield* Deferred.make<void>()
          const cleanupGate = yield* Deferred.make<void>()
          const successorStarted = yield* Deferred.make<void>()
          const successorGate = yield* Deferred.make<void>()
          const complete = yield* Deferred.make<void>()
          let runs = 0
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: () =>
              ++runs === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                  )
                : Deferred.succeed(successorStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(successorGate)),
                  ),
            onStop: () =>
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(cleanupGate)),
              ),
          })
          yield* coordinator.schedule("session")
          yield* Deferred.await(started)
          const interrupt = yield* coordinator
            .interrupt("session")
            .pipe(Effect.forkChild)
          yield* Deferred.await(cleanupStarted)
          yield* coordinator.schedule("session")
          const idle = yield* coordinator.awaitIdle.pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(complete)).toBe(false)
          yield* Deferred.succeed(cleanupGate, undefined)
          yield* Fiber.join(interrupt)
          yield* Deferred.await(successorStarted)
          expect(yield* Deferred.isDone(complete)).toBe(false)
          yield* Deferred.succeed(successorGate, undefined)
          yield* Fiber.join(idle)
        }),
      ),
  )

  it.effect(
    "awaitIdle releases failed runs and resets for a new generation of work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const complete = yield* Deferred.make<void>()
          let runs = 0
          const coordinator = yield* SessionRunCoordinator.make<string, string>(
            {
              drain: () =>
                ++runs === 1
                  ? Effect.fail("failed")
                  : Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(gate)),
                    ),
            },
          )
          expect(yield* coordinator.run("session").pipe(Effect.flip)).toBe(
            "failed",
          )
          yield* coordinator.awaitIdle
          yield* coordinator.schedule("session")
          yield* Deferred.await(started)
          const cancelledWaiter = yield* coordinator.awaitIdle.pipe(
            Effect.forkChild,
          )
          yield* Fiber.interrupt(cancelledWaiter)
          const idle = yield* coordinator.awaitIdle.pipe(
            Effect.andThen(Deferred.succeed(complete, undefined)),
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(complete)).toBe(false)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(idle)
          expect(runs).toBe(2)
        }),
      ),
  )

  it.effect(
    "acknowledges a forced resume without awaiting service-owned work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          const forces: boolean[] = []
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: (_key, force) =>
              Effect.sync(() => forces.push(force)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
          })

          yield* coordinator.schedule("session")
          yield* Deferred.await(started)
          expect(yield* Deferred.isDone(stopped)).toBe(false)
          expect(forces).toEqual([true])
          yield* coordinator.interrupt("session")
          expect(yield* Deferred.isDone(stopped)).toBe(true)
        }),
      ),
  )

  it.effect(
    "repeated scheduled resumes join active work without a successor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const forces: boolean[] = []
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: (_key, force) =>
              Effect.sync(() => forces.push(force)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(gate)),
              ),
          })

          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          yield* Effect.all(
            [coordinator.schedule("session"), coordinator.schedule("session")],
            {
              concurrency: "unbounded",
            },
          )
          const joined = yield* coordinator
            .run("session")
            .pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(joined)
          expect(forces).toEqual([false])
        }),
      ),
  )

  it.effect("queues one scheduled resume behind interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const successorStarted = yield* Deferred.make<void>()
        const successorGate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.gen(function* () {
              forces.push(force)
              if (forces.length > 1) {
                yield* Deferred.succeed(successorStarted, undefined)
                return yield* Deferred.await(successorGate)
              }
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(cleanupGate)),
                  ),
                ),
              )
            }),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const interrupt = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.schedule("session")
        yield* coordinator.schedule("session")
        expect(yield* Deferred.isDone(successorStarted)).toBe(false)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Deferred.await(successorStarted)
        expect(forces).toEqual([false, true])
        yield* Deferred.succeed(successorGate, undefined)
      }),
    ),
  )

  it.effect(
    "service shutdown interrupts work after scheduled clients have returned",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
          const started = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
          }).pipe(Effect.provideService(Scope.Scope, owner))

          yield* coordinator.schedule("session")
          yield* Deferred.await(started)
          expect(yield* Deferred.isDone(stopped)).toBe(false)
          yield* Scope.close(owner, Exit.void)
          expect(yield* Deferred.isDone(stopped)).toBe(true)
        }),
      ),
  )

  it.effect("joins concurrent resumes for one key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => runs++).pipe(
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(resumed)

        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(drained, undefined),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(drained)
      }),
    ),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(firstGate)),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.all(
          [
            coordinator.wake("session"),
            coordinator.wake("session"),
            coordinator.wake("session"),
          ],
          {
            concurrency: "unbounded",
          },
        )
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const thirdStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(firstGate)
                  : run === 2
                    ? Deferred.succeed(secondStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(secondGate)),
                      )
                    : Deferred.succeed(thirdStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(secondGate, undefined)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(3)
      }),
    ),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.void,
        })
        yield* coordinator.interrupt("session")
      }),
    ),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        yield* Deferred.await(interrupted)

        const exit = yield* Fiber.await(resumed)
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBeTrue()
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs a wake registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanupStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(cleanupGate)),
                        ),
                      ),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Deferred.await(secondStarted)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) => {
            forces.push(force)
            return forces.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(cleanupGate)),
                    ),
                  ),
                )
              : Deferred.succeed(secondStarted, undefined)
          },
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
        yield* Deferred.await(secondStarted)

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const failure = new Error("failed")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(gate).pipe(
                      Effect.andThen(Effect.fail(failure)),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect(
    "does not cancel execution when a joined waiter is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          let runs = 0
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () =>
              Effect.sync(() => runs++).pipe(
                Effect.andThen(Deferred.await(gate)),
              ),
          })

          const first = yield* coordinator.run("session").pipe(Effect.forkChild)
          yield* Effect.yieldNow
          const second = yield* coordinator
            .run("session")
            .pipe(Effect.forkChild)
          yield* Fiber.interrupt(second)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(first)

          expect(runs).toBe(1)
        }),
      ),
  )

  it.effect(
    "keeps execution alive after the initiating client disconnects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          let runs = 0
          let interrupted = false
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () =>
              Effect.sync(() => ++runs).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(gate)),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true
                  }),
                ),
              ),
          })

          const client = yield* coordinator
            .run("session")
            .pipe(Effect.scoped, Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(client)
          expect(interrupted).toBe(false)

          const reconnected = yield* coordinator
            .run("session")
            .pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(reconnected)

          expect(runs).toBe(1)
          expect(interrupted).toBe(false)
        }),
      ),
  )

  it.effect(
    "keeps other sessions running while one owner is being disposed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>()
          const secondStarted = yield* Deferred.make<void>()
          const cleanupStarted = yield* Deferred.make<void>()
          const cleanupGate = yield* Deferred.make<void>()
          const secondGate = yield* Deferred.make<void>()
          const stopped: string[] = []
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: (key) =>
              key === "first"
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  )
                : Deferred.succeed(secondStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(secondGate)),
                  ),
            onStop: (key) =>
              Effect.sync(() => {
                stopped.push(key)
              }).pipe(
                Effect.andThen(Deferred.succeed(cleanupStarted, undefined)),
                Effect.andThen(Deferred.await(cleanupGate)),
              ),
          })

          const first = yield* coordinator.run("first").pipe(Effect.forkChild)
          const second = yield* coordinator.run("second").pipe(Effect.forkChild)
          yield* Effect.all([
            Deferred.await(firstStarted),
            Deferred.await(secondStarted),
          ])
          const stop = yield* coordinator
            .interrupt("first")
            .pipe(Effect.forkChild)
          yield* Deferred.await(cleanupStarted)

          yield* Deferred.succeed(secondGate, undefined)
          yield* Fiber.join(second)
          expect(stopped).toEqual(["first"])

          yield* Deferred.succeed(cleanupGate, undefined)
          yield* Fiber.join(stop)
          const exit = yield* Fiber.await(first)
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBeTrue()
        }),
      ),
  )

  it.effect("joins concurrent interrupts behind one owner cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        let runs = 0
        let cleanups = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.flatMap(() => (runs === 1 ? Effect.never : Effect.void)),
            ),
          onStop: () =>
            Effect.sync(() => ++cleanups).pipe(
              Effect.andThen(Deferred.succeed(cleanupStarted, undefined)),
              Effect.andThen(Deferred.await(cleanupGate)),
            ),
        })

        const client = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const first = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const second = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(cleanups).toBe(1)

        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        yield* Fiber.await(client)
        yield* coordinator.run("session")
        expect(runs).toBe(2)
        expect(cleanups).toBe(1)
      }),
    ),
  )

  it.effect(
    "interrupts all active runs when the owning service scope closes",
    () =>
      Effect.gen(function* () {
        const serviceScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void))
        const started = yield* Deferred.make<void>()
        const finished: string[] = []
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() =>
                active === 2
                  ? Deferred.succeed(started, undefined)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finished.push(key)
                }),
              ),
            ),
        }).pipe(Scope.provide(serviceScope))

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Scope.close(serviceScope, Exit.void)

        for (const client of [first, second]) {
          const exit = yield* Fiber.await(client)
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBeTrue()
        }
        expect(finished.sort()).toEqual(["first", "second"])
      }),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const bothStarted = yield* Deferred.make<void>()
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() =>
                active === 2
                  ? Deferred.succeed(bothStarted, undefined)
                  : Effect.void,
              ),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }),
    ),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limit = 20_000
        const completed = yield* Deferred.make<void>()
        let runs = 0
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((run) =>
                run < limit
                  ? wake(key)
                  : Deferred.succeed(completed, undefined),
              ),
              Effect.asVoid,
            ),
        })
        wake = coordinator.wake

        yield* coordinator.wake("session")
        yield* Deferred.await(completed)

        expect(runs).toBe(limit)
      }),
    ),
  )

  it.effect(
    "keeps a wake behind owner cleanup and preserves the forced resume contract",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const stopping = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const events: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.gen(function* () {
              events.push(force ? "resume" : "wake")
              if (events.length === 1) {
                yield* Deferred.succeed(started, undefined)
                yield* Effect.never
              }
            }),
          onStop: () =>
            Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Deferred.await(cleanup)),
              Effect.andThen(Effect.sync(() => events.push("disposed"))),
            ),
        })
        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const stop = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild)
        yield* Deferred.await(stopping)
        yield* coordinator.wake("session")
        const joined = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(events).toEqual(["resume"])
        yield* Deferred.succeed(cleanup, undefined)
        yield* Fiber.join(stop)
        yield* Fiber.await(first)
        yield* Fiber.join(joined)
        expect(events).toEqual(["resume", "disposed", "wake"])
      }),
  )
})
