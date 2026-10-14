import { describe, expect, spyOn } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { LocationServiceRegistry } from "../src/runtime/services"
import { CatalogModel } from "../src/inference/catalog/model"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import { SessionRunState } from "../src/sessions/run/state"
import { SessionMessageTable, SessionRunStateTable } from "../src/storage/tables/sessions"
import { SessionStore } from "../src/sessions/store"
import { SessionExecution } from "../src/sessions/run/execution"
import { testEffect } from "./lib/effect"

const projects = Layer.mock(ProjectRegistry.Service, {
  resolve: (directory) => Effect.succeed({ id: ProjectRegistry.ID.global, directory }),
})
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
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    projects,
    sessions,
  ),
)
const location = { directory: AbsolutePath.make("/snapshot-fixture") }
const synthetic = (sessionID: SessionManager.ID, text: string) =>
  Effect.gen(function* () {
    return yield* (yield* EventBus.Service).publish(SessionEvent.Synthetic, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      text,
      timestamp: DateTime.makeUnsafe(1),
    })
  })

describe("SessionV2 durable snapshot", () => {
  it.effect("returns an empty projected history and the creation cursor without scheduling work", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      expect(yield* session.snapshot({ sessionID: created.id })).toEqual({
        session: created,
        messages: [],
        runState: undefined,
        after: 0,
        hasMore: false,
      })
    }),
  )

  it.effect("bounds newest-first history by aggregate order and isolates the session", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      const other = yield* session.create({ location })
      for (let index = 0; index < 22; index++) yield* synthetic(created.id, `message ${index}`)
      yield* synthetic(other.id, "private other session")
      const snapshot = yield* session.snapshot({ sessionID: created.id })
      expect(snapshot.after).toBe(22)
      expect(snapshot.messages).toHaveLength(20)
      expect(snapshot.messages[0]).toMatchObject({ type: "synthetic", text: "message 21" })
      expect(snapshot.messages.at(-1)).toMatchObject({ type: "synthetic", text: "message 2" })
      expect(snapshot.hasMore).toBe(true)
      const full = yield* session.snapshot({ sessionID: created.id, limit: 200 })
      expect(full.messages).toHaveLength(22)
      expect(full.hasMore).toBe(false)
      expect((yield* session.snapshot({ sessionID: created.id, limit: 1 })).messages).toHaveLength(1)
    }),
  )

  it.effect("captures persisted run state and admissions without claiming unpromoted history", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: { text: "record only" }, resume: false })
      const runID = SessionRunState.ID.create()
      yield* (yield* EventBus.Service).publish(SessionEvent.Run.Started, {
        sessionID: created.id,
        runID,
        timestamp: DateTime.makeUnsafe(10),
      })
      expect(yield* session.snapshot({ sessionID: created.id })).toMatchObject({
        messages: [],
        after: 2,
        runState: { sessionID: created.id, runID, status: "busy" },
      })
    }),
  )

  it.effect("rejects missing sessions and invalid limits rather than returning partial state", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const sessionID = SessionManager.ID.make("ses_missing_snapshot")
      expect((yield* session.snapshot({ sessionID }).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
      for (const limit of [0, -1, 201, 1.5, NaN, Infinity])
        expect((yield* session.snapshot({ sessionID, limit }).pipe(Effect.flip))._tag).toBe(
          "Session.SnapshotLimitError",
        )
    }),
  )

  it.effect("omits live token deltas but reads the full text once its ended event commits", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const created = yield* session.create({ location })
      const assistantMessageID = SessionMessage.ID.create()
      const base = { sessionID: created.id, assistantMessageID, timestamp: DateTime.makeUnsafe(1) }
      yield* events.publish(SessionEvent.Step.Started, {
        ...base,
        agent: "build",
        model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("fixture"), providerID: CatalogProvider.ID.openai }),
      })
      yield* events.publish(SessionEvent.Text.Started, { ...base, textID: "fixture-text" })
      yield* events.publish(SessionEvent.Text.Delta, { ...base, textID: "fixture-text", delta: "live fragment" })
      expect(yield* session.snapshot({ sessionID: created.id })).toMatchObject({
        after: 2,
        messages: [{ type: "assistant", content: [{ type: "text", text: "" }] }],
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        ...base,
        textID: "fixture-text",
        text: "complete committed text",
      })
      expect(yield* session.snapshot({ sessionID: created.id })).toMatchObject({
        after: 3,
        messages: [{ content: [{ text: "complete committed text" }] }],
      })
    }),
  )

  it.effect("fails closed on a corrupt message or persisted run state", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const event = yield* synthetic(created.id, "valid")
      yield* db
        .update(SessionMessageTable)
        .set({ data: {} as NonNullable<(typeof SessionMessageTable.$inferSelect)["data"]> })
        .where(eq(SessionMessageTable.id, event.data.messageID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* session.snapshot({ sessionID: created.id }).pipe(Effect.flip))._tag).toBe(
        "Session.MessageDecodeError",
      )
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* (yield* EventBus.Service).publish(SessionEvent.Run.Started, {
        sessionID: created.id,
        runID: SessionRunState.ID.create(),
        timestamp: DateTime.makeUnsafe(10),
      })
      yield* db
        .update(SessionRunStateTable)
        .set({ status: "retrying", attempt: null })
        .where(eq(SessionRunStateTable.session_id, created.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* session.snapshot({ sessionID: created.id }).pipe(Effect.flip))._tag).toBe(
        "Session.RunStateDecodeError",
      )
      // Failed snapshots release their transaction, so subsequent reads still work.
      expect((yield* session.get(created.id)).id).toBe(created.id)
    }),
  )

  it.live("keeps the snapshot cursor before a concurrent commit and catches that commit in the feed", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      const events = yield* EventBus.Service
      const created = yield* session.create({ location })
      yield* synthetic(created.id, "before attach")
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const attempted = yield* Deferred.make<void>()
      const messages = store.messages
      // Pause a real read inside the transaction; the writer uses the real DB.
      const spy = spyOn(store, "messages").mockImplementation((input) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(messages(input)),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const read = yield* session.snapshot({ sessionID: created.id }).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
      const write = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(synthetic(created.id, "during attach")),
        Effect.forkChild,
      )
      yield* Deferred.await(attempted).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(gate, undefined)
      const snapshot = yield* Fiber.join(read).pipe(Effect.timeout("2 seconds"))
      const committed = yield* Fiber.join(write).pipe(Effect.timeout("2 seconds"))
      expect(snapshot.after).toBe(1)
      expect(snapshot.messages).toMatchObject([{ text: "before attach" }])
      expect(committed.durable?.seq).toBe(2)
      expect(
        Array.from(
          yield* events
            .durable({ aggregateID: created.id, after: snapshot.after })
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("2 seconds")),
        ),
      ).toMatchObject([{ durable: { seq: 2 }, data: { text: "during attach" } }])
    }),
  )

  it.live("an interrupted snapshot releases its read transaction without mutating history", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      const created = yield* session.create({ location })
      const entered = yield* Deferred.make<void>()
      const spy = spyOn(store, "messages").mockImplementation(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const read = yield* session.snapshot({ sessionID: created.id }).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
      yield* Fiber.interrupt(read).pipe(Effect.timeout("2 seconds"))
      spy.mockRestore()
      yield* synthetic(created.id, "after read cancellation").pipe(Effect.timeout("2 seconds"))
      expect(yield* session.snapshot({ sessionID: created.id })).toMatchObject({
        after: 1,
        messages: [{ text: "after read cancellation" }],
      })
    }),
  )
})
