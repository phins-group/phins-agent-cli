import { Schema } from "effect"

/**
 * Failure type for tool execute handlers. Handlers must map their internal
 * errors to this shape; the runtime catches `ToolFailure`s and surfaces them
 * as `tool-error` events plus a `tool-result` of `type: "error"` so the model
 * can self-correct.
 *
 * Anything thrown or yielded by a handler that is not a `ToolFailure` is
 * treated as a defect and fails the stream.
 */
export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()(
  "LLM.ToolFailure",
  {
    message: Schema.String,
    error: Schema.optional(Schema.Defect()),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  },
) {}
