export * as Tool from "./definition"

import {
  ToolDefinition,
  ToolFailure,
  ToolOutput,
  type ToolCall,
} from "../inference/api"
import { Effect, JsonSchema, Schema } from "effect"
import type { ToolConfig, ToolContent } from "../extensions/api/tool"
import type { AgentRegistry } from "../agents/registry"
import type { SessionMessage } from "../sessions/messages/service"
import type { Session as SessionSchema } from "../contracts/session/info"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentRegistry.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

/** A validated domain error still goes through generic output bounding. */
export class ResultFailure extends ToolFailure {
  constructor(readonly output: ToolOutput) {
    super({ message: "Tool reported an error" })
  }
}

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()(
  "Tool.RegistrationError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

export type Content = ToolContent

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
> = ToolConfig<Input, Output, Context>

type Runtime = {
  readonly parallel: boolean
  readonly originAware?: boolean
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (
    call: ToolCall,
    context: Context,
  ) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
>(config: Config<Input, Output>): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    parallel: config.parallel === true,
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputJsonSchema ?? toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError(
          (error) =>
            new ToolFailure({
              message: `Invalid tool input: ${error.message}`,
            }),
        ),
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.flatMap((output) => {
              const projected: ToolOutput = {
                structured: output,
                content:
                  config.toModelOutput?.({ input, output }).map((part) =>
                    part.type === "text"
                      ? { type: "text" as const, text: part.text }
                      : {
                          type: "file" as const,
                          uri: `data:${part.mime};base64,${part.data}`,
                          mime: part.mime,
                          name: part.name,
                        },
                  ) ??
                  (typeof output === "string"
                    ? [{ type: "text" as const, text: output }]
                    : []),
              }
              return config.isError?.(output)
                ? Effect.fail(new ResultFailure(projected))
                : Effect.succeed(projected)
            }),
          ),
        ),
      ),
  })
  return tool
}

export const validateName: (
  name: string,
) => Effect.Effect<void, RegistrationError> = (name) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(
        new RegistrationError({ name, message: `Invalid tool name: ${name}` }),
      )

export const withPermission = <
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

/** Internal leaf declaration, not a permission grant or a replacement executor. */
export const withOriginPermission = <
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), originAware: true })
  return decorated
}

export const originAware = (tool: AnyTool) =>
  runtimeOf(tool).originAware === true

export const permission = (tool: AnyTool, name: string) =>
  runtimeOf(tool).permission ?? name
export const parallel = (tool: AnyTool) => runtimeOf(tool).parallel
export const definition = (name: string, tool: AnyTool) =>
  runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) =>
  runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
