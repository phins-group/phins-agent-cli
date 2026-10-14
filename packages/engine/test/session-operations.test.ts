import { describe, expect } from "bun:test"
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMError, type LLMEvent, type LLMRequest, Model, TransportReason } from "../src/inference/api"
import * as OpenAIChat from "../src/inference/protocols/openai-chat"
import { AgentRegistry } from "../src/agents/registry"
import { Config } from "../src/settings/config"
import { ConfigCompaction } from "../src/settings/compaction"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { FileAccess } from "../src/workspace/files/access"
import { Location } from "../src/workspace/location"
import { LocationMutation } from "../src/workspace/mutations"
import { PermissionPolicy } from "../src/security/permissions/service"
import { PermissionSaved } from "../src/security/permissions/saved"
import { ProcessRunner } from "../src/execution/process/runner"
import { ProcessSessions } from "../src/execution/process/sessions"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionCompaction } from "../src/sessions/context/compaction"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionOperations } from "../src/sessions/actions/operations"
import { Prompt } from "../src/contracts/session/prompt"
import { SessionProjector } from "../src/sessions/projector"
import { SessionRunnerModel } from "../src/sessions/run/model"
import { Session as SessionSchema } from "../src/contracts/session/info"
import { SessionStore } from "../src/sessions/store"
import { SessionContextEpochTable, SessionTable } from "../src/storage/tables/sessions"
import { SkillRegistry } from "../src/agents/skills/registry"
import { BashTool } from "../src/tools/process/shell"
import { ToolRegistry } from "../src/tools/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_operations")
const model = Model.make({ id: "fixture-model", provider: "fixture", route: OpenAIChat.route })
const summary: LLMEvent[] = [{ type: "text-delta", id: "summary", text: "## Goal\n- Fixture summary" }]

class Fixture extends Context.Service<
  Fixture,
  {
    directory: AbsolutePath
    calls: number
    native: boolean
    processGate?: Deferred.Deferred<void>
    processStarted: Deferred.Deferred<void>
    modelCalls: SessionSchema.ID[]
    selectedModel: Model
    requests: LLMRequest[]
    response: Stream.Stream<LLMEvent, LLMError>
  }
>()("test/SessionOperations") {}

