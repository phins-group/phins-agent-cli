import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { SessionEvent } from "../src/contracts/events/session"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { LocationServiceRegistry } from "../src/runtime/services"
import { Prompt } from "../src/contracts/session/prompt"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import { SessionExecution } from "../src/sessions/run/execution"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionInputOrigin } from "../src/sessions/input/origin"
import { PermissionOrigin } from "../src/security/permissions/origin"
import { SessionInputTable, SessionMessageTable, SessionTable } from "../src/storage/tables/sessions"
import { SessionStore } from "../src/sessions/store"
import { testEffect } from "./lib/effect"
import { inputOrigin } from "./fixture/session-input-origin"

const executionCalls: SessionManager.ID[] = []
const scheduleCalls: SessionManager.ID[] = []
const interruptCalls: SessionManager.ID[] = []
const wakeCalls: SessionManager.ID[] = []
const waitCalls: SessionManager.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    awaitIdle: Effect.void,
    shell: () => Effect.die("unused shell"),
    skill: () => Effect.die("unused skill"),
    command: () => Effect.die("unused command"),
    compact: () => Effect.die("unused compact"),
    wait: (sessionID) => Effect.sync(() => { waitCalls.push(sessionID) }),
    scheduleResume: (sessionID) =>
      Effect.sync(() => {
        scheduleCalls.push(sessionID)
      }),
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)
const sessions = SessionManager.layer.pipe(
  Layer.provide(LocationServiceRegistry.layer),
  Layer.provide(EventBus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(ProjectRegistry.defaultLayer),
  Layer.provide(execution),
)
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    EventBus.defaultLayer,
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    execution,
    sessions,
  ),
)
const sessionID = SessionManager.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

const setup = Effect.gen(function* () {
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
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

describe("SessionV2.prompt", () => {
  it.effect("does not lose a permission origin by handing work to another fiber", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    wakeCalls.length = 0
    const error = yield* PermissionOrigin.restrict({
      sessionID, rules: [{ action: "read", resource: "*", effect: "allow" }], valid: Effect.succeed(true),
    }, session.prompt({ sessionID, prompt: Prompt.make({ text: "Restricted input" }) })).pipe(Effect.flip)
    expect(error).toBeInstanceOf(SessionInputOrigin.UnavailableError)
    expect(yield* admittedCount).toBe(0)
    expect(wakeCalls).toEqual([])
  }))

  it.effect("cannot downgrade recorded provenance through local prompt or scheduling", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    const { db } = yield* Database.Service
    const events = yield* EventBus.Service
    const recorded = yield* SessionInput.admit(db, events, {
      id: messageID, sessionID, prompt: Prompt.make({ text: "Remote input" }),
      delivery: "steer", origin: inputOrigin(),
    })
    wakeCalls.length = 0
    scheduleCalls.length = 0
    executionCalls.length = 0
    const operations: Effect.Effect<unknown, unknown>[] = [
      session.prompt({ id: messageID, sessionID, prompt: recorded.prompt, resume: false }),
      session.prompt({ sessionID, prompt: Prompt.make({ text: "New local input" }) }),
      session.scheduleResume(sessionID), session.resume(sessionID),
    ]
    for (const operation of operations)
      expect(yield* operation.pipe(Effect.flip)).toBeInstanceOf(SessionInputOrigin.UnavailableError)
    expect(yield* admittedCount).toBe(1)
    expect(wakeCalls).toEqual([])
    expect(scheduleCalls).toEqual([])
    expect(executionCalls).toEqual([])
  }))

  it.effect("blocks local operations and revert before delegating a bound session", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    yield* SessionInput.admit((yield* Database.Service).db, yield* EventBus.Service, {
      id: messageID, sessionID, prompt: Prompt.make({ text: "Remote input" }),
      delivery: "queue", origin: inputOrigin(),
    })
    const operations: Effect.Effect<unknown, unknown>[] = [
      session.shell({ sessionID, command: "not executed" }),
      session.command({ id: SessionMessage.ID.create(), sessionID, command: "not executed" }),
      session.skill({ sessionID, skill: "not loaded" }), session.compact({ sessionID }),
      session.revert.stage({ sessionID, messageID }), session.revert.clear(sessionID), session.revert.commit(sessionID),
    ]
    for (const operation of operations)
      expect(yield* operation.pipe(Effect.flip)).toBeInstanceOf(SessionInputOrigin.UnavailableError)
    expect(yield* session.messages({ sessionID })).toEqual([])
  }))

  it.effect("keeps read-only observation and explicit Stop available for bound sessions", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    const recorded = yield* SessionInput.admit((yield* Database.Service).db, yield* EventBus.Service, {
      id: messageID, sessionID, prompt: Prompt.make({ text: "Remote input" }),
      delivery: "steer", origin: inputOrigin(),
    })
    waitCalls.length = 0
    interruptCalls.length = 0
    expect((yield* session.snapshot({ sessionID })).after).toBe(recorded.admittedSeq)
    expect(yield* session.messages({ sessionID })).toEqual([])
    yield* session.wait(sessionID)
    yield* session.interrupt(sessionID)
    expect(waitCalls).toEqual([sessionID])
    expect(interruptCalls).toEqual([sessionID])
  }))
  it.effect("wait observes execution without scheduling or admitting work", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    waitCalls.length = 0
    scheduleCalls.length = 0
    wakeCalls.length = 0
    yield* session.wait(sessionID)
    expect(waitCalls).toEqual([sessionID])
    expect(scheduleCalls).toEqual([])
    expect(wakeCalls).toEqual([])
    expect(yield* admittedCount).toBe(0)
  }))

  it.effect("wait rejects an unknown session before observing execution", () => Effect.gen(function* () {
    const session = yield* SessionManager.Service
    waitCalls.length = 0
    expect(yield* session.wait(SessionManager.ID.make("ses_missing_wait")).pipe(Effect.flip)).toBeInstanceOf(SessionManager.NotFoundError)
    expect(waitCalls).toEqual([])
  }))

  it.effect("schedules a resume without admitting or duplicating input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue recorded input" }),
        resume: false,
      })
      scheduleCalls.length = 0
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.scheduleResume(sessionID)

      expect(scheduleCalls).toEqual([sessionID])
      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("rejects scheduling a missing session before calling execution", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      scheduleCalls.length = 0
      const result = yield* session
        .scheduleResume(SessionManager.ID.make("ses_missing_schedule"))
        .pipe(Effect.flip)

      expect(result._tag).toBe("Session.NotFoundError")
      expect(scheduleCalls).toEqual([])
    }),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      interruptCalls.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionManager.Service
      interruptCalls.length = 0

      yield* session.interrupt(SessionManager.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionManager.ID.make("ses_missing")])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventBus.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventBus.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionManager.Service
      const other = SessionManager.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: ProjectRegistry.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )
})

