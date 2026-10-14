import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { PermissionPolicy } from "../src/security/permissions/service"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionTable } from "../src/storage/tables/sessions"
import { SessionTodo } from "../src/sessions/tasks"
import { TodoWriteTool } from "../src/tools/planning"
import { ToolRegistry } from "../src/tools/registry"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionManager.ID.make("ses_todowrite_tool_test")
const assertions: PermissionPolicy.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionPolicy.Service,
  PermissionPolicy.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionPolicy.DeniedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const tool = TodoWriteTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(SessionTodo.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer, SessionTodo.defaultLayer, permission, registry, tool),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectRegistry.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (todos: ReadonlyArray<SessionTodo.Info>, id = "call-todowrite") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: TodoWriteTool.name, input: { todos } },
})

describe("TodoWriteTool", () => {
  it.effect("registers, approves the wildcard resource, persists todos, and returns typed output", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const todoList = [{ content: "Implement slice", status: "in_progress", priority: "high" }]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([TodoWriteTool.name])
      expect(yield* settleTool(registry, call(todoList))).toEqual({
        result: { type: "text", value: JSON.stringify(todoList, null, 2) },
        output: {
          structured: { todos: todoList },
          content: [{ type: "text", text: JSON.stringify(todoList, null, 2) }],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      expect(yield* service.get(sessionID)).toEqual(todoList)
    }),
  )

  it.effect("does not update persisted todos when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      yield* service.update({ sessionID, todos: [{ content: "keep", status: "pending", priority: "low" }] })
      deny = true

      expect(
        yield* executeTool(registry, call([{ content: "blocked", status: "completed", priority: "high" }])),
      ).toEqual({
        type: "error",
        value: "Unable to update todos",
      })
      expect(yield* service.get(sessionID)).toEqual([{ content: "keep", status: "pending", priority: "low" }])
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
    }),
  )
})