const fixture = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const temp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
    )
    return Fixture.of({
      directory: AbsolutePath.make(temp.path),
      calls: 0,
      native: false,
      processStarted: Deferred.makeUnsafe<void>(),
      modelCalls: [],
      selectedModel: model,
      requests: [],
      response: Stream.fromIterable(summary),
    })
  }),
)
const activeLocation = Layer.effect(
  Location.Service,
  Fixture.use((fx) => Effect.succeed(location({ directory: fx.directory }))),
).pipe(Layer.provide(fixture))
const base = Layer.mergeAll(
  fixture,
  activeLocation,
  Database.defaultLayer,
  EventBus.defaultLayer,
  SessionStore.defaultLayer,
  SessionProjector.defaultLayer,
  AgentRegistry.layer,
)
const permission = PermissionPolicy.layer.pipe(Layer.provide(base), Layer.provide(PermissionSaved.defaultLayer))
const config = Layer.mock(Config.Service, {
  entries: () =>
    Effect.succeed([
      new Config.Document({
        type: "document",
        info: new Config.Info({ shell: "/bin/sh", compaction: new ConfigCompaction.Info({ auto: false }) }),
      }),
    ]),
})
const registry = ToolRegistry.defaultLayer
const process = Layer.effect(
  ProcessRunner.Service,
  Effect.gen(function* () {
    const fx = yield* Fixture
    const actual = yield* ProcessRunner.Service
    return ProcessRunner.Service.of({
      ...actual,
      run: (command, options) =>
        Effect.gen(function* () {
          fx.calls++
          yield* Deferred.succeed(fx.processStarted, undefined)
          if (fx.processGate) yield* Deferred.await(fx.processGate)
          if (fx.native) return yield* actual.run(command, options)
          return {
            command: "fixture",
            exitCode: 0,
            stdout: Buffer.from("fixture output\n"),
            stderr: Buffer.alloc(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        }),
    })
  }),
).pipe(Layer.provide(ProcessRunner.defaultLayer), Layer.provide(fixture))
const bash = BashTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(config),
  Layer.provide(process),
  Layer.provide(FileAccess.defaultLayer),
  Layer.provide(LocationMutation.layer.pipe(Layer.provide(activeLocation), Layer.provide(FileAccess.defaultLayer))),
  Layer.provide(Layer.mock(ProcessSessions.Service, {})),
)
const skills = Layer.unwrap(
  Fixture.use((fx) =>
    Effect.succeed(
      Layer.mock(SkillRegistry.Service, {
        list: () =>
          Effect.succeed([
            {
              name: "review",
              location: AbsolutePath.make(`${fx.directory}/skills/review/SKILL.md`),
              content: "Review fixture code without changing files.",
            },
          ]),
      }),
    ),
  ),
).pipe(Layer.provide(fixture))
const llm = Layer.unwrap(
  Fixture.use((fx) =>
    Effect.succeed(
      Layer.mock(LLMClient.Service, {
        stream: (request) =>
          Stream.unwrap(
            Effect.sync(() => {
              fx.requests.push(request)
              return fx.response
            }),
          ),
      }),
    ),
  ),
).pipe(Layer.provide(fixture))
const models = Layer.unwrap(
  Fixture.use((fx) =>
    Effect.succeed(
      SessionRunnerModel.layerWith((session) =>
        Effect.sync(() => {
          fx.modelCalls.push(session.id)
          return fx.selectedModel
        }),
      ),
    ),
  ),
).pipe(Layer.provide(fixture))
const operations = SessionOperations.layer.pipe(
  Layer.provide(base),
  Layer.provide(permission),
  Layer.provide(registry),
  Layer.provide(skills),
  Layer.provide(llm),
  Layer.provide(models),
  Layer.provide(config),
)
const it = testEffect(Layer.mergeAll(base, permission, bash, operations))

const setup = Effect.gen(function* () {
  const fx = yield* Fixture
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectRegistry.ID.global, worktree: fx.directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      directory: fx.directory,
      slug: "operations",
      title: "fixture",
      version: "fixture",
      agent: AgentRegistry.defaultID,
    })
    .run()
    .pipe(Effect.orDie)
  yield* (yield* AgentRegistry.Service).transform((draft) =>
    draft.update(AgentRegistry.defaultID, (agent) => {
      agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    }),
  )
})
const prompt = (text = "Recorded fixture history") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventBus.Service
    yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.create(),
      sessionID,
      delivery: "steer",
      prompt: Prompt.make({ text }),
    })
    yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
  })