const placeholder = "New session - 2026-10-13T07:48:27.164Z"
const setTitle = (title: string) => Database.Service.use(({ db }) => db.update(SessionTable)
  .set({ title }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie))

describe("automatic session titles", () => {
  it.effect("names an admitted task before inference and makes it searchable", () => Effect.gen(function* () {
    yield* setup
    yield* setTitle(placeholder)
    const session = yield* SessionManager.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Sửa lỗi HTTP 500 trong auth.ts" }), resume: false })
    expect((yield* session.get(sessionID)).title).toBe("Sửa lỗi HTTP 500 trong auth.ts")
    expect((yield* session.list({ search: "HTTP 500" })).map((item) => item.id)).toEqual([sessionID])
    expect(yield* session.messages({ sessionID })).toEqual([])
  }))

  it.effect("follow-ups and exact retries retain the first task title", () => Effect.gen(function* () {
    yield* setup
    yield* setTitle(placeholder)
    const session = yield* SessionManager.Service
    const first = { id: SessionMessage.ID.create(), sessionID,
      prompt: Prompt.make({ text: "Fix the login bug" }), resume: false }
    yield* session.prompt(first)
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue and run tests" }), resume: false })
    yield* session.prompt(first)
    expect((yield* session.get(sessionID)).title).toBe("Fix the login bug")
    expect(yield* admittedCount).toBe(2)
    yield* setTitle("Owner's chosen title")
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Another request" }), resume: false })
    expect((yield* session.get(sessionID)).title).toBe("Owner's chosen title")
  }))

  it.effect("concurrent prompts use the first durable admission without changing session usage", () => Effect.gen(function* () {
    yield* setup
    yield* setTitle(placeholder)
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ cost: 1.25, tokens_input: 42 })
      .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    const session = yield* SessionManager.Service
    const admitted = yield* Effect.all(["First job", "Second job"].map((text) =>
      session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })), { concurrency: "unbounded" })
    const first = admitted.toSorted((a, b) => a.admittedSeq - b.admittedSeq)[0]!
    expect(yield* session.get(sessionID)).toMatchObject({ title: first.prompt.text, cost: 1.25, tokens: { input: 42 } })
  }))

  it.effect("continuing an older unnamed session recovers its original request", () => Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Implement invoice export" }), resume: false })
    yield* setTitle(placeholder)
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
    expect((yield* session.get(sessionID)).title).toBe("Implement invoice export")
  }))

  it.effect("empty input waits for a meaningful task and a conflicting retry cannot rename", () => Effect.gen(function* () {
    yield* setup
    yield* setTitle(placeholder)
    const session = yield* SessionManager.Service
    const first = { id: SessionMessage.ID.create(), sessionID, prompt: Prompt.make({ text: " \n " }), resume: false }
    yield* session.prompt(first)
    expect((yield* session.get(sessionID)).title).toBe(placeholder)
    yield* session.prompt({ ...first, prompt: Prompt.make({ text: "Rejected replacement" }) }).pipe(Effect.flip)
    expect((yield* session.get(sessionID)).title).toBe(placeholder)
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Add validation tests" }), resume: false })
    expect((yield* session.get(sessionID)).title).toBe("Add validation tests")
  }))
})
