import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import {
  CallToolResultSchema,
  type CallToolRequest,
  type ContentBlock,
  type Tool as McpDefinition,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schema } from "effect"
import { PermissionPolicy } from "../../security/permissions/service"
import { Tool } from "../../tools/definition"
import { McpSchema } from "./schema"

const Output = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.optional,
  ),
  isError: Schema.Boolean.pipe(Schema.optional),
  _meta: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).check(
  Schema.makeFilter(
    (value) =>
      CallToolResultSchema.safeParse(value).success ||
      "Invalid MCP tool result",
  ),
)

export function make(input: {
  name: string
  server: string
  definition: McpDefinition
  client: {
    request: (
      request: CallToolRequest,
      schema: typeof CallToolResultSchema,
      options: RequestOptions,
    ) => Promise<unknown>
  }
  permission: PermissionPolicy.Interface
  timeout: number
  active: () => boolean
}) {
  if (input.definition.execution?.taskSupport === "required")
    throw new Error("Task-based MCP tools are not supported")
  // Validate without conversion or stripping keys from the original arguments.
  // A validator per definition also avoids cross-tool collisions of schema $id.
  const validate = McpSchema.validator.getValidator<Record<string, unknown>>(
    input.definition.inputSchema,
  )
  const validateOutput = input.definition.outputSchema
    ? McpSchema.validator.getValidator(input.definition.outputSchema)
    : undefined
  const codec = Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter(
      (args) => validate(args).valid || "Invalid MCP tool arguments",
    ),
  )
  return Tool.withOriginPermission(
    Tool.make({
      description: input.definition.description ?? "",
      input: codec,
      inputJsonSchema: input.definition.inputSchema,
      output: Output,
      isError: (output) => output.isError === true,
      execute: (args, context) =>
        Effect.gen(function* () {
          if (!input.active())
            return yield* new Tool.Failure({
              message: `Disconnected or stale MCP tool: ${input.name}`,
            })
          yield* input.permission
            .assert({
              action: input.name,
              resources: ["*"],
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              metadata: { server: input.server, tool: input.definition.name },
              source: {
                type: "tool",
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              },
            })
            .pipe(
              Effect.mapError(
                () =>
                  new Tool.Failure({
                    message: `MCP tool permission refused: ${input.name}`,
                  }),
              ),
            )
          // Catalog removal may have happened while waiting for permission.
          if (!input.active())
            return yield* new Tool.Failure({
              message: `Disconnected or stale MCP tool: ${input.name}`,
            })
          return yield* Effect.tryPromise({
            try: async (signal) => {
              // Keep validation tied to this captured definition, not the SDK's
              // mutable single-page catalog cache during pagination or refresh.
              const result = CallToolResultSchema.parse(
                await input.client.request(
                  {
                    method: "tools/call",
                    params: { name: input.definition.name, arguments: args },
                  },
                  CallToolResultSchema,
                  { signal, timeout: input.timeout },
                ),
              )
              if ("toolResult" in result)
                throw new Error("Unsupported compatibility MCP result")
              if (
                validateOutput &&
                (result.structuredContent !== undefined
                  ? !validateOutput(result.structuredContent).valid
                  : !result.isError)
              )
                throw new Error("Invalid structured MCP tool output")
              return result
            },
            catch: () =>
              new Tool.Failure({
                message: `MCP tool call failed: ${input.name}`,
              }),
          })
        }),
      toModelOutput: ({ output }) => {
        const content: Tool.Content[] = output.content.map((value) => {
          const part = value as ContentBlock
          if (part.type === "text") return { type: "text", text: part.text }
          if (part.type === "image" || part.type === "audio")
            return { type: "file", data: part.data, mime: part.mimeType }
          // Embedded resources and links remain data; never fetch returned URLs.
          return { type: "text", text: JSON.stringify(value) }
        })
        if (output.structuredContent !== undefined)
          content.push({
            type: "text",
            text: JSON.stringify(output.structuredContent),
          })
        return content
      },
    }),
  )
}

export * as McpTool from "./tool"
