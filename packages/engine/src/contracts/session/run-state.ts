export * as SessionRunState from "./run-state"

import { Schema } from "effect"
import { ascending } from "../identifier"
import { DateTimeUtcFromMillis, PositiveInt, withStatics } from "../schema"
import { SessionID } from "./id"
import { SessionMessage } from "./message"

export const ID = Schema.String.check(Schema.isStartsWith("run_")).pipe(
  Schema.brand("Session.Run.ID"),
  withStatics((schema) => ({ create: () => schema.make("run_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * A persistence-safe retry error. Publishers are responsible for redacting
 * provider headers, bodies, and metadata before constructing the event.
 */
export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export type RetryError = typeof RetryError.Type

export const IdleOutcome = Schema.Struct({ type: Schema.Literal("idle") }).annotate({
  identifier: "Session.Run.Outcome.Idle",
})
export type IdleOutcome = typeof IdleOutcome.Type

export const InterruptedOutcome = Schema.Struct({ type: Schema.Literal("interrupted") }).annotate({
  identifier: "Session.Run.Outcome.Interrupted",
})
export type InterruptedOutcome = typeof InterruptedOutcome.Type

export const TerminalFailureOutcome = Schema.Struct({
  type: Schema.Literal("terminal-failure"),
  error: SessionMessage.UnknownError,
}).annotate({ identifier: "Session.Run.Outcome.TerminalFailure" })
export type TerminalFailureOutcome = typeof TerminalFailureOutcome.Type

export const Outcome = Schema.Union([IdleOutcome, InterruptedOutcome, TerminalFailureOutcome]).pipe(
  Schema.toTaggedUnion("type"),
)
export type Outcome = IdleOutcome | InterruptedOutcome | TerminalFailureOutcome

export const Status = Schema.Literals(["busy", "retrying", "idle", "interrupted", "terminal-failure"])
export type Status = typeof Status.Type

const ActiveTime = Schema.Struct({ started: DateTimeUtcFromMillis })
const SettledTime = Schema.Struct({
  started: DateTimeUtcFromMillis,
  settled: DateTimeUtcFromMillis,
})
const Base = {
  sessionID: SessionID,
  runID: ID,
  /** Exact remote input owner; omitted for the existing local drain. */
  inputID: SessionMessage.ID.pipe(Schema.optional),
}

export const Busy = Schema.Struct({
  ...Base,
  status: Schema.Literal("busy"),
  time: ActiveTime,
}).annotate({ identifier: "Session.Run.State.Busy" })
export type Busy = typeof Busy.Type

export const Retrying = Schema.Struct({
  ...Base,
  status: Schema.Literal("retrying"),
  attempt: PositiveInt,
  nextRetryAt: DateTimeUtcFromMillis,
  error: RetryError,
  time: ActiveTime,
}).annotate({ identifier: "Session.Run.State.Retrying" })
export type Retrying = typeof Retrying.Type

export const Idle = Schema.Struct({
  ...Base,
  status: Schema.Literal("idle"),
  time: SettledTime,
}).annotate({ identifier: "Session.Run.State.Idle" })
export type Idle = typeof Idle.Type

export const Interrupted = Schema.Struct({
  ...Base,
  status: Schema.Literal("interrupted"),
  time: SettledTime,
}).annotate({ identifier: "Session.Run.State.Interrupted" })
export type Interrupted = typeof Interrupted.Type

export const TerminalFailure = Schema.Struct({
  ...Base,
  status: Schema.Literal("terminal-failure"),
  error: SessionMessage.UnknownError,
  time: SettledTime,
}).annotate({ identifier: "Session.Run.State.TerminalFailure" })
export type TerminalFailure = typeof TerminalFailure.Type

export const State = Schema.Union([Busy, Retrying, Idle, Interrupted, TerminalFailure]).pipe(
  Schema.toTaggedUnion("status"),
)
export type State = Busy | Retrying | Idle | Interrupted | TerminalFailure
