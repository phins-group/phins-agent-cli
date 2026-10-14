import type { AssistantMessage, Message, Part } from "@phins/engine/transport/client/create"
import { Token } from "@phins/engine/shared/token"

export const totalTokens = (tokens: AssistantMessage["tokens"]) => tokens.input + tokens.output + tokens.reasoning
  + tokens.cache.read + tokens.cache.write

/** Provider usage applies only within the current context, never across a checkpoint. */
export function contextUsage(messages: readonly Message[], parts: Record<string, Part[]>) {
  const boundary = messages.findLastIndex((message) => parts[message.id]?.some((part) => part.type === "compaction"))
  const current = messages.slice(boundary < 0 ? 0 : boundary)
  const last = current.findLast((message) => message.role === "assistant" && totalTokens(message.tokens) > 0)
  if (last?.role === "assistant") return {
    tokens: totalTokens(last.tokens), estimated: false,
    model: { providerID: last.providerID, modelID: last.modelID },
  }
  if (boundary < 0) return { tokens: 0, estimated: false }
  // The adapter carries the exact checkpoint text sent on the next turn.
  // This estimates conversation text; system/tool overhead is measured by the next provider response.
  const checkpoint = parts[current[0]!.id]?.find((part) => part.type === "text" && part.synthetic)
  if (!checkpoint) return { tokens: 0, estimated: false }
  const text = current.flatMap((message) => (parts[message.id] ?? []).flatMap((part) => {
    if (part.type === "text" || part.type === "reasoning") return [part.text]
    if (part.type === "file") return [`[Attached ${part.mime}: ${part.filename ?? ""}]`]
    if (part.type !== "tool") return []
    return [JSON.stringify(part.state.input), part.state.status === "completed" ? part.state.output
      : part.state.status === "error" ? part.state.error : ""]
  })).join("\n\n")
  return { tokens: Token.estimate(text), estimated: true }
}
