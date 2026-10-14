import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionExecution } from "../../src/sessions/run/execution"
import { SessionRuntimeLocal } from "../../src/sessions/runtime"
import { SessionMessage } from "../../src/sessions/messages/service"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionCommandTable } from "../../src/storage/tables/commands"
import { SessionRunState } from "../../src/sessions/run/state"
import { AgentRegistry } from "../../src/agents/registry"

let calls = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    calls++
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const oversized = body.messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("BOUND_CHILD "),
    )
    const chunks = [
      {
        delta: {
          role: "assistant",
          content: oversized ? "😀".repeat(16_000) : "COMMAND_RESULT",
        },
        finish_reason: null,
      },
      { delta: {}, finish_reason: "stop" },
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
  await fs.writeFile(
    path.join(process.cwd(), "phins.json"),
    JSON.stringify({
      model: "fixture/fixture",
      snapshots: false,
      agents: {
        build: {
          permissions: [{ action: "bash", resource: "*", effect: "allow" }],
        },
      },
      providers: {
        fixture: {
          api: {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${server.url}v1`,
          },
          models: {
            fixture: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 256 },
            },
          },
        },
      },
      commands: {
        plain: { template: "Review $1 and $2" },
        shell: {
          template:
            "Output !`printf x >> command-count; printf expanded-value`",
        },
        child: {
          template: "Inspect $ARGUMENTS",
          agent: "general",
          subtask: true,
        },
        oversized: {
          template: `BOUND_CHILD ${"😀".repeat(20_000)}`,
          agent: "general",
          subtask: true,
        },
        stopped: {
          template:
            "First !`touch command-started; sleep 20` then !`touch forbidden-after-stop`",
        },
        denied: { template: "!`touch forbidden-command-write`", agent: "plan" },
      },
    }),
  )
  await Effect.gen(function* () {
    const sessions = yield* SessionManager.Service
    const execution = yield* SessionExecution.Service
    const { db } = yield* Database.Service
    const location = Location.Ref.make({
      directory: AbsolutePath.make(process.cwd()),
    })
    const session = yield* sessions.create({ location })
    const plain = {
      id: SessionMessage.ID.create(),
      sessionID: session.id,
      command: "plain",
      arguments: 'one "two words" three',
      resume: false,
    }
    yield* sessions.command(plain)
    assert.equal(calls, 0)
    assert.equal(
      (yield* SessionInput.find(db, plain.id))?.prompt.text,
      "Review one and two words three",
    )
    yield* sessions.command(plain)
    assert.equal(
      (yield* sessions
        .command({ ...plain, arguments: "different" })
        .pipe(Effect.exit))._tag,
      "Failure",
    )
    const selected = (yield* sessions.get(session.id)).agent
    for (const command of ["shell", "child"])
      assert.equal(
        (yield* sessions
          .command({
            id: SessionMessage.ID.create(),
            sessionID: session.id,
            command,
            resume: false,
            agent: AgentRegistry.ID.make("plan"),
          })
          .pipe(Effect.exit))._tag,
        "Failure",
      )
    assert.equal(
      (yield* sessions.get(session.id)).agent,
      selected,
      "record-only rejection never changes selection",
    )
    const shellSession = yield* sessions.create({ location })
    const shell = {
      id: SessionMessage.ID.create(),
      sessionID: shellSession.id,
      command: "shell",
    }
    yield* sessions.command(shell)
    yield* execution.wait(shellSession.id)
    assert.equal(
      yield* Effect.promise(() =>
        fs.readFile(path.join(process.cwd(), "command-count"), "utf8"),
      ),
      "x",
    )
    const count = calls
    yield* sessions.command(shell)
    yield* execution.wait(shellSession.id)
    assert.equal(calls, count, "duplicate command cannot replay the model")
    assert.equal(
      yield* Effect.promise(() =>
        fs.readFile(path.join(process.cwd(), "command-count"), "utf8"),
      ),
      "x",
    )
    assert.ok(
      JSON.stringify(
        yield* sessions.messages({ sessionID: shellSession.id }),
      ).includes("expanded-value"),
    )
    const childSession = yield* sessions.create({ location })
    yield* sessions.command({
      id: SessionMessage.ID.create(),
      sessionID: childSession.id,
      command: "child",
      arguments: "fixture",
    })
    yield* execution.wait(childSession.id)
    assert.equal(
      (yield* sessions.list({ directory: location.directory })).filter(
        (item) => item.parentID === childSession.id,
      ).length,
      1,
    )
    const oversizedSession = yield* sessions.create({ location })
    const oversized = {
      id: SessionMessage.ID.create(),
      sessionID: oversizedSession.id,
      command: "oversized",
    }
    const beforeOversized = calls
    const oversizedError = yield* sessions.command(oversized).pipe(Effect.flip)
    assert.equal(oversizedError._tag, "Session.OperationFailedError")
    assert.match(
      oversizedError.message,
      /Final command prompt exceeds 64,000 UTF-16 code units/,
    )
    assert.equal(
      calls,
      beforeOversized + 1,
      "only the child ran; oversized parent prompt was not executed",
    )
    assert.equal(
      yield* SessionInput.find(db, oversized.id),
      undefined,
      "oversized final prompt was not admitted",
    )
    assert.equal(
      (yield* db
        .select()
        .from(SessionCommandTable)
        .where(eq(SessionCommandTable.id, oversized.id))
        .get()
        .pipe(Effect.orDie))?.status,
      "failed",
    )
    assert.equal(
      (yield* sessions.command(oversized).pipe(Effect.exit))._tag,
      "Failure",
    )
    assert.equal(
      calls,
      beforeOversized + 1,
      "retry does not replay the already completed child",
    )
    assert.equal(
      (yield* sessions.list({ directory: location.directory })).filter(
        (item) => item.parentID === oversizedSession.id,
      ).length,
      1,
    )
    const deniedSession = yield* sessions.create({ location })
    const denied = {
      id: SessionMessage.ID.create(),
      sessionID: deniedSession.id,
      command: "denied",
    }
    assert.equal(
      (yield* sessions.command(denied).pipe(Effect.exit))._tag,
      "Failure",
    )
    assert.equal(
      yield* Effect.promise(() =>
        Bun.file(path.join(process.cwd(), "forbidden-command-write")).exists(),
      ),
      false,
    )
    assert.equal(
      (yield* sessions.command(denied).pipe(Effect.exit))._tag,
      "Failure",
      "failed command never replays",
    )
    const stopping = yield* sessions.create({ location })
    const stopped = {
      id: SessionMessage.ID.create(),
      sessionID: stopping.id,
      command: "stopped",
    }
    const fiber = yield* sessions.command(stopped).pipe(Effect.forkChild)
    yield* Effect.gen(function* () {
      while (
        !(yield* Effect.promise(() =>
          Bun.file(path.join(process.cwd(), "command-started")).exists(),
        ))
      )
        yield* Effect.sleep("5 millis")
    }).pipe(Effect.timeout("5 seconds"))
    yield* execution.interrupt(stopping.id)
    yield* Fiber.await(fiber)
    assert.equal(
      yield* Effect.promise(() =>
        Bun.file(path.join(process.cwd(), "forbidden-after-stop")).exists(),
      ),
      false,
    )
    assert.equal(
      (yield* db
        .select()
        .from(SessionCommandTable)
        .where(eq(SessionCommandTable.id, stopped.id))
        .get()
        .pipe(Effect.orDie))?.status,
      "unknown",
    )
    assert.equal(
      (yield* sessions.command(stopped).pipe(Effect.exit))._tag,
      "Failure",
      "Stop is never silently resumed",
    )
    yield* execution.awaitIdle.pipe(Effect.timeout("1 second"))
    const config = yield* Effect.promise(() =>
      Bun.file(path.join(process.cwd(), "phins.json")).json(),
    )
    for (const turns of [1, 2]) {
      const directory = path.join(process.cwd(), `budget-${turns}`)
      yield* Effect.promise(async () => {
        await fs.mkdir(directory)
        await fs.writeFile(path.join(directory, "phins.json"), JSON.stringify({
          ...config,
          run_budget: { max_turns: turns },
        }))
      })
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const parent = yield* sessions.create({ location })
      const input = { id: SessionMessage.ID.create(), sessionID: parent.id,
        command: "child", arguments: "shared budget" }
      const before: number = calls
      yield* sessions.command(input)
      yield* execution.wait(parent.id).pipe(Effect.exit)
      assert.equal(calls - before, turns,
        "child and parent continuation must consume one shared budget")
      assert.equal((yield* SessionRunState.load(db, parent.id))?.status,
        turns === 1 ? "terminal-failure" : "idle")
      const children = (yield* sessions.list({ directory: location.directory }))
        .filter((item) => item.parentID === parent.id)
      assert.equal(children.length, 1)
      assert.ok(JSON.stringify(yield* sessions.messages({ sessionID: children[0]!.id }))
        .includes("COMMAND_RESULT"), "completed child history is preserved")
      yield* sessions.command(input)
      yield* execution.wait(parent.id).pipe(Effect.exit)
      assert.equal(calls - before, turns, "retry does not replay a spent command")
      const independent = yield* sessions.create({ location })
      yield* sessions.command({ id: SessionMessage.ID.create(),
        sessionID: independent.id, command: "plain", arguments: "fresh budget" })
      yield* execution.wait(independent.id)
      assert.equal(calls - before, turns + 1, "a new run has an independent budget")
    }
    console.log(
      "commands: record-only, substitutions, canonical subtask, shared budget, receipt, permission and Stop passed",
    )
  }).pipe(
    Effect.provide(SessionRuntimeLocal.defaultLayer),
    Effect.provide(Database.defaultLayer),
    Effect.provide(EventBus.defaultLayer),
    Effect.scoped,
    Effect.runPromise,
  )
} finally {
  server.stop(true)
}
