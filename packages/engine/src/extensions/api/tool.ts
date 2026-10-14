import type { ToolFailure } from "../../inference/tools/failure"
import type { Effect, JsonSchema, Schema, Scope } from "effect"
import type { Registration } from "./registration.js"

export type ToolSchema<A = any> = Schema.Codec<A, any, never, never>

export interface ToolContext {
  readonly sessionID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file"
      readonly data: string
      readonly mime: string
      readonly name?: string
    }

/** Construction options, not another executable tool or registry entry. */
export interface ToolConfig<
  Input extends ToolSchema,
  Output extends ToolSchema,
  Context extends ToolContext = ToolContext,
> {
  readonly description: string
  readonly parallel?: boolean
  readonly input: Input
  /** The input codec must enforce every advertised external constraint. */
  readonly inputJsonSchema?: JsonSchema.JsonSchema
  readonly output: Output
  readonly isError?: (output: Output["Encoded"]) => boolean
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<ToolContent>
}

export interface ToolRegistrationError {
  readonly _tag: "Tool.RegistrationError"
  readonly name: string
  readonly message: string
}

export interface ToolHooks {
  /** Each call constructs and registers one canonical, permission-gated tool. */
  readonly register: <Input extends ToolSchema, Output extends ToolSchema>(
    name: string,
    config: ToolConfig<Input, Output>,
  ) => Effect.Effect<Registration, ToolRegistrationError, Scope.Scope>
}
