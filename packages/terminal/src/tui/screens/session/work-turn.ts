import type { Message, Part } from "@phins/engine/transport/client/create"

export type WorkGroup = {
  id: string
  role: Message["role"]
  messageIDs: string[]
  parentID?: string
}

/** Adjacent replies share a work turn. Never reorder queued requests or orphaned replies. */
export function groupWorkMessages(messages: readonly Message[]) {
  const groups: WorkGroup[] = []
  for (const message of messages) {
    const previous = groups.at(-1)
    if (
      message.role === "assistant" && previous?.role === "assistant" &&
      previous.parentID === message.parentID
    ) {
      previous.messageIDs.push(message.id)
    } else {
      groups.push({
        id: message.id,
        role: message.role,
        messageIDs: [message.id],
        parentID: message.role === "assistant" ? message.parentID : undefined,
      })
    }
  }
  return groups
}

const exploration = new Set(["read", "glob", "grep"])

export function groupWorkParts(parts: readonly Part[]) {
  const groups: { id: string; exploration: boolean; partIDs: string[] }[] = []
  for (const part of parts) {
    const canGroup = part.type === "tool" && part.state.status === "completed"
      && exploration.has(part.tool)
    const previous = groups.at(-1)
    if (canGroup && previous?.exploration) previous.partIDs.push(part.id)
    else groups.push({ id: part.id, exploration: canGroup, partIDs: [part.id] })
  }
  return groups
}
