/** Presentation reads for the existing TUI, backed by the native owner. */
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
import { SessionV1 } from "../../../contracts/session/compat"
import { Session } from "../../../contracts/session/info"
import { SessionMessageID } from "../../../contracts/session/message-id"
import { SessionTodoInfo } from "../../../contracts/session/todo"
import { FileDiff } from "../../../contracts/workspace/file-diff"
import { Prompt } from "../../../contracts/session/prompt"
import { LocationQuery } from "./location"
import { ConflictError, InvalidRequestError, ServiceUnavailableError, SessionNotFoundError, UnknownError } from "../errors"

export const TuiContext = Schema.Struct({
  config: Schema.Struct({
    model: Schema.optional(Schema.String),
    default_agent: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
  }),
  defaultModel: Schema.optional(Schema.String),
  path: Schema.Struct({
    home: Schema.String,
    state: Schema.String,
    config: Schema.String,
    directory: Schema.String,
    worktree: Schema.String,
  }),
  project: Schema.Struct({ id: Schema.String, worktree: Schema.String }),
  directories: Schema.Array(Schema.Struct({
    directory: Schema.String,
    strategy: Schema.optional(Schema.String),
  })),
  vcs: Schema.optional(Schema.Struct({ branch: Schema.String })),
  mcp: Schema.Record(Schema.String, Schema.Struct({
    status: Schema.String,
    error: Schema.optional(Schema.String),
  })),
  formatter: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String, extensions: Schema.Array(Schema.String), enabled: Schema.Boolean,
  }))),
})

export const TuiSession = Schema.Struct({
  info: SessionV1.SessionInfo,
  todo: Schema.Array(SessionTodoInfo),
  diff: Schema.Array(FileDiff.Info),
  pending: Schema.Array(Schema.Struct({ id: SessionMessageID.ID, time: Schema.Finite, prompt: Prompt })),
  messageIDs: Schema.Array(SessionMessageID.ID),
})

const RunStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("busy") }),
  Schema.Struct({ type: Schema.Literal("retry"), attempt: Schema.Number, message: Schema.String, next: Schema.Number }),
])

export const makeTuiGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) => HttpApiGroup.make("server.tui")
  .add(HttpApiEndpoint.get("tui.context", "/api/tui", {
    query: LocationQuery,
    success: TuiContext,
    error: UnknownError,
  }))
  .add(HttpApiEndpoint.get("tui.status", "/api/tui/status", {
    query: LocationQuery,
    success: Schema.Record(Schema.String, RunStatus),
    error: UnknownError,
  }))
  .add(HttpApiEndpoint.post("tui.mcp", "/api/tui/mcp/:name", {
    params: { name: Schema.String },
    query: LocationQuery,
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Schema.Boolean,
    error: InvalidRequestError,
  }))
  .add(HttpApiEndpoint.get("tui.session", "/api/tui/session/:sessionID", {
    params: { sessionID: Session.ID },
    success: TuiSession,
    error: [SessionNotFoundError, UnknownError],
  }).middleware(sessionLocationMiddleware))
  .add(HttpApiEndpoint.patch("tui.session.update", "/api/tui/session/:sessionID", {
    params: { sessionID: Session.ID },
    payload: Schema.Struct({
      title: Schema.optional(Schema.String),
      time: Schema.optional(Schema.Struct({ archived: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) })),
    }),
    success: SessionV1.SessionInfo,
    error: [SessionNotFoundError, ConflictError, InvalidRequestError, UnknownError],
  }).middleware(sessionLocationMiddleware))
  .add(HttpApiEndpoint.delete("tui.session.remove", "/api/tui/session/:sessionID", {
    params: { sessionID: Session.ID },
    success: Schema.Boolean,
    error: [SessionNotFoundError, ConflictError, InvalidRequestError, UnknownError],
  }).middleware(sessionLocationMiddleware))
  .add(HttpApiEndpoint.post("tui.session.fork", "/api/tui/session/:sessionID/fork", {
    params: { sessionID: Session.ID },
    payload: Schema.Struct({ messageID: Schema.optional(SessionMessageID.ID) }),
    success: SessionV1.SessionInfo,
    error: [SessionNotFoundError, ConflictError, InvalidRequestError, ServiceUnavailableError, UnknownError],
  }).middleware(sessionLocationMiddleware))
