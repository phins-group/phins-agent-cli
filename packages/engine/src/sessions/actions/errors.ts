import { Event } from "../../contracts/events/event"
import { Schema } from "effect"

// Keep error contracts independent of the operation/permission runtime graph.
export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()("Session.OperationUnavailableError", {
  operation: Schema.Literals(["move", "shell", "skill", "command", "switchAgent", "compact", "wait"]),
}) {}

export class OperationFailedError extends Schema.TaggedErrorClass<OperationFailedError>()("Session.OperationFailedError", {
  operation: Schema.Literals(["shell", "skill", "command", "compact"]),
  message: Schema.String,
}) {}

export class OperationConflictError extends Schema.TaggedErrorClass<OperationConflictError>()("Session.OperationConflictError", {
  id: Event.ID,
}) {}
