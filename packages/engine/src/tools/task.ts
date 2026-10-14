export * as TaskTool from "./task"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "../inference/api"
import { AgentRegistry } from "../agents/registry"
import { PermissionPolicy } from "../security/permissions/service"
import * as Subtasks from "../sessions/run/subtasks"
import { Tool } from "./definition"
import { Tools } from "./registration"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentRegistry.Service
    const permission = yield* PermissionPolicy.Service
    yield* tools
      .register({
        task: Tool.make({
          description:
            "Delegate a bounded foreground task to a local subagent (general or explore). Waits for its result; stopping the parent stops the child. No background execution or recursive delegation.",
          input: Schema.Struct({
            description: Schema.String.check(
              Schema.isMinLength(1),
              Schema.isMaxLength(160),
            ),
            prompt: Schema.String.check(
              Schema.isMinLength(1),
              Schema.isMaxLength(32_000),
            ),
            subagent_type: Schema.String.check(
              Schema.isMinLength(1),
              Schema.isMaxLength(128),
            ),
          }),
          output: Schema.Struct({
            sessionID: Schema.String,
            text: Schema.String,
          }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Subtask ${output.sessionID}\n${output.text}`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const runtime = yield* Subtasks.Current
              if (!runtime || runtime.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message:
                    "Foreground delegation is unavailable outside a local root run",
                })
              const agent = yield* agents.resolve(input.subagent_type)
              const parent = yield* agents.resolve(context.agent)
              if (!agent || agent.hidden || agent.mode === "primary" || !parent)
                return yield* new ToolFailure({
                  message: "Choose an available local subagent",
                })
              yield* permission
                .assert({
                  action: "task",
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new ToolFailure({
                        message: "Subtask permission was not granted",
                      }),
                  ),
                )
              return yield* runtime
                .run({
                  parentID: context.sessionID,
                  key: `${context.assistantMessageID}:${context.toolCallID}`,
                  agent: agent.id,
                  rules: parent.permissions,
                  model: agent.model,
                  description: input.description,
                  prompt: input.prompt,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: error.message }),
                  ),
                )
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
