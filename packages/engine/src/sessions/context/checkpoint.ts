import { DateTime } from "effect"
import { isDeepStrictEqual } from "node:util"
import { SessionV1 } from "../../contracts/session/compat"
import { SessionEvent } from "../../contracts/events/session"

export * as CompatibilityCheckpoint from "./checkpoint"

type MessageInfo = (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"]
type MessagePart = (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]

export class CheckpointIdentityError extends Error {}

type Usage = {
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

export interface Checkpoint {
  readonly version: 1
  readonly canonicalMessageID: SessionEvent.LegacyProjection["canonicalMessageID"]
  readonly message: MessageInfo
  readonly parts: ReadonlyArray<{
    readonly part: MessagePart
    readonly time: number
  }>
}

function invalid(message: string): never {
  throw new CheckpointIdentityError(message)
}

function singlePart(input: Checkpoint, eventType: string): MessagePart {
  if (input.parts.length !== 1) {
    return invalid(`Legacy checkpoint for ${eventType} must contain exactly one part`)
  }
  return input.parts[0]!.part
}

function sameUsageTokens(left: Usage["tokens"], right: Usage["tokens"]) {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cache.read === right.cache.read &&
    left.cache.write === right.cache.write
  )
}

function assistantErrorMessage(error: SessionV1.Assistant["error"]) {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = error.data
  return typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
    ? data.message
    : undefined
}

/** Bind an embedded V1 mutation to the semantic transition of its Core event. */
export function validate(event: SessionEvent.Event, input: Checkpoint) {
  if (input.message.sessionID !== event.data.sessionID) {
    invalid(
      `Legacy checkpoint message ${input.message.id} belongs to ${input.message.sessionID}, expected ${event.data.sessionID}`,
    )
  }
  const partIDs = new Set<string>()
  for (const { part } of input.parts) {
    if (partIDs.has(part.id)) {
      invalid(`Legacy checkpoint contains duplicate part ${part.id}`)
    }
    partIDs.add(part.id)
    if (part.sessionID !== event.data.sessionID || part.messageID !== input.message.id) {
      invalid(
        `Legacy checkpoint part ${part.id} does not belong to ${event.data.sessionID}/${input.message.id}`,
      )
    }
  }
  const expectedCanonicalID =
    "assistantMessageID" in event.data
      ? event.data.assistantMessageID
      : "messageID" in event.data
        ? event.data.messageID
        : undefined
  if (expectedCanonicalID && input.canonicalMessageID !== expectedCanonicalID) {
    invalid(
      `Legacy checkpoint canonical message ${input.canonicalMessageID} does not match ${event.type} message ${expectedCanonicalID}`,
    )
  }
  if ("assistantMessageID" in event.data && input.message.role !== "assistant") {
    invalid(`Legacy checkpoint for ${event.type} must contain an assistant message`)
  }

  if (!("timestamp" in event.data)) {
    invalid(`Legacy checkpoint for ${event.type} has no semantic timestamp`)
  }
  const completedAt = DateTime.toEpochMillis(event.data.timestamp)
  switch (event.type) {
    case SessionEvent.Prompted.type:
      if (
        input.message.role !== "user" ||
        String(input.message.id) !== String(event.data.messageID)
      ) {
        invalid(`Legacy prompt checkpoint does not own message ${event.data.messageID}`)
      }
      if (
        input.parts.some(
          ({ part }) =>
            part.type !== "text" &&
            part.type !== "file" &&
            part.type !== "agent" &&
            part.type !== "subtask",
        )
      ) {
        invalid(`Legacy prompt checkpoint contains a non-prompt part`)
      }
      return
    case SessionEvent.Shell.Started.type: {
      const part = singlePart(input, event.type)
      if (
        input.message.role !== "assistant" ||
        String(input.message.id) !== String(event.data.messageID) ||
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.state.status !== "running" ||
        part.state.time.start !== completedAt ||
        !isDeepStrictEqual(part.state.input, { command: event.data.command })
      ) {
        invalid(`Legacy shell-start checkpoint does not match call ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Shell.Ended.type: {
      const part = singlePart(input, event.type)
      if (
        input.message.role !== "assistant" ||
        event.data.messageID === undefined ||
        String(input.message.id) !== String(event.data.messageID) ||
        input.message.time.completed !== completedAt ||
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.state.status !== "completed" ||
        part.state.output !== event.data.output ||
        part.state.time.end !== completedAt
      ) {
        invalid(`Legacy shell-end checkpoint does not match call ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Step.Started.type: {
      const part = singlePart(input, event.type)
      if (
        input.message.role !== "assistant" ||
        input.message.time.completed !== undefined ||
        part.type !== "step-start" ||
        part.snapshot !== event.data.snapshot
      ) {
        invalid(`Legacy step-start checkpoint does not match ${event.data.assistantMessageID}`)
      }
      return
    }
    case SessionEvent.Step.Ended.type: {
      const part = singlePart(input, event.type)
      if (
        input.message.role !== "assistant" ||
        input.message.finish !== event.data.finish ||
        input.message.time.completed !== completedAt ||
        part.type !== "step-finish" ||
        part.reason !== event.data.finish ||
        part.snapshot !== event.data.snapshot ||
        part.cost !== event.data.cost ||
        !sameUsageTokens(input.message.tokens, event.data.tokens) ||
        !sameUsageTokens(part.tokens, event.data.tokens)
      ) {
        invalid(`Legacy step-end checkpoint does not match ${event.data.assistantMessageID}`)
      }
      return
    }
    case SessionEvent.Step.Failed.type:
      if (
        input.message.role !== "assistant" ||
        input.message.finish !== "error" ||
        assistantErrorMessage(input.message.error) !== event.data.error.message ||
        input.message.time.completed !== completedAt ||
        input.parts.length !== 0
      ) {
        invalid(`Legacy step-failed checkpoint does not match ${event.data.assistantMessageID}`)
      }
      return
    case SessionEvent.Text.Started.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "text" ||
        part.id !== event.data.legacyPartID ||
        part.text !== "" ||
        part.time?.start !== completedAt
      ) {
        invalid(`Legacy text-start checkpoint does not match ${event.data.textID}`)
      }
      return
    }
    case SessionEvent.Text.Ended.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "text" ||
        part.id !== event.data.legacyPartID ||
        part.text !== event.data.text ||
        part.time?.end !== completedAt
      ) {
        invalid(`Legacy text-end checkpoint does not match ${event.data.textID}`)
      }
      return
    }
    case SessionEvent.Reasoning.Started.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "reasoning" ||
        part.id !== event.data.legacyPartID ||
        part.text !== "" ||
        part.time.start !== completedAt
      ) {
        invalid(`Legacy reasoning-start checkpoint does not match ${event.data.reasoningID}`)
      }
      return
    }
    case SessionEvent.Reasoning.Ended.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "reasoning" ||
        part.id !== event.data.legacyPartID ||
        part.text !== event.data.text ||
        part.time.end !== completedAt
      ) {
        invalid(`Legacy reasoning-end checkpoint does not match ${event.data.reasoningID}`)
      }
      return
    }
    case SessionEvent.Tool.Input.Started.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.tool !== event.data.name ||
        part.state.status !== "pending" ||
        part.state.raw !== "" ||
        !isDeepStrictEqual(part.state.input, {})
      ) {
        invalid(`Legacy tool-input-start checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Tool.Input.Ended.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.state.status !== "pending" ||
        part.state.raw !== event.data.text
      ) {
        invalid(`Legacy tool-input-end checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Tool.Called.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.tool !== event.data.tool ||
        part.state.status !== "running" ||
        part.state.time.start !== completedAt ||
        !isDeepStrictEqual(part.state.input, event.data.input)
      ) {
        invalid(`Legacy tool-called checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Tool.Progress.type: {
      const part = singlePart(input, event.type)
      if (part.type !== "tool" || part.callID !== event.data.callID || part.state.status !== "running") {
        invalid(`Legacy tool-progress checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Tool.Success.type: {
      const part = singlePart(input, event.type)
      const text = event.data.content.find((item) => item.type === "text")
      if (
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.state.status !== "completed" ||
        !text ||
        part.state.output !== text.text ||
        part.state.time.end !== completedAt
      ) {
        invalid(`Legacy tool-success checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Tool.Failed.type: {
      const part = singlePart(input, event.type)
      if (
        part.type !== "tool" ||
        part.callID !== event.data.callID ||
        part.state.status !== "error" ||
        part.state.error !== event.data.error.message ||
        part.state.time.end !== completedAt
      ) {
        invalid(`Legacy tool-failed checkpoint does not match ${event.data.callID}`)
      }
      return
    }
    case SessionEvent.Compaction.Started.type: {
      const part = singlePart(input, event.type)
      if (
        input.message.role !== "user" ||
        String(input.message.id) !== String(event.data.messageID) ||
        part.type !== "compaction" ||
        part.auto !== (event.data.reason === "auto")
      ) {
        invalid(`Legacy compaction checkpoint does not match ${event.data.messageID}`)
      }
      return
    }
    default:
      invalid(`Legacy checkpoint is not allowed on ${event.type}`)
  }
}
