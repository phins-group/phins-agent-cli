import { describe, expect } from "bun:test"
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Scope,
  Stream,
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import * as Promotion from "../../src/execution/control/promotion"
import * as Receiver from "../../src/execution/control/receiver"
import { NodeCommandRunner } from "../../src/execution/commands/runner"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { PermissionOrigin } from "../../src/security/permissions/origin"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionEvent } from "../../src/contracts/events/session"
import { SessionMessage } from "../../src/sessions/messages/service"
import { SessionRunState } from "../../src/sessions/run/state"
import { VerificationReceiptTable } from "../../src/storage/tables/sessions"
import { SessionRunner } from "../../src/sessions/run/loop"
import { Snapshot } from "../../src/workspace/repository/snapshot"
import { Prompt } from "../../src/contracts/session/prompt"
import { Tool } from "../../src/tools/definition"
import { ToolRegistry } from "../../src/tools/registry"
import { LLMEvent } from "../../src/inference/api"
import * as control from "../fixture/node-control"
import { answer, fixture, model } from "../fixture/node-command-runner"
import { testEffect } from "../lib/effect"

const target = {
  sessionID: control.sessionID,
  messageID: SessionMessage.ID.make(`msg_node_${control.expected.attempt.id}`),
}
const state = Database.Service.use(({ db }) =>
  SessionRunState.load(db, target.sessionID),
)
const prepare = (node = control.node()) =>
  Effect.gen(function* () {
    yield* control.setup
    yield* Receiver.receivePrompt(node, control.expected)
    return yield* Promotion.startPrompt(node, target)
  })
const prepareOverflow = (
  current: ReturnType<typeof fixture>,
  node = control.node(),
) =>
  Effect.gen(function* () {
    yield* control.setup
    yield* (yield* EventBus.Service).publish(SessionEvent.Prompted, {
      sessionID: target.sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(1),
      prompt: Prompt.make({ text: "EARLIER_HISTORY ".repeat(3_000) }),
      delivery: "queue",
    })
    current.resolve(() =>
      Effect.succeed(
        model.route
          .with({ limits: { context: 100_000, output: 128 } })
          .model({ id: "fixture" }),
      ),
    )
    yield* Receiver.receivePrompt(node, control.expected)
    return yield* Promotion.startPrompt(node, target)
  })
const failed = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.exit,
    Effect.tap((exit) => Effect.sync(() => expect(exit._tag).toBe("Failure"))),
  )
