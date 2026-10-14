export * as FormatTool from "./format"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "../../inference/api"
import { Formatter } from "../../workspace/files/formatter"
import { Tool } from "../definition"
import { Tools } from "../registration"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const formatter = yield* Formatter.Service
    yield* tools
      .register({
        format: Tool.withOriginPermission(
          Tool.withPermission(
            Tool.make({
              description:
                "Format a file using configured project formatters. Requires edit and formatter command permission. No formatter is downloaded or run implicitly.",
              input: Schema.Struct({ path: Schema.String }),
              output: Schema.Struct({
                formatters: Schema.Array(Schema.String),
              }),
              execute: (input, context) =>
                formatter.format(input.path, context).pipe(
                  Effect.map((formatters) => ({ formatters })),
                  Effect.mapError(
                    (error) => new ToolFailure({ message: error.message }),
                  ),
                ),
              toModelOutput: ({ output }) => [
                {
                  type: "text",
                  text: output.formatters.length
                    ? `Formatted with: ${output.formatters.join(", ")}`
                    : "No enabled formatter is configured for this file extension.",
                },
              ],
            }),
            "formatter",
          ),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
