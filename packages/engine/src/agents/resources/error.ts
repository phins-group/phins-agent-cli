import { Schema } from "effect"

/** Safe public errors: never retain a token, response body or transport cause. */
export class ResourceError extends Schema.TaggedErrorClass<ResourceError>()(
  "AgentResources.Error",
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}