type Services = Layer.Success<ReturnType<typeof fixture>["layer"]> | Scope.Scope
const scenario = <A, E>(
  name: string,
  body: (current: ReturnType<typeof fixture>) => Effect.Effect<A, E, Services>,
) => {
  const current = fixture()
  return testEffect(current.layer).effect(name, () => body(current))
}
const toolCall = (name: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call_1", name, input: {} }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

describe("native command-scoped execution", () => {
  for (const mode of ["tokens", "time", "turns"] as const) {
    const current = fixture(mode === "tokens" ? { max_tokens: 1 }
      : mode === "time" ? { max_duration_ms: 50 } : { max_turns: 1 })
    testEffect(current.layer).effect(`finite ${mode} budget settles a remote run without replay`, () =>
      Effect.gen(function* () {
        const node = control.node()
        const owner = yield* prepare(node)
        if (mode === "time") current.reply(() => Stream.never)
        if (mode === "turns") {
          yield* (yield* ToolRegistry.Service).register({ fixture_read: Tool.withOriginPermission(Tool.make({
            description: "fixture", input: Schema.Struct({}), output: Schema.String,
            execute: () => Effect.succeed("local fixture value"),
          })) })
          current.reply(() => Stream.fromIterable(toolCall("fixture_read")))
        }
        const work = yield* Effect.forkChild(failed(current.run(node, owner)))
        if (mode === "time") {
          while (!current.requests.length) yield* Effect.yieldNow
          yield* TestClock.adjust("100 millis")
        }
        yield* Fiber.join(work)
        expect(yield* state).toMatchObject({ status: "terminal-failure", inputID: owner.messageID })
        expect(current.requests.length).toBe(mode === "tokens" ? 0 : 1)
        yield* failed(current.run(node, owner))
        expect(current.requests.length).toBe(mode === "tokens" ? 0 : 1)
      }),
    )
  }

  scenario(
    "interruption after publication enters runner cleanup before unmasking",
    (current) =>
      Effect.gen(function* () {
        yield* control.setup
        yield* Receiver.receivePrompt(control.node(), control.expected)
        const events = yield* EventBus.Service
        const committed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const promotion = yield* Effect.forkChild(
          Promotion.startPrompt(control.node(), target, (owner) =>
            current.run(control.node(), owner),
          ).pipe(
            Effect.provideService(EventBus.Service, {
              ...events,
              publishBatch: (batch) =>
                events.publishBatch(batch).pipe(
                  Effect.tap(() => Deferred.succeed(committed, undefined)),
                  Effect.tap(() => Deferred.await(release)),
                ),
            }),
          ),
        )
        yield* Deferred.await(committed)
        expect(yield* state).toMatchObject({
          status: "busy",
          inputID: target.messageID,
        })
        const stop = yield* Effect.forkChild(Fiber.interrupt(promotion), {
          startImmediately: true,
        })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stop)
        expect((yield* Fiber.await(promotion))._tag).toBe("Failure")
        expect(current.requests).toEqual([])
        expect(current.captures()).toBe(0)
        expect(yield* state).toMatchObject({
          status: "interrupted",
          inputID: target.messageID,
        })
        expect(yield* control.counts).toEqual({
          inputs: 1,
          origins: 1,
          events: 4,
        })
      }),
  )

  scenario(
    "executes the promoted owner, keeps its source scope and settles it",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        yield* current.run(control.node(), owner)
        expect(current.requests).toHaveLength(1)
        expect(JSON.stringify(current.requests[0].messages)).toContain(
          "PRIVATE_FIXTURE_PROMPT",
        )
        expect(current.scopes[0]).toHaveLength(1)
        expect(current.scopes[0][0].sessionID).toBe(target.sessionID)
        expect(yield* PermissionOrigin.capture).toEqual([])
        expect(yield* state).toMatchObject({
          status: "idle",
          runID: owner.runID,
          inputID: owner.messageID,
        })
        yield* failed(current.run(control.node(), owner))
        expect(current.requests).toHaveLength(1)
      }),
  )

  scenario("never drains pending local or other native inputs", (current) =>
    Effect.gen(function* () {
      yield* control.setup
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      yield* SessionInput.admit(db, events, {
        sessionID: target.sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "LOCAL_PENDING" }),
        delivery: "steer",
      })
      yield* Receiver.receivePrompt(control.node(), control.expected)
      const second = control.proof("OTHER_COMMAND")
      const id = "80000000-0000-4000-8000-000000000017"
      const proof = {
        ...second,
        attempt: { ...second.attempt, id },
        command: { ...second.command, id },
      }
      const node = control.node(async () => proof)
      yield* Receiver.receivePrompt(node, {
        ...control.expected,
        attempt: { ...control.expected.attempt, id },
      })
      const owner = yield* Promotion.startPrompt(control.node(), target)
      yield* current.run(control.node(), owner)
      expect(current.requests).toHaveLength(1)
      expect(JSON.stringify(current.requests)).not.toContain("LOCAL_PENDING")
      expect(JSON.stringify(current.requests)).not.toContain("OTHER_COMMAND")
      expect(
        yield* SessionInput.hasPending(db, target.sessionID, "steer"),
      ).toBe(true)
      const other = yield* SessionInput.find(
        db,
        SessionMessage.ID.make(`msg_node_${id}`),
      )
      expect(other?.promotedSeq).toBeUndefined()
    }),
  )

  scenario(
    "refuses local resume even while a native owner is prepared",
    (current) =>
      Effect.gen(function* () {
        yield* prepare()
        yield* failed(
          SessionRunner.Service.use((runner) =>
            runner.run({ sessionID: target.sessionID, force: true }),
          ),
        )
        expect(current.requests).toEqual([])
      }),
  )

  scenario(
    "denies a changed run or input without settling the actual owner",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        yield* failed(
          current.run(control.node(), {
            ...owner,
            runID: SessionRunState.ID.create(),
          }),
        )
        yield* failed(
          current.run(control.node(), {
            ...owner,
            messageID: SessionMessage.ID.create(),
          }),
        )
        expect(current.requests).toEqual([])
        expect(yield* state).toMatchObject({
          status: "busy",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "does not accept caller-supplied authority or a nested remote scope",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        yield* failed(
          current.run(control.node(), {
            ...owner,
            grant: "caller",
          } as NodeCommandRunner.Target),
        )
        yield* failed(
          PermissionOrigin.restrict(
            {
              sessionID: target.sessionID,
              rules: [],
              valid: Effect.succeed(true),
            },
            current.run(control.node(), owner),
          ),
        )
        expect(current.requests).toEqual([])
        expect(yield* state).toMatchObject({
          status: "busy",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "revocation before execution settles the exact owner without provider IO",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        yield* failed(
          current.run(
            control.node(async () => {
              throw new Error("revoked")
            }),
            owner,
          ),
        )
        expect(current.requests).toEqual([])
        expect(current.captures()).toBe(0)
        expect(yield* state).toMatchObject({
          status: "terminal-failure",
          runID: owner.runID,
        })
      }),
  )

  scenario("rechecks authorization after model resolution", (current) =>
    Effect.gen(function* () {
      let valid = true
      const node = control.node(async () => {
        if (!valid) throw new Error("revoked")
        return control.proof()
      })
      const owner = yield* prepare(node)
      current.resolve(() =>
        Effect.sync(() => {
          valid = false
          return model
        }),
      )
      yield* failed(current.run(node, owner))
      expect(current.requests).toEqual([])
      expect(current.captures()).toBe(1)
    }),
  )

  scenario(
    "qualified tools inherit the original ceiling across continuation",
    (current) =>
      Effect.gen(function* () {
        const node = control.node(async () => ({
          ...control.proof(),
          rules: [{ action: "fixture_read", resource: "*", effect: "allow" }],
        }))
        const owner = yield* prepare(node)
        const permission = yield* PermissionPolicy.Service
        const registry = yield* ToolRegistry.Service
        let executions = 0
        yield* registry.register({
          fixture_read: Tool.withOriginPermission(
            Tool.make({
              description: "fixture",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: (_, context) =>
                permission
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    action: "fixture_read",
                    resources: ["*"],
                    source: {
                      type: "tool",
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      () => new Tool.Failure({ message: "denied" }),
                    ),
                    Effect.andThen(
                      Effect.sync(() => {
                        executions++
                        return "fixture value"
                      }),
                    ),
                  ),
            }),
          ),
        })
        current.reply(() =>
          Stream.fromIterable(
            current.requests.length === 1 ? toolCall("fixture_read") : answer,
          ),
        )
        yield* current.run(node, owner)
        expect(executions).toBe(1)
        expect(current.requests).toHaveLength(2)
        expect(current.scopes.map((scope) => scope.length)).toEqual([1, 1])
        expect(JSON.stringify(current.requests[1].messages)).toContain(
          "fixture value",
        )
        expect(yield* state).toMatchObject({
          status: "idle",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "unqualified application tools are neither advertised nor executed",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        let executions = 0
        yield* (yield* ToolRegistry.Service).register({
          unsafe: Tool.make({
            description: "local only",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => {
                executions++
                return "unsafe"
              }),
          }),
        })
        current.reply(() =>
          Stream.fromIterable(
            current.requests.length === 1 ? toolCall("unsafe") : answer,
          ),
        )
        yield* current.run(control.node(), owner)
        expect(executions).toBe(0)
        expect(current.requests).toHaveLength(2)
        expect(current.requests[0].tools).toEqual([])
        expect(JSON.stringify(current.requests[1].messages)).toContain(
          "Tool is not available",
        )
      }),
  )

  scenario(
    "does not use a local allow rule to widen an empty remote ceiling",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        const permission = yield* PermissionPolicy.Service
        let executions = 0
        yield* (yield* ToolRegistry.Service).register({
          fixture_write: Tool.withOriginPermission(
            Tool.make({
              description: "fixture",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: (_, context) =>
                permission
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    action: "edit",
                    resources: ["file.txt"],
                    source: {
                      type: "tool",
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      () => new Tool.Failure({ message: "denied" }),
                    ),
                    Effect.andThen(
                      Effect.sync(() => {
                        executions++
                        return "unsafe"
                      }),
                    ),
                  ),
            }),
          ),
        })
        current.reply(() =>
          Stream.fromIterable(
            current.requests.length === 1 ? toolCall("fixture_write") : answer,
          ),
        )
        yield* current.run(control.node(), owner)
        expect(executions).toBe(0)
        expect(current.requests).toHaveLength(2)
        expect(JSON.stringify(current.requests[1].messages)).toContain("denied")
      }),
  )

  scenario(
    "blocks native hosted tools and unqualified model body overrides",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        current.resolve(() =>
          Effect.succeed(
            model.route
              .with({ http: { body: { tools: [{ type: "web_search" }] } } })
              .model({ id: "fixture" }),
          ),
        )
        yield* failed(current.run(control.node(), owner))
        expect(current.requests).toEqual([])
        expect(yield* state).toMatchObject({ status: "terminal-failure" })
      }),
  )

  scenario(
    "rejects an unexpected provider-executed tool without local dispatch",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        current.reply(() =>
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "hosted",
              name: "web_search",
              input: {},
              providerExecuted: true,
            }),
          ]),
        )
        yield* failed(current.run(control.node(), owner))
        expect(yield* state).toMatchObject({ status: "terminal-failure" })
      }),
  )

  scenario(
    "overflow summarization and its continuation keep the original command ceiling",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepareOverflow(current)
        current.reply(() =>
          current.requests.length === 1
            ? Stream.fromIterable([
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.providerError({
                  message: "fixture overflow",
                  classification: "context-overflow",
                }),
              ]).pipe(Stream.concat(Stream.never))
            : Stream.fromIterable(answer),
        )
        yield* current.run(control.node(), owner)
        expect(current.requests).toHaveLength(3)
        expect(current.scopes.map((scope) => scope.length)).toEqual([1, 1, 1])
        expect(current.requests[1].tools).toEqual([])
        expect(JSON.stringify(current.requests[1].messages)).toContain(
          "EARLIER_HISTORY",
        )
        expect(JSON.stringify(current.requests[2].messages)).toContain(
          "PRIVATE_FIXTURE_PROMPT",
        )
        expect(yield* state).toMatchObject({
          status: "idle",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "revocation after overflow prevents even the summarization provider call",
    (current) =>
      Effect.gen(function* () {
        let valid = true
        const node = control.node(async () => {
          if (!valid) throw new Error("revoked")
          return control.proof()
        })
        const owner = yield* prepareOverflow(current, node)
        current.reply(() =>
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.providerError({
              message: "fixture overflow",
              classification: "context-overflow",
            }),
          ]).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                valid = false
              }),
            ),
          ),
        )
        yield* failed(current.run(node, owner))
        expect(current.requests).toHaveLength(1)
        expect(yield* state).toMatchObject({
          status: "terminal-failure",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "observes only the active Location and records changes as unverified, never executes a verifier",
    (current) =>
      Effect.gen(function* () {
        const owner = yield* prepare()
        const ids = ["drain-start", "turn-start", "turn-end", "drain-end"].map(
          (id) => Snapshot.ID.make(id),
        )
        current.observation(() => Effect.sync(() => ids.shift()))
        yield* current.run(control.node(), owner)
        expect(ids).toHaveLength(0)
        const { db } = yield* Database.Service
        const receipts = yield* db
          .select()
          .from(VerificationReceiptTable)
          .all()
          .pipe(Effect.orDie)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({
          subject_snapshot: "drain-end",
          verdict: "missing",
        })
        expect(yield* state).toMatchObject({
          status: "idle",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "watchdog cancels a blocked qualified tool without continuing the provider",
    (current) =>
      Effect.gen(function* () {
        let valid = true
        let cleaned = false
        const started = yield* Deferred.make<void>()
        const node = control.node(async () => {
          if (!valid) throw new Error("revoked")
          return {
            ...control.proof(),
            rules: [{ action: "fixture_wait", resource: "*", effect: "allow" }],
          }
        })
        const owner = yield* prepare(node)
        const permission = yield* PermissionPolicy.Service
        yield* (yield* ToolRegistry.Service).register({
          fixture_wait: Tool.withOriginPermission(
            Tool.make({
              description: "fixture",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: (_, context) =>
                permission
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    action: "fixture_wait",
                    resources: ["*"],
                    source: {
                      type: "tool",
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      () => new Tool.Failure({ message: "denied" }),
                    ),
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sync(() => {
                        cleaned = true
                      }),
                    ),
                  ),
            }),
          ),
        })
        current.reply(() => Stream.fromIterable(toolCall("fixture_wait")))
        const fiber = yield* Effect.forkChild(
          current.run(node, owner).pipe(Effect.exit),
        )
        yield* Deferred.await(started)
        valid = false
        yield* TestClock.adjust("1 second")
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
        expect(cleaned).toBe(true)
        expect(current.requests).toHaveLength(1)
        expect(yield* state).toMatchObject({
          status: "terminal-failure",
          runID: owner.runID,
        })
      }),
  )

  scenario(
    "watchdog cancels a blocked provider stream after revocation",
    (current) =>
      Effect.gen(function* () {
        let valid = true
        let cleaned = false
        const started = yield* Deferred.make<void>()
        const node = control.node(async () => {
          if (!valid) throw new Error("revoked")
          return control.proof()
        })
        const owner = yield* prepare(node)
        current.reply(() =>
          Stream.unwrap(
            Deferred.succeed(started, undefined).pipe(
              Effect.as(
                Stream.never.pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      cleaned = true
                    }),
                  ),
                ),
              ),
            ),
          ),
        )
        const fiber = yield* Effect.forkChild(
          current.run(node, owner).pipe(Effect.exit),
        )
        yield* Deferred.await(started)
        valid = false
        yield* TestClock.adjust("1 second")
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
        expect(cleaned).toBe(true)
        expect(yield* state).toMatchObject({
          status: "terminal-failure",
          runID: owner.runID,
        })
      }),
  )
})
