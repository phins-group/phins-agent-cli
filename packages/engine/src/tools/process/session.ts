export * as ProcessSessionTool from "./session"

import { ToolFailure } from "../../inference/api"
import { Effect, Layer } from "effect"
import { PermissionPolicy } from "../../security/permissions/service"
import { ProcessSessions } from "../../execution/process/sessions"
import { Tool } from "../definition"
import { Tools } from "../registration"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* ProcessSessions.Service
    const permission = yield* PermissionPolicy.Service
    const tools = yield* Tools.Service
    yield* tools
      .register({
        process_session: Tool.make({
          description:
            "Observe, write stdin to, or cancel a process returned by bash with yieldTimeMs. Handles belong to the creating session and are interrupted by restart. Pass the previous cursor for new output; waiting never terminates the command.",
          input: ProcessSessions.Followup,
          output: ProcessSessions.Snapshot,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "write")
                yield* permission.assert({
                  action: "bash",
                  resources: [`stdin:${input.processID}`],
                  metadata: { processID: input.processID, data: input.data },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
              return yield* sessions.followup(context.sessionID, input)
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
