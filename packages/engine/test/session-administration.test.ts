import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { LocationServiceRegistry } from "../src/runtime/services"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionAdministration } from "../src/sessions/actions/administration"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionExecution } from "../src/sessions/run/execution"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import { SessionRunCoordinator } from "../src/sessions/run/coordinator"
import { SessionStore } from "../src/sessions/store"
import { SessionMessageTable, SessionInputTable, SessionRunStateTable } from "../src/storage/tables/sessions"
import { inputOrigin } from "./fixture/session-input-origin"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(ProjectRegistry.Service, ProjectRegistry.Service.of({
  resolve: (directory) => Effect.succeed({ id: ProjectRegistry.ID.global, directory }),
  directories: () => Effect.succeed([]), commit: () => Effect.void,
}))
const sessions = SessionManager.layer.pipe(
  Layer.provide(LocationServiceRegistry.layer), Layer.provide(EventBus.defaultLayer),
  Layer.provide(Database.defaultLayer), Layer.provide(SessionStore.defaultLayer),
  Layer.provide(projects), Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer,
  SessionStore.defaultLayer, SessionProjector.defaultLayer, sessions))
const location = { directory: AbsolutePath.make("/fixture") }
const administration = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventBus.Service
  const store = yield* SessionStore.Service
  const coordinator = yield* SessionRunCoordinator.make<SessionManager.ID, never>({ drain: () => Effect.void })
  return SessionAdministration.make({ db, events, store, exclusive: coordinator.exclusive })
})

describe("native session administration", () => {
  it.effect("renames and archives without losing identity, model or usage", () => Effect.gen(function* () {
    const session = yield* SessionManager.Service
    const source = yield* session.create({ location, title: "Original" })
    const admin = yield* administration
    const renamed = yield* admin.update({ sessionID: source.id, title: "  New title  ", archived: 123 })
    expect(renamed).toMatchObject({ id: source.id, title: "New title", time: { archived: 123 } })
    const restored = yield* admin.update({ sessionID: source.id, archived: null })
    expect(restored.time.archived).toBeUndefined()
    const empty = yield* admin.update({ sessionID: source.id, title: " " }).pipe(Effect.flip)
    expect(empty._tag).toBe("Session.AdministrationError")
    expect((yield* session.get(source.id)).title).toBe("New title")
  }))

  it.effect("copies history atomically with new message IDs, no pending inputs, execution or double billing", () => Effect.gen(function* () {
    const session = yield* SessionManager.Service
    const events = yield* EventBus.Service
    const source = yield* session.create({ location, title: "History" })
    const timestamp = yield* DateTime.now
    for (const text of ["First prompt", "Second prompt"]) yield* events.publish(SessionEvent.Prompted, {
      sessionID: source.id, timestamp, messageID: SessionMessage.ID.create(), prompt: { text }, delivery: "queue",
    })
    const before = yield* session.messages({ sessionID: source.id, order: "asc" })
    const admin = yield* administration
    const fork = yield* admin.fork({ sessionID: source.id, messageID: before[1]!.id })
    const messages = yield* session.messages({ sessionID: fork.id, order: "asc" })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: "user", text: "First prompt" })
    expect(messages[0]!.id).not.toBe(before[0]!.id)
    expect(yield* session.messages({ sessionID: source.id, order: "asc" })).toEqual(before)
    expect(yield* session.context(fork.id)).toEqual(messages)
    const { db } = yield* Database.Service
    expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, fork.id)).all().pipe(Effect.orDie)).toEqual([])
    expect(yield* db.select().from(SessionRunStateTable).where(eq(SessionRunStateTable.session_id, fork.id)).all().pipe(Effect.orDie)).toEqual([])
    expect(fork.cost).toBe(0)
    yield* admin.remove(fork.id)
    expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, fork.id)).all().pipe(Effect.orDie)).toEqual([])
    expect(yield* session.list()).toHaveLength(1)
  }))

  it.effect("rejects a foreign boundary and remote-origin fork without creating anything", () => Effect.gen(function* () {
    const session = yield* SessionManager.Service
    const events = yield* EventBus.Service
    const source = yield* session.create({ location })
    const admin = yield* administration
    expect((yield* admin.fork({ sessionID: source.id, messageID: SessionMessage.ID.create() }).pipe(Effect.flip))._tag).toBe("Session.AdministrationError")
    yield* SessionInput.admit((yield* Database.Service).db, events, {
      id: SessionMessage.ID.create(), sessionID: source.id, prompt: { text: "Record remote input" },
      delivery: "queue", origin: inputOrigin({ location }),
    })
    expect((yield* admin.fork({ sessionID: source.id }).pipe(Effect.flip))._tag).toBe("SessionInputOrigin.UnavailableError")
    expect(yield* session.list()).toHaveLength(1)
  }))

  it.effect("uses the same owner lock for rename, delete and fork while a run is busy", () => Effect.gen(function* () {
    const session = yield* SessionManager.Service
    const source = yield* session.create({ location, title: "Running" })
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make<SessionManager.ID, never>({
      drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    })
    const admin = SessionAdministration.make({ db: (yield* Database.Service).db,
      events: yield* EventBus.Service, store: yield* SessionStore.Service, exclusive: coordinator.exclusive })
    yield* coordinator.schedule(source.id)
    yield* Deferred.await(entered)
    for (const operation of [admin.update({ sessionID: source.id, title: "No" }), admin.remove(source.id), admin.fork({ sessionID: source.id })])
      expect((yield* operation.pipe(Effect.flip))._tag).toBe("RunnerBusy")
    expect((yield* session.get(source.id)).title).toBe("Running")
    expect(yield* session.list()).toHaveLength(1)
    yield* Deferred.succeed(finish, undefined)
    yield* coordinator.wait(source.id)
  }))
})
