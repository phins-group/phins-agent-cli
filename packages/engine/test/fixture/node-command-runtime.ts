import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AgentRegistry } from "../../src/agents/registry"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { ServiceGraph } from "../../src/runtime/effect/service-graph"
import { Location } from "../../src/workspace/location"
import { LocationServiceRegistry } from "../../src/runtime/services"
import { NodeCommandExecution } from "../../src/execution/commands/executor"
import * as Promotion from "../../src/execution/control/promotion"
import * as Receiver from "../../src/execution/control/receiver"
import type * as ControlCommand from "../../src/execution/control/command"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionExecution } from "../../src/sessions/run/execution"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionRunState } from "../../src/sessions/run/state"
import { SessionRuntimeLocal } from "../../src/sessions/runtime"
import { expected as fixedExpected, identity, proof } from "./node-control"

// Actual runtime, coordinator, model resolver, HTTP/SSE and shipped tool leaves.
// All Platform proofs and provider data below are fixtures, never real accounts.
type Body = { model: string; messages: unknown[]; tools?: unknown[] }
const calls: Body[] = []
const held: { finish: () => void; canceled: boolean }[] = []
let mode: "held" | "tools" | "answer" = "held"
let toolRound = 0
let signalStarted: () => void = () => {}
const encoder = new TextEncoder()
const sse = (value: unknown) =>
  encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key")
    const body = (await request.json()) as Body
    assert.equal(body.model, "fixture")
    assert.ok(!JSON.stringify(body.messages).includes("LOCAL_PENDING"))
    calls.push(body)
    const chunk = (delta: object, finish_reason: string | null = null) => ({
      id: "chatcmpl_fixture",
      choices: [{ delta, finish_reason }],
    })
    const call = { finish: () => {}, canceled: false }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        call.finish = () => {
          controller.enqueue(sse(chunk({ content: "Fixture complete" })))
          controller.enqueue(sse(chunk({}, "stop")))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        }
        if (mode === "held") {
          held.push(call)
          controller.enqueue(
            sse(chunk({ role: "assistant", content: "Fixture running" })),
          )
          signalStarted()
          return
        }
        if (mode === "tools" && toolRound++ < 2) {
          const name = toolRound === 1 ? "read" : "write"
          const input =
            name === "read"
              ? { path: "fixture.txt" }
              : { path: "fixture.txt", content: "MUST_NOT_WRITE" }
          controller.enqueue(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `tool_${toolRound}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(input) },
                  },
                ],
              }),
            ),
          )
          controller.enqueue(sse(chunk({}, "tool_calls")))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } else call.finish()
      },
      cancel() {
        call.canceled = true
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

try {
  await fs.writeFile(
    path.join(process.cwd(), "fixture.txt"),
    "INTERNAL_FIXTURE",
  )
  await fs.writeFile(
    path.join(process.cwd(), "phins.json"),
    JSON.stringify({
      model: "fixture/fixture",
      snapshots: false,
      providers: {
        fixture: {
          api: {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${provider.url}v1`,
          },
          request: { body: { apiKey: "fixture-key" } },
          models: {
            fixture: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 128 },
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  await Effect.gen(function* () {
    const directory = AbsolutePath.make(process.cwd())
    const ref = Location.Ref.make({ directory })
    const sessions = yield* SessionManager.Service
    const commands = yield* NodeCommandExecution.Service
    const execution = yield* SessionExecution.Service
    const { db } = yield* Database.Service
    const session = yield* sessions.create({ location: ref })
    yield* AgentRegistry.Service.use((agents) =>
      agents.transform((draft) =>
        draft.update(AgentRegistry.defaultID, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        }),
      ),
    ).pipe(Effect.provide(LocationServiceRegistry.get(ref)))
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: { text: "LOCAL_PENDING" },
      delivery: "steer",
      resume: false,
    })
    let authorized = true
    const native = (number: number, text: string) => {
      const id = `80000000-0000-4000-8000-${String(number).padStart(12, "0")}`
      const expected: ControlCommand.Expected = {
        ...fixedExpected,
        scope: {
          ...proof().scope,
          projectId: session.projectID,
          targetSessionId: session.id,
          directory,
        },
        attempt: { ...proof().attempt, id },
      }
      const node: Receiver.Node = {
        identity,
        verifyCommand: async () => {
          if (!authorized) throw new Error("Fixture grant revoked")
          return {
            ...proof(text),
            ...expected,
            rules: [
              { action: "read", resource: "fixture.txt", effect: "allow" },
            ],
            command: {
              ...proof(text).command,
              id,
              payloadHash: createHash("sha256")
                .update(JSON.stringify({ text }))
                .digest("hex"),
            },
          }
        },
      }
      return { node, expected }
    }
    const admit = (input: ReturnType<typeof native>) =>
      Receiver.receivePrompt(input.node, input.expected).pipe(
        Effect.provide(LocationServiceRegistry.get(ref)),
      )
    const runState = SessionRunState.load(db, session.id)
    const fail = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => assert.equal(exit._tag, "Failure")),
        ),
      )

    const first = native(71, "FIRST_NATIVE")
    const input = yield* admit(first)
    const started = yield* Deferred.make<void>()
    signalStarted = () => {
      Effect.runSync(Deferred.succeed(started, undefined))
    }
    const client = yield* Effect.forkChild(
      commands.start(first.node, {
        sessionID: session.id,
        messageID: input.id,
      }),
    )
    yield* Deferred.await(started)
    assert.equal((yield* runState)?.status, "busy")
    assert.equal(typeof execution.captureLocalInterrupt, "function")
    assert.equal(yield* execution.captureLocalInterrupt!(session.id), undefined)
    // Detach kills only the caller's join, not the service-owned execution.
    yield* Fiber.interrupt(client)
    assert.equal((yield* runState)?.status, "busy")
    assert.equal(held[0].canceled, false)
    const duplicate = yield* fail(
      commands.start(first.node, {
        sessionID: session.id,
        messageID: input.id,
      }),
    )
    assert.ok(
      Exit.isFailure(duplicate) &&
        Cause.pretty(duplicate.cause).includes("Busy"),
    )
    held[0].finish()
    yield* sessions.wait(session.id)
    assert.equal((yield* runState)?.status, "idle")
    assert.equal(yield* SessionInput.hasPending(db, session.id, "steer"), true)

    // Actual shipped read/write leaves, with local allow and a read-only grant.
    mode = "tools"
    const second = native(72, "READ_ONLY_NATIVE")
    const secondInput = yield* admit(second)
    yield* commands.start(second.node, {
      sessionID: session.id,
      messageID: secondInput.id,
    })
    assert.equal(toolRound, 3)
    assert.equal(
      yield* Effect.promise(() =>
        fs.readFile(path.join(directory, "fixture.txt"), "utf8"),
      ),
      "INTERNAL_FIXTURE",
    )
    const messages = yield* sessions.messages({ sessionID: session.id })
    assert.ok(JSON.stringify(messages).includes("INTERNAL_FIXTURE"))
    assert.ok(!JSON.stringify(messages).includes("LOCAL_PENDING"))
    assert.equal((yield* runState)?.status, "idle")
    const beforeReplay = calls.length
    yield* fail(
      commands.start(second.node, {
        sessionID: session.id,
        messageID: secondInput.id,
      }),
    )
    assert.equal(calls.length, beforeReplay)

    // Native explicit continuation of a prepared run, no new owner or grant.
    mode = "answer"
    const third = native(73, "RESUME_NATIVE")
    const thirdInput = yield* admit(third)
    const owner = yield* Promotion.startPrompt(third.node, {
      sessionID: session.id,
      messageID: thirdInput.id,
    }).pipe(Effect.provide(LocationServiceRegistry.get(ref)))
    yield* commands.resume(third.node, owner)
    assert.equal((yield* runState)?.runID, owner.runID)
    assert.equal((yield* runState)?.status, "idle")

    // Revocation cancels an open HTTP stream and does not drain local work.
    mode = "held"
    const fourth = native(74, "REVOKE_NATIVE")
    const fourthInput = yield* admit(fourth)
    const revokedStarted = yield* Deferred.make<void>()
    signalStarted = () => {
      Effect.runSync(Deferred.succeed(revokedStarted, undefined))
    }
    let revokedMarked = false
    const revoked = yield* Effect.forkChild(
      commands
        .start(fourth.node, {
          sessionID: session.id,
          messageID: fourthInput.id,
        }, undefined, () => { revokedMarked = true })
        .pipe(Effect.exit),
    )
    yield* Deferred.await(revokedStarted)
    let observed = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const messages = yield* sessions.messages({
        sessionID: session.id,
        order: "asc",
      })
      const last = messages.at(-1)
      if (last?.type === "assistant") {
        observed = true
        break
      }
      yield* Effect.sleep("5 millis")
    }
    if (!observed) {
      yield* execution.interrupt(session.id)
      assert.fail("Fixture response was not observed")
    }
    authorized = false
    assert.equal((yield* Fiber.join(revoked))._tag, "Failure")
    yield* sessions.wait(session.id)
    assert.equal((yield* runState)?.status, "terminal-failure")
    for (let attempt = 0; attempt < 100 && !held[1].canceled; attempt++)
      yield* Effect.sleep("5 millis")
    assert.equal(held[1].canceled, true)
    assert.equal(revokedMarked, false, "Lost authority is not an explicit user Stop")
    assert.equal(yield* SessionInput.hasPending(db, session.id, "steer"), true)

    // The exact started/resumed invocation receives user intent before its
    // interrupt settles, while a stale captured owner cannot mark a successor.
    authorized = true
    const marked: string[] = []
    let stale: Effect.Effect<boolean> | undefined
    const beforeStops = calls.length
    for (const resume of [false, true]) {
      const ready = yield* Deferred.make<void, Error>()
      signalStarted = () => { Effect.runSync(Deferred.succeed(ready, undefined)) }
      const stopping = native(resume ? 76 : 75, "EXPLICIT_LOCAL_STOP")
      const stopInput = yield* admit(stopping)
      const target = { sessionID: session.id, messageID: stopInput.id }
      // A stopped run is terminal, not resumable. Prepare a separate admitted
      // owner as a crashed process would have left it before testing Resume.
      const owner = resume ? yield* Promotion.startPrompt(stopping.node, target)
        .pipe(Effect.provide(LocationServiceRegistry.get(ref))) : undefined
      const work = resume
        ? commands.resume(stopping.node, owner!, undefined,
            () => { marked.push("resume") })
        : commands.start(stopping.node, target, (stop) => { stale = stop },
            () => { marked.push("start") })
      const running = yield* work.pipe(Effect.exit, Effect.tap((exit) =>
        Deferred.fail(ready, new Error(exit._tag === "Failure"
          ? Cause.pretty(exit.cause) : "Fixture invocation ended before provider readiness")),
      ), Effect.forkChild)
      yield* Deferred.await(ready)
      if (resume) {
        assert.equal(yield* stale!, false)
        assert.deepEqual(marked, ["start"])
      }
      yield* execution.interrupt(session.id, { requested: true })
      assert.equal((yield* Fiber.join(running))._tag, "Failure")
      assert.equal((yield* runState)?.status, "interrupted")
      yield* execution.interrupt(session.id, { requested: true })
    }
    assert.deepEqual(marked, ["start", "resume"])
    assert.equal(calls.length, beforeStops + 2)

    // A different local Session still works with the ordinary public runner.
    authorized = true
    mode = "answer"
    const local = yield* sessions.create({ location: ref })
    yield* sessions.prompt({
      sessionID: local.id,
      prompt: { text: "OTHER_LOCAL_SESSION" },
    })
    yield* sessions.wait(local.id)
    assert.equal((yield* SessionRunState.load(db, local.id))?.status, "idle")
    yield* execution.awaitIdle
    console.log(
      "native-runtime: detach, ownership, tools, resume, revocation and local isolation passed",
    )
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServiceGraph.build(
        ServiceGraph.group([
          SessionRuntimeLocal.graph,
          Database.node,
          EventBus.node,
        ]),
      ),
    ),
    Effect.runPromise,
  )
} finally {
  provider.stop(true)
}