describe("SessionOperations", () => {
  it.live("runs the canonical Bash leaf and records its settled output before returning", () =>
    Effect.gen(function* () {
      yield* setup
      const fx = yield* Fixture
      const operations = yield* SessionOperations.Service
      expect(yield* operations.shell({ sessionID, command: "printf fixture", resume: false })).toBe(true)
      expect(fx.calls).toBe(1)
      expect(yield* (yield* SessionStore.Service).messages({ sessionID })).toMatchObject([
        {
          type: "shell",
          command: "printf fixture",
          output: "fixture output\n\n\nCommand exited with code 0.",
          time: { completed: expect.anything() },
        },
      ])
    }),
  )

  it.live("executes a harmless native shell command only in the disposable Location", () =>
    Effect.gen(function* () {
      yield* setup
      const fx = yield* Fixture
      fx.native = true
      yield* (yield* SessionOperations.Service).shell({ sessionID, command: "printf native-fixture", resume: false })
      const messages = yield* (yield* SessionStore.Service).messages({ sessionID })
      expect(messages).toMatchObject([{ type: "shell", output: "native-fixture\n\nCommand exited with code 0." }])
    }),
  )

  it.live("exact shell retries do not execute twice and changed payloads conflict", () =>
    Effect.gen(function* () {
      yield* setup
      const fx = yield* Fixture
      const operations = yield* SessionOperations.Service
      const id = EventBus.ID.create()
      expect(yield* operations.shell({ sessionID, id, command: "printf fixture" })).toBe(true)
      expect(yield* operations.shell({ sessionID, id, command: "printf fixture" })).toBe(false)
      expect(yield* operations.shell({ sessionID, id, command: "different" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.ConflictError,
      )
      expect(fx.calls).toBe(1)
    }),
  )

  it.live("preserves nonzero command exit as a completed settlement without replay", () =>
    Effect.gen(function* () {
      yield* setup
      const fx = yield* Fixture
      fx.native = true
      const operations = yield* SessionOperations.Service
      const input = { sessionID, id: EventBus.ID.create(), command: "printf fixture-failure; exit 7", resume: false }
      expect(yield* operations.shell(input)).toBe(true)
      expect(yield* operations.shell(input)).toBe(false)
      const messages = yield* (yield* SessionStore.Service).messages({ sessionID })
      expect(messages).toMatchObject([{ type: "shell", output: "fixture-failure\n\nCommand exited with code 7." }])
      expect(fx.calls).toBe(1)
    }),
  )

  it.live("concurrent sessions cannot reuse the same shell or skill operation ID", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const other = SessionSchema.ID.create()
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: ProjectRegistry.ID.global,
          directory: (yield* Fixture).directory,
          slug: "other",
          title: "other",
          version: "fixture",
          agent: AgentRegistry.defaultID,
        })
        .run()
        .pipe(Effect.orDie)
      const operations = yield* SessionOperations.Service
      for (const operation of ["shell", "skill"] as const) {
        const id = EventBus.ID.create()
        const results = yield* Effect.all(
          [sessionID, other].map((sessionID) =>
            (operation === "shell"
              ? operations.shell({ sessionID, id, command: "printf fixture" })
              : operations.skill({ sessionID, id, skill: "review", resume: false })
            ).pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error })),
          ),
          { concurrency: "unbounded" },
        )
        expect(results.filter((result) => result === undefined)).toHaveLength(1)
        expect(results.find((result) => result !== undefined)).toBeInstanceOf(SessionOperations.ConflictError)
      }
      expect((yield* Fixture).calls).toBe(1)
    }),
  )

  it.live("an operation ID used by a different durable event fails before spawn", () =>
    Effect.gen(function* () {
      yield* setup
      const id = EventBus.ID.create()
      yield* (yield* EventBus.Service).publish(
        SessionEvent.Synthetic,
        {
          sessionID,
          messageID: SessionMessage.ID.create(),
          text: "existing event",
          timestamp: yield* DateTime.now,
        },
        { id },
      )
      expect(
        yield* (yield* SessionOperations.Service).shell({ sessionID, id, command: "printf fixture" }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionOperations.ConflictError)
      expect((yield* Fixture).calls).toBe(0)
    }),
  )

  it.live("an incomplete durable shell record is never automatically replayed", () =>
    Effect.gen(function* () {
      yield* setup
      const id = EventBus.ID.create()
      yield* (yield* EventBus.Service).publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          messageID: SessionMessage.ID.make(`msg_${id.slice(4)}`),
          callID: id,
          command: "printf fixture",
          timestamp: yield* DateTime.now,
        },
        { id },
      )
      const error = yield* (yield* SessionOperations.Service)
        .shell({ sessionID, id, command: "printf fixture" })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionOperations.FailedError)
      expect(error.message).toContain("unknown")
      expect((yield* Fixture).calls).toBe(0)
    }),
  )

  it.live("resource-specific permission rejection prevents spawn and is durably settled", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* AgentRegistry.Service).transform((draft) =>
        draft.update(AgentRegistry.defaultID, (agent) => {
          agent.permissions = [{ action: "bash", resource: "restricted", effect: "deny" }]
        }),
      )
      const id = EventBus.ID.create()
      const operations = yield* SessionOperations.Service
      expect(yield* operations.shell({ sessionID, id, command: "restricted" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.FailedError,
      )
      expect((yield* Fixture).calls).toBe(0)
      const messages = yield* (yield* SessionStore.Service).messages({ sessionID })
      expect(
        Schema.decodeUnknownSync(SessionMessage.Message)(Schema.encodeSync(SessionMessage.Message)(messages[0]!)),
      ).toEqual(messages[0])
      expect(messages).toMatchObject([
        { type: "shell", error: { type: "unknown" }, time: { completed: expect.anything() } },
      ])
      expect(yield* operations.shell({ sessionID, id, command: "restricted" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.FailedError,
      )
    }),
  )

  it.live("headless shell waits for an explicit permission reply before spawning", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* AgentRegistry.Service).transform((draft) =>
        draft.update(AgentRegistry.defaultID, (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "ask" }]
        }),
      )
      const events = yield* EventBus.Service
      const request = yield* events
        .subscribe(PermissionPolicy.Event.Asked)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const operations = yield* SessionOperations.Service
      const shell = yield* operations.shell({ sessionID, command: "printf fixture" }).pipe(Effect.forkChild)
      const [asked] = yield* Fiber.join(request)
      expect((yield* Fixture).calls).toBe(0)
      yield* (yield* PermissionPolicy.Service).reply({ requestID: asked.data.id, reply: "once" })
      expect(yield* Fiber.join(shell)).toBe(true)
      expect((yield* Fixture).calls).toBe(1)
    }),
  )

  it.live("interrupted shell records a failure after cleanup and refuses a replay", () =>
    Effect.gen(function* () {
      yield* setup
      const fx = yield* Fixture
      fx.processGate = yield* Deferred.make<void>()
      const id = EventBus.ID.create()
      const operations = yield* SessionOperations.Service
      const shell = yield* operations.shell({ sessionID, id, command: "printf fixture" }).pipe(Effect.forkChild)
      yield* Deferred.await(fx.processStarted)
      yield* Fiber.interrupt(shell)
      expect(yield* (yield* SessionStore.Service).messages({ sessionID })).toMatchObject([
        { type: "shell", error: { message: "Shell execution interrupted" } },
      ])
      expect(yield* operations.shell({ sessionID, id, command: "printf fixture" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.FailedError,
      )
      expect(fx.calls).toBe(1)
    }),
  )

  it.live("loads an authorized skill into one durable input and exact retries reuse it", () =>
    Effect.gen(function* () {
      yield* setup
      const operations = yield* SessionOperations.Service
      const id = EventBus.ID.create()
      yield* operations.skill({ sessionID, id, skill: "review", resume: false })
      yield* operations.skill({ sessionID, id, skill: "review", resume: false })
      const db = (yield* Database.Service).db
      const input = yield* SessionInput.find(db, SessionMessage.ID.make(`msg_${id.slice(4)}`))
      expect(input?.prompt.text).toContain("Review fixture code without changing files.")
      expect(input?.prompt.text).toContain("Base directory for this skill:")
      expect(input?.promotedSeq).toBeUndefined()
      expect(yield* (yield* SessionStore.Service).messages({ sessionID })).toEqual([])
      expect(yield* operations.skill({ sessionID, id, skill: "different" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.ConflictError,
      )
    }),
  )

  it.live("denied and missing skills do not admit content", () =>
    Effect.gen(function* () {
      yield* setup
      const operations = yield* SessionOperations.Service
      const id = EventBus.ID.create()
      yield* (yield* AgentRegistry.Service).transform((draft) =>
        draft.update(AgentRegistry.defaultID, (agent) => {
          agent.permissions = [{ action: "skill", resource: "*", effect: "deny" }]
        }),
      )
      expect(yield* operations.skill({ sessionID, id, skill: "review" }).pipe(Effect.flip)).toBeInstanceOf(
        PermissionPolicy.DeniedError,
      )
      expect(
        yield* SessionInput.find((yield* Database.Service).db, SessionMessage.ID.make(`msg_${id.slice(4)}`)),
      ).toBeUndefined()
      expect(yield* operations.skill({ sessionID, skill: "missing" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.FailedError,
      )
    }),
  )

  it.live("IDs already used by a different durable input are rejected", () =>
    Effect.gen(function* () {
      yield* setup
      const operations = yield* SessionOperations.Service
      const events = yield* EventBus.Service
      const db = (yield* Database.Service).db
      const id = EventBus.ID.create()
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make(`msg_${id.slice(4)}`),
        sessionID,
        delivery: "steer",
        prompt: Prompt.make({ text: "A different prompt" }),
      })
      expect(yield* operations.skill({ sessionID, id, skill: "review" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.ConflictError,
      )
      expect(yield* operations.shell({ sessionID, id, command: "printf fixture" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionOperations.ConflictError,
      )
      expect((yield* Fixture).calls).toBe(0)
    }),
  )

  it.live("manual compact summarizes short history with auto disabled and keeps full history", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt()
      const store = yield* SessionStore.Service
      const before = yield* store.messages({ sessionID })
      yield* (yield* SessionOperations.Service).compact({ sessionID })
      const fx = yield* Fixture
      expect(fx.requests).toHaveLength(1)
      expect(fx.requests[0].tools).toEqual([])
      expect(fx.requests[0].messages).toHaveLength(1)
      expect(yield* store.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Fixture summary" },
      ])
      expect(yield* store.messages({ sessionID })).toHaveLength(before.length + 1)
      expect((yield* store.messages({ sessionID, order: "asc" }))[0]).toEqual(before[0])
    }),
  )

  it.live("manual compact excludes system updates absorbed by the current context baseline", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventBus.Service
      const db = (yield* Database.Service).db
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: "Obsolete system update",
      })
      yield* db
        .insert(SessionContextEpochTable)
        .values({
          session_id: sessionID,
          baseline: "Current fixture baseline",
          snapshot: {},
          baseline_seq: yield* EventBus.latestSequence(db, sessionID),
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: "Current system update",
      })
      yield* prompt("Current user request")
      const store = yield* SessionStore.Service
      const before = yield* store.messages({ sessionID, order: "asc" })

      yield* (yield* SessionOperations.Service).compact({ sessionID })

      const request = JSON.stringify((yield* Fixture).requests[0].messages)
      expect(request).not.toContain("Obsolete system update")
      expect(request).toContain("Current system update")
      expect(request).toContain("Current user request")
      const after = yield* store.messages({ sessionID, order: "asc" })
      expect(after).toHaveLength(before.length + 1)
      expect(after.slice(0, before.length)).toEqual(before)
    }),
  )

  it.live("compaction partitions a large message without duplicating its prefix or summarizing its retained tail", () =>
    Effect.gen(function* () {
      yield* setup
      const text = `OLDER_CONTEXT_MARKER ${"a".repeat(10_000)} ${"r".repeat(32_000)} RETAINED_TAIL_MARKER`
      yield* prompt(text)
      yield* (yield* SessionOperations.Service).compact({ sessionID })
      const request = JSON.stringify((yield* Fixture).requests[0].messages)
      expect(request.match(/OLDER_CONTEXT_MARKER/g)).toHaveLength(1)
      expect(request).not.toContain("RETAINED_TAIL_MARKER")
      const [checkpoint] = yield* (yield* SessionStore.Service).context(sessionID)
      expect(checkpoint?.type).toBe("compaction")
      if (checkpoint?.type !== "compaction") return
      expect(checkpoint.recent).toHaveLength(32_000)
      expect(checkpoint.recent).toEndWith("RETAINED_TAIL_MARKER")
      expect(checkpoint.recent).not.toContain("OLDER_CONTEXT_MARKER")
      expect(checkpoint.summary.length + checkpoint.recent.length).toBeLessThan(text.length)
    }),
  )

  it.live("a second manual compact summarizes short new exchanges and skips unchanged checkpoints", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt("Original task")
      const operations = yield* SessionOperations.Service
      const store = yield* SessionStore.Service
      yield* operations.compact({ sessionID })
      yield* prompt("NEW_CONSTRAINT: preserve the validation rules")
      yield* operations.compact({ sessionID })
      const fx = yield* Fixture
      expect(fx.requests).toHaveLength(2)
      const request = JSON.stringify(fx.requests[1].messages)
      expect(request).toContain("Fixture summary")
      expect(request).toContain("NEW_CONSTRAINT")
      expect(yield* store.context(sessionID)).toMatchObject([{ type: "compaction", recent: "" }])
      const history = yield* store.messages({ sessionID })
      yield* operations.compact({ sessionID })
      expect(fx.requests).toHaveLength(2)
      expect(yield* store.messages({ sessionID })).toEqual(history)
    }),
  )

  it.live("an empty session needs neither a model nor a provider call", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* SessionOperations.Service).compact({ sessionID })
      expect((yield* Fixture).requests).toEqual([])
      expect((yield* Fixture).modelCalls).toEqual([])
    }),
  )

  it.live("empty and provider-error summaries preserve the prior context", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt()
      const store = yield* SessionStore.Service
      const before = yield* store.context(sessionID)
      const fx = yield* Fixture
      fx.response = Stream.empty
      expect(yield* (yield* SessionOperations.Service).compact({ sessionID }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCompaction.FailedError,
      )
      expect(yield* store.context(sessionID)).toEqual(before)
      fx.response = Stream.fromIterable([
        { type: "text-delta", id: "partial", text: "Partial summary" },
        { type: "provider-error", message: "fixture provider failure" },
      ])
      expect(yield* (yield* SessionOperations.Service).compact({ sessionID }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCompaction.FailedError,
      )
      expect(yield* store.context(sessionID)).toEqual(before)
      fx.response = Stream.fail(
        new LLMError({
          module: "fixture",
          method: "stream",
          reason: new TransportReason({ message: "fixture network failure" }),
        }),
      )
      expect(yield* (yield* SessionOperations.Service).compact({ sessionID }).pipe(Effect.flip)).toBeInstanceOf(
        LLMError,
      )
      expect(yield* store.context(sessionID)).toEqual(before)
    }),
  )

  it.live("manual compact rejects a known insufficient context budget before provider execution", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt()
      const fx = yield* Fixture
      fx.selectedModel = Model.make({
        id: "tiny",
        provider: "fixture",
        route: OpenAIChat.route.with({ limits: { context: 256, output: 128 } }),
      })
      const store = yield* SessionStore.Service
      const before = yield* store.messages({ sessionID })
      expect(yield* (yield* SessionOperations.Service).compact({ sessionID }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCompaction.FailedError,
      )
      expect(fx.requests).toEqual([])
      expect(yield* store.messages({ sessionID })).toEqual(before)
    }),
  )

  it.live("interrupted compaction keeps the prior context and does not admit continuation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt()
      const fx = yield* Fixture
      const started = yield* Deferred.make<void>()
      fx.response = Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)))
      const store = yield* SessionStore.Service
      const before = yield* store.context(sessionID)
      const compact = yield* (yield* SessionOperations.Service)
        .compact({ sessionID, prompt: Prompt.make({ text: "Continue only after success" }) })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(compact)
      expect(Exit.isFailure(yield* Fiber.await(compact))).toBe(true)
      expect(yield* store.context(sessionID)).toEqual(before)
      expect(yield* SessionInput.hasPending((yield* Database.Service).db, sessionID, "steer")).toBe(false)
    }),
  )

  it.live("successful compact records an optional continuation without starting a provider turn itself", () =>
    Effect.gen(function* () {
      yield* setup
      yield* prompt()
      yield* (yield* SessionOperations.Service).compact({
        sessionID,
        prompt: Prompt.make({ text: "Continue after summary" }),
      })
      expect(yield* SessionInput.hasPending((yield* Database.Service).db, sessionID, "steer")).toBe(true)
      expect((yield* Fixture).requests).toHaveLength(1)
    }),
  )
})
