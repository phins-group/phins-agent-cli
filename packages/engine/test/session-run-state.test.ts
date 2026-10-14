import { describe, expect, test } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionProjector } from "../src/sessions/projector"
import { SessionRunState } from "../src/sessions/run/state"
import { SessionStore } from "../src/sessions/store"
import { SessionRunStateTable, SessionTable } from "../src/storage/tables/sessions"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventBus.defaultLayer,
  SessionProjector.defaultLayer,
  SessionStore.defaultLayer,
)
const it = testEffect(testLayer)
const sessionID = SessionManager.ID.make("ses_run_state")
const run1 = SessionRunState.ID.make("run_first")
const run2 = SessionRunState.ID.make("run_second")
const retryError: SessionRunState.RetryError = {
  message: "rate limited",
  statusCode: 429,
  isRetryable: true,
  responseHeaders: { "retry-after": "1" },
  metadata: { provider: "test" },
}

const seedSession = (id = sessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectRegistry.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: ProjectRegistry.ID.global,
        slug: "run-state",
        directory: AbsolutePath.make("/project"),
        title: "run state",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value)

describe("SessionRunState", () => {
  it.effect("projects the lifecycle and exposes it through SessionStore", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service

      expect(yield* store.runState(sessionID)).toBeUndefined()
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      const busy = yield* store.runState(sessionID)
      expect(busy?.status).toBe("busy")
      expect(busy?.runID).toBe(run1)
      expect(busy && millis(busy.time.started)).toBe(10)

      yield* events.publish(SessionEvent.Run.Retried, {
        sessionID,
        runID: run1,
        attempt: 1,
        nextRetryAt: DateTime.makeUnsafe(30),
        error: retryError,
      })
      const retrying = yield* store.runState(sessionID)
      expect(retrying).toMatchObject({ status: "retrying", runID: run1, attempt: 1, error: retryError })
      expect(retrying?.status === "retrying" && millis(retrying.nextRetryAt)).toBe(30)

      yield* events.publish(SessionEvent.Run.Settled, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(40),
        outcome: { type: "terminal-failure", error: { type: "unknown", message: "exhausted" } },
      })
      const failed = yield* store.runState(sessionID)
      expect(failed).toMatchObject({
        status: "terminal-failure",
        runID: run1,
        error: { type: "unknown", message: "exhausted" },
      })
      expect(failed?.status === "terminal-failure" && millis(failed.time.settled)).toBe(40)

      // Started is authoritative even after a previous terminal projection.
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run2,
        timestamp: DateTime.makeUnsafe(50),
      })
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "busy", runID: run2 })
      yield* events.publish(SessionEvent.Run.Settled, {
        sessionID,
        runID: run2,
        timestamp: DateTime.makeUnsafe(60),
        outcome: { type: "idle" },
      })
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "idle", runID: run2 })
    }),
  )

  it.effect("atomically hands an active run off to a new run", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      const published = yield* events.publishBatch([
        {
          definition: SessionEvent.Run.Settled,
          data: {
            sessionID,
            runID: run1,
            timestamp: DateTime.makeUnsafe(20),
            outcome: { type: "interrupted" },
          },
        },
        {
          definition: SessionEvent.Run.Started,
          data: { sessionID, runID: run2, timestamp: DateTime.makeUnsafe(20) },
        },
      ])

      expect(published.map((event) => event.durable?.seq)).toEqual([1, 2])
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "busy", runID: run2 })
    }),
  )

  it.effect("rejects stale run IDs and rolls their events back", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run2,
        timestamp: DateTime.makeUnsafe(20),
      })

      const staleRetry = yield* events
        .publish(SessionEvent.Run.Retried, {
          sessionID,
          runID: run1,
          attempt: 1,
          nextRetryAt: DateTime.makeUnsafe(30),
          error: retryError,
        })
        .pipe(Effect.exit)
      const staleSettlement = yield* events
        .publish(SessionEvent.Run.Settled, {
          sessionID,
          runID: run1,
          timestamp: DateTime.makeUnsafe(30),
          outcome: { type: "interrupted" },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(staleRetry)).toBe(true)
      expect(String(staleRetry)).toContain("stale-run")
      expect(Exit.isFailure(staleSettlement)).toBe(true)
      expect(String(staleSettlement)).toContain("stale-run")
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "busy", runID: run2 })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
    }),
  )

  it.effect("rejects duplicate or decreasing retry attempts", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      yield* events.publish(SessionEvent.Run.Retried, {
        sessionID,
        runID: run1,
        attempt: 2,
        nextRetryAt: DateTime.makeUnsafe(30),
        error: retryError,
      })
      const exit = yield* events
        .publish(SessionEvent.Run.Retried, {
          sessionID,
          runID: run1,
          attempt: 1,
          nextRetryAt: DateTime.makeUnsafe(40),
          error: retryError,
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("stale-attempt")
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "retrying", attempt: 2 })
    }),
  )

  it.effect("rejects a retry scheduled before its run started", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      const exit = yield* events
        .publish(SessionEvent.Run.Retried, {
          sessionID,
          runID: run1,
          attempt: 1,
          nextRetryAt: DateTime.makeUnsafe(9),
          error: retryError,
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("invalid-time")
      expect(yield* store.runState(sessionID)).toMatchObject({ status: "busy", runID: run1 })
    }),
  )

  it.effect("replays serialized run events deterministically", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      const store = yield* SessionStore.Service
      yield* events.replayAll([
        {
          id: EventBus.ID.make("evt_run_replay_started"),
          type: EventBus.versionedType(SessionEvent.Run.Started.type, 1),
          seq: 0,
          aggregateID: sessionID,
          data: { sessionID, runID: run1, timestamp: 10 },
        },
        {
          id: EventBus.ID.make("evt_run_replay_retried"),
          type: EventBus.versionedType(SessionEvent.Run.Retried.type, 1),
          seq: 1,
          aggregateID: sessionID,
          data: { sessionID, runID: run1, attempt: 1, nextRetryAt: 30, error: retryError },
        },
        {
          id: EventBus.ID.make("evt_run_replay_settled"),
          type: EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
          seq: 2,
          aggregateID: sessionID,
          data: { sessionID, runID: run1, timestamp: 40, outcome: { type: "idle" } },
        },
      ])

      const state = yield* store.runState(sessionID)
      expect(state).toMatchObject({ status: "idle", runID: run1 })
      expect(state?.status === "idle" && millis(state.time.started)).toBe(10)
      expect(state?.status === "idle" && millis(state.time.settled)).toBe(40)
    }),
  )

  it.effect("fails typed reads for corrupt projection rows", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const { db } = yield* Database.Service
      const store = yield* SessionStore.Service
      yield* db
        .insert(SessionRunStateTable)
        .values({
          session_id: sessionID,
          run_id: run1,
          status: "retrying",
          time_started: 10,
        })
        .run()
        .pipe(Effect.orDie)
      const exit = yield* store.runState(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("Session.RunStateDecodeError")
    }),
  )
})

function persistentLayer(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventBus.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(database, events, projector, store)
}

test("SessionRunState survives a database/service restart", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "run-state.sqlite")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSession()
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: run1,
        timestamp: DateTime.makeUnsafe(10),
      })
      yield* events.publish(SessionEvent.Run.Retried, {
        sessionID,
        runID: run1,
        attempt: 1,
        nextRetryAt: DateTime.makeUnsafe(30),
        error: retryError,
      })
    }).pipe(Effect.provide(persistentLayer(filename)), Effect.scoped),
  )

  const restarted = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      return yield* store.runState(sessionID)
    }).pipe(Effect.provide(persistentLayer(filename)), Effect.scoped),
  )
  expect(restarted).toMatchObject({ status: "retrying", runID: run1, attempt: 1 })
  expect(restarted?.status === "retrying" && millis(restarted.nextRetryAt)).toBe(30)

  const storedEvents = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
  expect(storedEvents.map((event) => event.type)).toEqual([
    "session.next.run.started.1",
    "session.next.run.retried.1",
  ])
})
