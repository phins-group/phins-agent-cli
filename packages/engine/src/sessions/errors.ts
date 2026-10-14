import { Schema } from "effect"
import { SessionMessage } from "./messages/service"
import { Session as SessionSchema } from "../contracts/session/info"

export class MessageDecodeError extends Schema.TaggedErrorClass<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Failed to decode message ${this.messageID} in session ${this.sessionID}`
  }
}

export class ContextSnapshotDecodeError extends Schema.TaggedErrorClass<ContextSnapshotDecodeError>()(
  "Session.ContextSnapshotDecodeError",
  {
    sessionID: SessionSchema.ID,
    details: Schema.String,
  },
) {
  override get message() {
    return `Failed to decode context snapshot for session ${this.sessionID}: ${this.details}`
  }
}

export class RunStateDecodeError extends Schema.TaggedErrorClass<RunStateDecodeError>()(
  "Session.RunStateDecodeError",
  {
    sessionID: SessionSchema.ID,
    runID: Schema.String.pipe(Schema.optional),
    details: Schema.String,
  },
) {
  override get message() {
    const run = this.runID ? ` for run ${this.runID}` : ""
    return `Failed to decode run state${run} in session ${this.sessionID}: ${this.details}`
  }
}
