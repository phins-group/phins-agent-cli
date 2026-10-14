import {
  mergeHttpOptions,
  mergeProviderOptions,
  type LLMRequest,
} from "../../inference/api"
import { Effect } from "effect"
import { SessionInputOrigin } from "../../sessions/input/origin"
import type { Session as SessionSchema } from "../../contracts/session/info"

const protocols = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
])
// Generation-only overrides cannot replace history, tools or provider state.
const bodyOptions = new Set([
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "reasoning_effort",
])

/** Hosted tools and provider-side thread state have no native grant mapping yet. */
export const check = Effect.fn("NodeCommandProvider.check")(function* (
  sessionID: SessionSchema.ID,
  request: LLMRequest,
) {
  const options =
    mergeProviderOptions(
      request.model.route.defaults.providerOptions,
      request.providerOptions,
    ) ?? {}
  const http = mergeHttpOptions(request.model.route.defaults.http, request.http)
  const openai = options.openai
  if (
    !protocols.has(request.model.route.protocol) ||
    request.model.route.transport.id !== "http-json" ||
    request.tools.some((tool) => tool.native !== undefined) ||
    Object.keys(http?.body ?? {}).some((key) => !bodyOptions.has(key)) ||
    Object.keys(options).some((key) => key !== "openai") ||
    (openai !== undefined &&
      (typeof openai !== "object" ||
        openai === null ||
        Array.isArray(openai) ||
        Object.keys(openai).some((key) => key !== "promptCacheKey")))
  )
    return yield* new SessionInputOrigin.UnavailableError({ sessionID })
})
