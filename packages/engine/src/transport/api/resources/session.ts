/**
 * Nhóm hợp đồng V2 cho lifecycle session create/prompt/control/context.
 * Operation ID ở đây là nguồn cho method SDK được sinh.
 * @module
 */
import { SessionMessage } from "../../../contracts/session/message"
import { SessionInput } from "../../../contracts/session/input"
import { Event } from "../../../contracts/events/event"
import { Prompt } from "../../../contracts/session/prompt"
import { Session } from "../../../contracts/session/info"
import { Project } from "../../../contracts/workspace/project"
import { AbsolutePath, PositiveInt, RelativePath, withStatics } from "../../../contracts/schema"
import { Workspace } from "../../../contracts/workspace/workspace"
import { Context, Encoding, Result, Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  ForbiddenError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { Agent } from "../../../contracts/agents/agent"
import { Model } from "../../../contracts/inference/model"
import { Location } from "../../../contracts/workspace/location"
import { Revert } from "../../../contracts/session/revert"
import { VerificationReceipt } from "../../../contracts/execution/verification-receipt"
import { EventSchema } from "./event"
import { SessionRunState } from "../../../contracts/session/run-state"
import { SessionMessagesQuery } from "./message"
import { SessionLive } from "../../../contracts/session/live"
export { SessionLive }

export const SessionSnapshotResponse = Schema.Struct({
  data: Schema.Struct({
    session: Session.Info,
    messages: Schema.Struct({
      data: Schema.Array(SessionMessage.Message),
      cursor: Schema.Struct({ next: Schema.String.pipe(Schema.optional) }),
    }),
    runState: SessionRunState.State.pipe(Schema.optional),
    after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  }),
}).annotate({ identifier: "SessionSnapshotResponse" })

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  withStatics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) => decodeSessionsCursor(Result.getOrThrow(Encoding.decodeBase64UrlString(input))),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).pipe(Schema.optional),
          permissionMode: Schema.Literal("confirm-writes").pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.snapshot", "/api/session/:sessionID/snapshot", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          limit: SessionMessagesQuery.fields.limit,
          generation: Schema.String.pipe(Schema.optional),
        }),
        success: SessionSnapshotResponse,
        error: [SessionNotFoundError, InvalidRequestError, ConflictError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.snapshot",
            summary: "Read a consistent durable session snapshot",
            description:
              "Read session info, newest messages (default 20, maximum 200), persisted run state and event head in one transaction. Use after to watch subsequent durable events; messages.cursor.next reads older history through the message route. Optional generation fences a registered local service. Excludes token deltas, unpromoted inputs and ephemeral permission/question requests. Persisted run state does not prove a live execution owner.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          after: Schema.NumberFromString.pipe(Schema.optional),
          generation: Schema.String.pipe(Schema.optional),
        }),
        success: Schema.fromJsonString(EventSchema).pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: [SessionNotFoundError, InvalidCursorError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.events",
            summary: "Watch durable session events",
            description:
              "Read persisted events after a sequence (default -1), then tail committed events for this session only. The cursor must be a safe integer from -1 to the current head. Optional generation fences a registered local service. No prompt/tool replay, token deltas or ephemeral permission/question events.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.deltas", "/api/session/:sessionID/delta", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({ generation: Schema.String.pipe(Schema.optional) }),
        success: Schema.fromJsonString(SessionLive.Frame).pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: [SessionNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.deltas",
            summary: "Watch live token fragments",
            description:
              "Live-only text, reasoning and tool-input deltas for this session. Each connection starts with session.live.reset after subscription; discard incomplete drafts and reconcile durable state. A bounded slow-reader queue emits session.live.gap then closes on overflow. No replay, durable cursor, metadata or ephemeral permission/question events. Optional generation fences a registered local service.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.verificationHistory", "/api/session/:sessionID/verification", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: VerificationReceipt.History }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.verificationHistory",
            summary: "Read verification history",
            description:
              "Newest 50 historical receipts, ordered by requested time then ID descending. Pending receipts have no completion time. Freshness is unverified; shadow passed never proves current coding success. No checks are executed.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.input", "/api/session/:sessionID/input/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [SessionNotFoundError, MessageNotFoundError],
      }).middleware(sessionLocationMiddleware).annotateMerge(OpenApi.annotations({
        identifier: "v2.session.input", summary: "Read a durable admission by its original ID",
        description: "Read-only recovery after a lost prompt acknowledgement. Includes unpromoted inputs; never resumes or replays work.",
      })),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          prompt: Prompt,
          delivery: SessionInput.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.resume", "/api/session/:sessionID/resume", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          sessionID: Session.ID,
          status: Schema.Literal("scheduled"),
        }).pipe(HttpApiSchema.status(202)),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.resume",
            summary: "Schedule session resume",
            description:
              "Start or join service-owned execution without adding a prompt. The 202 response acknowledges process-local scheduling, not completion or durable replay across service restarts. Retrying while active does not schedule another turn.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt local session",
            description:
              "Interrupt current process-owned execution and wait for cleanup. An existing idle session is a no-op. This local action is not fenced to a remote run or command attempt.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID,
          command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
          arguments: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
          files: Prompt.fields.files,
          resume: Schema.optional(Schema.Boolean),
          agent: Schema.optional(Agent.ID),
          model: Schema.optional(Model.Ref),
        }),
        success: HttpApiSchema.NoContent,
        error: [ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, UnknownError],
      }).middleware(sessionLocationMiddleware).annotateMerge(OpenApi.annotations({
        identifier: "v2.session.command",
        summary: "Execute a configured local slash command",
        description: "The native owner resolves configuration and permissions, records the command ID before side effects, and prevents replay of uncertain outcomes. Requires an idle local session. Record-only rejects shell interpolation and subtask commands before changes. This is not remote shell authority.",
      })),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Event.ID.pipe(Schema.optional),
          command: Schema.String.check(Schema.isMinLength(1)),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, UnknownError],
      }).middleware(sessionLocationMiddleware).annotateMerge(OpenApi.annotations({
        identifier: "v2.session.shell",
        summary: "Execute a local session shell command",
        description: "Run only while this session is idle, through its configured tool and permissions. Waits for settlement; disconnect does not cancel accepted work. Reusing an ID with the same completed command does not execute it again; unknown outcomes are never replayed. Agent continuation requires resume: true. This does not enable remote shell access.",
      })),
    )
    .add(
      HttpApiEndpoint.post("session.skill", "/api/session/:sessionID/skill", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Event.ID.pipe(Schema.optional),
          skill: Schema.String.check(Schema.isMinLength(1)),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, UnknownError],
      }).middleware(sessionLocationMiddleware).annotateMerge(OpenApi.annotations({
        identifier: "v2.session.skill",
        summary: "Admit an authorized local skill",
        description: "Load an authorized skill while the session is idle, persist its instructions as one durable input, then wake service-owned execution unless resume is false. The response acknowledges admission, not agent completion. Reusing an ID with another skill or session conflicts.",
      })),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Explicitly summarize recorded context while the session is idle, independently of automatic compaction settings. Waits for a committed summary; failure preserves the prior context. Disconnect does not cancel accepted compaction. Does not start an agent continuation.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description: "Observe the current session owner, queued wakes and cleanup until idle. Does not start execution or wait for future work, other sessions or durable inputs not yet scheduled. Disconnect only cancels this waiter.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Revert.State }),
        error: [MessageNotFoundError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessions",
        description: "Experimental session routes.",
      }),
    )
