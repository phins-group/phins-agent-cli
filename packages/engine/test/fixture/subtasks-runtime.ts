import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionExecution } from "../../src/sessions/run/execution"
import { SessionRuntimeLocal } from "../../src/sessions/runtime"
import { Prompt } from "../../src/contracts/session/prompt"
import { SessionRunState } from "../../src/sessions/run/state"
import { AgentRegistry } from "../../src/agents/registry"

let mode: "complete" | "stop" | "ceiling" | "budget" | "nested" | "limit" =
  "complete"
let parentCalls = 0,
  childCalls = 0
const ready = Deferred.makeUnsafe<void>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const child = body.messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("CHILD_TASK_PROMPT"),
    )
    if (child) childCalls++
    else parentCalls++
    if (child && mode === "stop") {
      server.timeout(request, 0)
      Deferred.doneUnsafe(ready, Effect.void)
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    const task =
      (!child && parentCalls <= (mode === "limit" ? 5 : 1)) ||
      (child && mode === "nested" && childCalls === 1)
    const shell = child && mode === "ceiling" && childCalls === 1
    const call = task
      ? {
          name: "task",
          arguments: JSON.stringify({
            description: `Inspect local fixture ${parentCalls}`,
            prompt: `CHILD_TASK_PROMPT ${parentCalls}`,
            subagent_type: "general",
          }),
        }
      : shell
        ? {
            name: "bash",
            arguments: JSON.stringify({
              command: "touch forbidden-child-write",
            }),
          }
        : undefined
    const chunks = [
      { delta: { role: "assistant" }, finish_reason: null },
      {
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: task ? "delegate" : "forbidden",
                  type: "function",
                  function: call,
                },
              ],
            }
          : { content: child ? "CHILD_TASK_RESULT" : "PARENT_TASK_RESULT" },
        finish_reason: null,
      },
      { delta: {}, finish_reason: call ? "tool_calls" : "stop" },
    ]
    return new Response(
      chunks
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "fixture", choices: [choice] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  for (const name of [
    "complete",
    "stop",
    "ceiling",
    "budget",
    "nested",
    "limit",
  ] as const) {
    mode = name
    parentCalls = childCalls = 0
    const directory = path.join(process.cwd(), name)
    await fs.mkdir(directory)
    await fs.writeFile(
      path.join(directory, "phins.json"),
      JSON.stringify({
        model: "fixture/fixture",
        snapshots: false,
        run_budget: { max_turns: name === "budget" ? 2 : 10 },
        providers: {
          fixture: {
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `${server.url}v1`,
            },
            models: {
              fixture: {
                capabilities: {
                  tools: true,
                  input: ["text"],
                  output: ["text"],
                },
                limit: { context: 100000, output: 256 },
              },
            },
          },
        },
      }),
    )
    await Effect.gen(function* () {
      const sessions = yield* SessionManager.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({
        location: Location.Ref.make({
          directory: AbsolutePath.make(directory),
        }),
        agent: name === "ceiling" ? AgentRegistry.ID.make("plan") : undefined,
      })
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: Prompt.make({ text: "Delegate fixture task" }),
        resume: false,
      })
      const run = yield* execution.resume(session.id).pipe(Effect.forkChild)
      if (name === "stop") {
        yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
        yield* execution.interrupt(session.id)
      }
      yield* Fiber.await(run)
      const all = yield* sessions.list({
        directory: AbsolutePath.make(directory),
      })
      const children = all.filter((item) => item.parentID === session.id)
      assert.equal(
        children.length,
        name === "limit" ? 4 : 1,
        `${name}: bounded canonical children`,
      )
      assert.equal(
        all.filter((item) => item.parentID).length,
        children.length,
        "Delegation cannot recursively create grandchildren",
      )
      const child = children[0]!
      const childState = yield* SessionRunState.load(db, child.id).pipe(
        Effect.orDie,
      )
      const parentState = yield* SessionRunState.load(db, session.id).pipe(
        Effect.orDie,
      )
      if (name === "stop") {
        assert.equal(childState?.status, "interrupted")
        assert.equal(parentState?.status, "interrupted")
      } else {
        assert.equal(childState?.status, "idle")
        const messages = yield* sessions.messages({ sessionID: child.id })
        assert.ok(JSON.stringify(messages).includes("CHILD_TASK_RESULT"))
        assert.equal(
          parentState?.status,
          name === "budget" ? "terminal-failure" : "idle",
        )
      }
      if (name === "ceiling")
        assert.equal(
          yield* Effect.promise(() =>
            Bun.file(path.join(directory, "forbidden-child-write")).exists(),
          ),
          false,
        )
      if (name === "budget")
        assert.equal(
          parentCalls + childCalls,
          2,
          "child consumes the parent's run budget",
        )
      yield* execution.awaitIdle.pipe(Effect.timeout("1 second"))
    }).pipe(
      Effect.provide(SessionRuntimeLocal.defaultLayer),
      Effect.provide(Database.defaultLayer),
      Effect.provide(EventBus.defaultLayer),
      Effect.scoped,
      Effect.runPromise,
    )
  }
  console.log(
    "subtasks: canonical history, permission ceiling, Stop and shared budget passed",
  )
} finally {
  server.stop(true)
}
