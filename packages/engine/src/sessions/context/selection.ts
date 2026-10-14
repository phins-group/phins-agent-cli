/** Request-local deduplication; durable history and permission evidence stay intact. */
import { createHash } from "node:crypto"
import { Message } from "../../inference/schema/messages"
export function selectContext(messages: readonly Message[]) {
  const calls = new Map<string, string>()
  const seen = new Map<string, string>()
  let duplicateReads = 0, removedBytes = 0
  const selected = messages.map((message) => {
    let changed = false
    const content = message.content.map((part) => {
      if (part.type === "tool-call" && part.name === "read" && !part.providerExecuted)
        calls.set(part.id, JSON.stringify(part.input))
      if (part.type !== "tool-result" || part.name !== "read" || part.providerExecuted ||
        part.result.type !== "text" || typeof part.result.value !== "string" || !calls.has(part.id)) return part
      const text = part.result.value
      if (Buffer.byteLength(text) < 1024) return part
      const hash = createHash("sha256").update(calls.get(part.id)!).update("\0").update(text).digest("hex")
      const previous = seen.get(hash)
      if (!previous) { seen.set(hash, part.id); return part }
      // The referenced full result is in this very request, not an external cache.
      const value = `[Identical read result to tool call ${previous}; sha256 ${hash}. Full content is retained above.]`
      duplicateReads++
      removedBytes += Buffer.byteLength(text) - Buffer.byteLength(value)
      changed = true
      return { ...part, result: { type: "text" as const, value } }
    })
    return changed ? new Message({ ...message, content }) : message
  })
  return { messages: selected, duplicateReads, removedBytes }
}
