import { Cause, Context, Effect, Layer, Schema } from "effect"
import { LocationServiceRegistry } from "../../runtime/services"
import { SessionRunCoordinator } from "./coordinator"
import { SessionRunner } from "./loop"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionStore } from "../store"
import { SessionExecution } from "./execution"
import { ProcessSessions } from "../../execution/process/sessions"
import { SessionOperations } from "../actions/operations"
import { NodeCommandExecution } from "../../execution/commands/executor"
import { NodeCommandRunner } from "../../execution/commands/runner"
import { startPrompt } from "../../execution/control/promotion"
import { SessionInputOrigin } from "../input/origin"
import { SessionInput } from "../input/inbox"
import { SessionRunState } from "./state"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { SessionAdministration } from "../actions/administration"
import { SessionRunLifecycle } from "./lifecycle"
import { Flock } from "../../shared/flock"
import { AppPaths } from "../../runtime/paths"
import path from "node:path"
import { createHash } from "node:crypto"
import * as Subtasks from "./subtasks"
import * as SessionCommands from "../actions/commands"
import { Config } from "../../settings/config"
import * as RunBudget from "./budget"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceRegistry
    const database = yield* Database.Service
    const events = yield* EventBus.Service
    // The in-process coordinator is not sufficient during an old/new host
    // overlap. A live process lock prevents both runtimes executing one ID.
    const owned = <A, E>(id: SessionSchema.ID, work: Effect.Effect<A, E>) =>
      Effect.scoped(Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: (signal) => Flock.acquire(`session-${createHash("sha256").update(id).digest("hex")}`, {
              dir: path.join(AppPaths.directories.state, "locks"), timeoutMs: 0, recoverDeadOwner: true, signal,
            }),
            catch: () => new SessionRunLifecycle.RunBusy(),
          }),
          (lock) => Effect.promise(() => lock.release()),
        )
        return yield* work
      }))
    const drain = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force: boolean) {
        const session = yield* store.get(sessionID)
        if (!session)
          return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* owned(sessionID, SessionRunner.Service.use((runner) =>
          runner.run({ sessionID, force }),
        ).pipe(
          Effect.provideService(Subtasks.Current, subtasks(sessionID)),
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(
                  Effect.annotateLogs({ sessionID }),
                ),
          ),
        ))
      })
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError | SessionOperations.Error
    >({
      drain,
      onStop: (sessionID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session) {
            yield* ProcessSessions.Service.use((processes) =>
              processes.disposeOwner(sessionID),
            ).pipe(Effect.provide(locations.get(session.location)))
          }
        }),
    })
    const subtasks = Subtasks.make({ db: database.db, events, store,
      run: (id) => coordinator.exclusive(id, drain(id, false), "local", "caller"),
    })
    const operation = (
      sessionID: SessionSchema.ID,
      run: (
        operations: SessionOperations.Interface,
      ) => Effect.Effect<void, SessionOperations.Error>,
    ) =>
      coordinator.exclusive(
        sessionID,
        owned(sessionID, Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (!session)
            return yield* Effect.die(`Session not found: ${sessionID}`)
          yield* SessionOperations.Service.use(run).pipe(
            Effect.provide(locations.get(session.location)),
          )
        })),
      )

    const command = (
      node: Parameters<NodeCommandExecution.Interface["start"]>[0],
      value: Omit<NodeCommandRunner.Target, "runID"> | NodeCommandRunner.Target,
      resume: boolean,
      onOwner?: (interrupt: Effect.Effect<boolean>) => void,
      onUserStop?: () => void,
    ) =>
      Effect.gen(function* () {
        const schema = resume
          ? NodeCommandRunner.Target
          : Schema.Struct({
              sessionID: NodeCommandRunner.Target.fields.sessionID,
              messageID: NodeCommandRunner.Target.fields.messageID,
            })
        const parsed = Schema.decodeUnknownExit(schema, {
          onExcessProperty: "error",
        })(value)
        if (parsed._tag === "Failure")
          return yield* new SessionInputOrigin.UnavailableError({
            sessionID: value.sessionID,
          })
        const target = Object.freeze({ ...parsed.value })
        yield* coordinator.exclusive(
          target.sessionID,
          owned(target.sessionID, Effect.gen(function* () {
            // This closure belongs to the newly registered coordinator owner,
            // not a run looked up after a failed transport request.
            const interrupt = yield* coordinator.captureInterrupt(
              target.sessionID,
            )
            if (!interrupt)
              return yield* new SessionInputOrigin.UnavailableError({
                sessionID: target.sessionID,
              })
            onOwner?.(interrupt)
            const session = yield* store.get(target.sessionID)
            if (!session)
              return yield* new SessionInputOrigin.UnavailableError({
                sessionID: target.sessionID,
              })
            const run = (owner: NodeCommandRunner.Target) =>
              NodeCommandRunner.Service.use((runner) => runner.run(node, owner))
            yield* (
              resume
                ? run(target as NodeCommandRunner.Target)
                : startPrompt(node, target, run)
            ).pipe(
              Effect.asVoid,
              Effect.provide(locations.get(session.location)),
              Effect.provideService(Database.Service, database),
              Effect.provideService(EventBus.Service, events),
            )
          })).pipe(
            Effect.catchTag("NodeControl.RestorationError", () =>
              Effect.fail(
                new SessionInputOrigin.UnavailableError({
                  sessionID: target.sessionID,
                }),
              ),
            ),
          ),
          "remote",
          "service",
          onUserStop,
        )
      })

    const execution = SessionExecution.Service.of({
      interrupt: coordinator.interrupt,
      captureLocalInterrupt: (sessionID) =>
        coordinator.captureLocalInterrupt(sessionID),
      resume: coordinator.run,
      scheduleResume: coordinator.schedule,
      wake: coordinator.wake,
      shell: (input) =>
        operation(input.sessionID, (operations) =>
          operations.shell(input).pipe(
            Effect.tap((fresh) =>
              fresh && input.resume === true
                ? coordinator.schedule(input.sessionID)
                : Effect.void,
            ),
            Effect.asVoid,
          ),
        ),
      skill: (input) =>
        operation(input.sessionID, (operations) =>
          operations
            .skill(input)
            .pipe(
              Effect.andThen(
                input.resume === false
                  ? Effect.void
                  : coordinator.wake(input.sessionID),
              ),
            ),
        ),
      compact: (input) =>
        operation(input.sessionID, (operations) =>
          operations
            .compact(input)
            .pipe(
              Effect.andThen(
                input.prompt ? coordinator.wake(input.sessionID) : Effect.void,
              ),
            ),
        ),
      wait: coordinator.wait,
      command: (input) => Effect.gen(function* () {
        const session = yield* store.get(input.sessionID)
        if (!session) return yield* Effect.die("Command session does not exist")
        const budget = yield* Config.Service.use((config) => config.entries()).pipe(
          Effect.map((entries) => RunBudget.createRunBudget(Config.latest(entries, "run_budget"))),
          Effect.provide(locations.get(session.location)),
        )
        yield* coordinator.exclusive(input.sessionID,
          owned(input.sessionID, Effect.gen(function* () {
            yield* SessionCommands.run(input).pipe(
              Effect.provideService(Subtasks.Current, subtasks(input.sessionID)),
              Effect.provide(locations.get(session.location)),
              Effect.provideService(Database.Service, database),
              Effect.provideService(EventBus.Service, events),
              Effect.provideService(SessionStore.Service, store),
            )
            if (input.resume !== false) yield* coordinator.wake(input.sessionID)
          })),
        ).pipe(Effect.provideService(RunBudget.Active, budget))
      }),
      awaitIdle: coordinator.awaitIdle,
    })
    return Context.make(SessionExecution.Service, execution).pipe(
      Context.add(SessionAdministration.Service, SessionAdministration.make({
        db: database.db, events, store,
        exclusive: (id, work) => coordinator.exclusive(id, owned(id, work)).pipe(
          Effect.catch((error) => error._tag === "RunnerBusy" ? Effect.fail(error) : Effect.die(error)),
        ),
      })),
      Context.add(
        NodeCommandExecution.Service,
        NodeCommandExecution.Service.of({
          captureLocalInterrupt: (target) => Effect.gen(function* () {
            const captured = yield* coordinator.captureLocalInterrupt(
              target.sessionID, { includeScheduled: false },
            )
            if (!captured) return undefined
            const valid = Effect.gen(function* () {
              const state = yield* store.runState(target.sessionID).pipe(Effect.orDie)
              return state?.runID === target.runID && state.inputID === undefined &&
                (state.status === "busy" || state.status === "retrying")
            })
            if (!(yield* valid)) return undefined
            return valid.pipe(Effect.flatMap((matches) => matches ? captured : Effect.succeed(false)))
          }),
          captureOwner: (value) => capture(value, false),
          captureInterrupt: (value) => capture(value, true),
          start: (node, target, onOwner, onUserStop) =>
            command(node, target, false, onOwner, onUserStop),
          resume: (node, target, onOwner, onUserStop) =>
            command(node, target, true, onOwner, onUserStop),
        }),
      ),
    )

    function capture(value: NodeCommandRunner.Target, interrupt: boolean) {
      return Effect.gen(function* () {
        const parsed = Schema.decodeUnknownExit(NodeCommandRunner.Target, {
          onExcessProperty: "error",
        })(value)
        if (parsed._tag === "Failure")
          return yield* new SessionInputOrigin.UnavailableError({
            sessionID: value.sessionID,
          })
        const target = Object.freeze({ ...parsed.value })
        const stop = yield* interrupt
          ? coordinator.captureInterrupt(target.sessionID)
          : coordinator.captureOwner(target.sessionID)
        if (!stop) return undefined
        const matches = Effect.gen(function* () {
          const input = yield* SessionInput.find(database.db, target.messageID)
          const current = yield* SessionRunState.load(
            database.db,
            target.sessionID,
          ).pipe(Effect.orDie)
          return Boolean(
            input?.origin &&
              input.sessionID === target.sessionID &&
              input.promotedSeq !== undefined &&
              input.id === `msg_node_${input.origin.commandID}` &&
              current?.runID === target.runID &&
              current.inputID === target.messageID &&
              (current.status === "busy" || current.status === "retrying"),
          )
        })
        if (!(yield* matches)) return undefined
        return matches.pipe(
          Effect.flatMap((valid) => (valid ? stop : Effect.succeed(false))),
        )
      })
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer))
