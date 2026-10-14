export * as TodoWriteTool from "./planning"

import { ToolFailure } from "../inference/api"
import { Effect, Layer, Schema } from "effect"
import { PermissionPolicy } from "../security/permissions/service"
import { SessionTodo } from "../sessions/tasks"
import { Tool } from "./definition"
import { Tools } from "./registration"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionPolicy.Service

    yield* tools
      .register({
        [name]: Tool.withOriginPermission(
          Tool.make({
            description:
              "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
                return { todos: input.todos }
              }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update todos" }))),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
