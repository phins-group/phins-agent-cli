import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Exit, Layer, Stream } from "effect"
import { AgentRegistry } from "../src/agents/registry"
import { asc, eq } from "drizzle-orm"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { Location } from "../src/workspace/location"
import { CatalogModel } from "../src/inference/catalog/model"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { LocationServiceRegistry } from "../src/runtime/services"
import { SessionV1 } from "../src/contracts/session/compat"
import { Prompt } from "../src/contracts/session/prompt"
import { SessionProjector } from "../src/sessions/projector"
import { SessionExecution } from "../src/sessions/run/execution"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionRunStateTable, SessionTable } from "../src/storage/tables/sessions"
import { SessionStore } from "../src/sessions/store"
import { SessionRunState } from "../src/sessions/run/state"
import { Workspace as WorkspaceIdentity } from "../src/contracts/workspace/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectRegistry.Service,
  ProjectRegistry.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectRegistry.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const sessions = SessionManager.layer.pipe(
  Layer.provide(LocationServiceRegistry.layer),
  Layer.provide(EventBus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    EventBus.defaultLayer,
    projects,
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    SessionExecution.noopLayer,
    sessions,
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = SessionManager.ID.create()

describe("SessionV2.create", () => {
  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const workspaceID = WorkspaceIdentity.ID.make("wrk_test")
      const model = CatalogModel.Ref.make({
        id: CatalogModel.ID.make("sonnet"),
        providerID: CatalogProvider.ID.anthropic,
        variant: CatalogModel.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentRegistry.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentRegistry.ID.make("build") },
        {
          id,
          location,
          model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: CatalogProvider.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  it.effect("rejects a legacy update that changes the immutable project", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })
      const attempted = yield* events
        .publish(SessionV1.Event.Updated, {
          sessionID: id,
          info: SessionV1.SessionInfo.make({
            id,
            slug: "moved-project",
            version: "test",
            projectID: ProjectRegistry.ID.make("project-other"),
            directory: created.location.directory,
            title: "moved project",
            time: { created: 0, updated: 1 },
          }),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(attempted)).toBe(true)
      expect(
        yield* db
          .select({ projectID: SessionTable.project_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ projectID: created.projectID })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventBus.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { durable: { seq: 1 }, type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } },
        { durable: { seq: 2 }, type: "session.next.prompted" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const sourceEvents = yield* EventBus.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionManager.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventBus.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventBus.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectRegistry.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventBus.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventBus.versionedType(SessionEvent.PromptAdmitted.type, 1)],
          [2, EventBus.versionedType(SessionEvent.Prompted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const event = yield* EventBus.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("recording-only compatibility refuses executable Session operations", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionManager.Error>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionManager.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.agent.switched", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const missing = SessionManager.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "plan" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      const model = CatalogModel.Ref.make({
        id: CatalogModel.ID.make("sonnet"),
        providerID: CatalogProvider.ID.anthropic,
        variant: CatalogModel.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.model.switched", data: { model } }])
    }),
  )

  it.effect("persists repeated switches as distinct durable Session events", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: CatalogProvider.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(3)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const missing = SessionManager.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: CatalogProvider.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("exposes fail-closed durable run state through the Session facade", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const missing = SessionManager.ID.make("ses_missing_run_state")
      expect(
        yield* session.runState(missing).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")

      const created = yield* session.create({ location })
      expect(yield* session.runState(created.id)).toBeUndefined()
      const runID = SessionRunState.ID.make("run_session_facade")
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID: created.id,
        runID,
        timestamp: DateTime.makeUnsafe(10),
      })
      expect(yield* session.runState(created.id)).toMatchObject({ status: "busy", runID })

      yield* events.publish(SessionEvent.Run.Retried, {
        sessionID: created.id,
        runID,
        attempt: 1,
        nextRetryAt: DateTime.makeUnsafe(20),
        error: { message: "retry", isRetryable: true },
      })
      expect(yield* session.runState(created.id)).toMatchObject({ status: "retrying", attempt: 1 })

      yield* events.publish(SessionEvent.Run.Settled, {
        sessionID: created.id,
        runID,
        timestamp: DateTime.makeUnsafe(30),
        outcome: { type: "idle" },
      })
      expect(yield* session.runState(created.id)).toMatchObject({ status: "idle", runID })

      yield* db
        .update(SessionRunStateTable)
        .set({ status: "retrying", attempt: null })
        .where(eq(SessionRunStateTable.session_id, created.id))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* session.runState(created.id).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.RunStateDecodeError")
    }),
  )
})
