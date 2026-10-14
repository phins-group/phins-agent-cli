/**
 * Các HTTP handler session V2.
 * Mỗi operation ánh xạ payload/lỗi protocol sang `SessionManager`; Core service sở
 * hữu execution bền vững và continuation, không chạy trực tiếp trong handler.
 * @module
 */
import { SessionManager } from "../../../sessions/service"
import { SessionExecution } from "../../../sessions/run/execution"
import { SessionInputOrigin } from "../../../sessions/input/origin"
import { SessionInput } from "../../../sessions/input/inbox"
import { EventBus } from "../../../runtime/events/bus"
import { Database } from "../../../storage/database"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionLive, SessionSnapshotResponse, SessionsCursor } from "../../api/resources/session"
import { MessageCursor } from "../../api/resources/message"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../../api/errors"
import { AbsolutePath } from "../../../shared/schema"
import { ServiceControl } from "../service-control"
import { SseTransport } from "../sse"
import { EventSchema } from "../../api/resources/event"

const DefaultSessionsLimit = 50

const originUnavailable = (error: SessionInputOrigin.UnavailableError) =>
  new ServiceUnavailableError({ message: error.message, service: "session.origin" })

const operationError = (error: SessionExecution.OperationError) => {
  switch (error._tag) {
    case "SessionInputOrigin.UnavailableError":
      return originUnavailable(error)
    case "Session.NotFoundError":
      return new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` })
    case "RunnerBusy":
      return new ConflictError({ message: "Session is busy; wait for its current operation to finish" })
    case "Session.OperationConflictError":
      return new ConflictError({ message: "Operation ID conflicts with an existing record", resource: error.id })
    case "PermissionV2.DeniedError":
    case "PermissionV2.RejectedError":
      return new ForbiddenError({ message: "Operation was not authorized by the Node's permission policy" })
    case "PermissionV2.CorrectedError":
      return new InvalidRequestError({ message: error.feedback })
    case "Session.OperationUnavailableError":
      return new ServiceUnavailableError({
        message: `Session ${error.operation} is unavailable in this runtime`,
        service: `session.${error.operation}`,
      })
    case "Session.OperationFailedError":
      return error.operation === "skill"
        ? new InvalidRequestError({ message: error.message })
        : new UnknownError({ message: error.message })
    case "SessionCompaction.FailedError":
      return new UnknownError({ message: error.message })
    case "LLM.Error":
    case "SessionRunnerModel.ModelNotSelectedError":
    case "SessionRunnerModel.ModelUnavailableError":
    case "SessionRunnerModel.UnsupportedApiError":
    case "Integration.Authorization":
      return new ServiceUnavailableError({
        message: "The selected provider/model is unavailable for this operation",
        service: "session.model",
      })
    default:
      return new UnknownError({ message: "Unable to complete session operation" })
  }
}

/** Gắn toàn bộ operation IDs của group `server.session`. */
export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionManager.Service
    const execution = yield* SessionExecution.Service
    const events = yield* EventBus.Service
    const { db } = yield* Database.Service
    const control = yield* ServiceControl.Service
    const encodeEvent = Schema.encodeEffect(EventSchema)
    const encodeSnapshot = Schema.encodeEffect(SessionSnapshotResponse)
    const encodeLive = Schema.encodeEffect(SessionLive.Frame)

    return handlers
      .handleRaw(
        "session.snapshot",
        Effect.fn(function* (ctx) {
          if (ctx.query.generation !== undefined) {
            const status = yield* control.status
            if (status.mode !== "managed" || status.id !== ctx.query.generation)
              return yield* new ConflictError({
                message: "Node Service generation changed; rediscover before reading a snapshot",
              })
          }
          const snapshot = yield* session.snapshot({ sessionID: ctx.params.sessionID, limit: ctx.query.limit }).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) => new SessionNotFoundError({ sessionID: error.sessionID, message: "Session not found" }),
            ),
            Effect.catchTag(
              "Session.SnapshotLimitError",
              (error) => new InvalidRequestError({ message: error.message }),
            ),
            Effect.catchTags({
              "Session.MessageDecodeError": () => new UnknownError({ message: "Unable to read session snapshot" }),
              "Session.RunStateDecodeError": () => new UnknownError({ message: "Unable to read session snapshot" }),
            }),
          )
          const last = snapshot.messages.at(-1)
          const encoded = yield* encodeSnapshot({
            data: {
              session: snapshot.session,
              messages: {
                data: snapshot.messages,
                cursor: {
                  next: snapshot.hasMore && last ? MessageCursor.encode(last, "desc", "next") : undefined,
                },
              },
              runState: snapshot.runState,
              after: snapshot.after,
            },
          }).pipe(Effect.orDie)
          return HttpServerResponse.jsonUnsafe(encoded, {
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
          })
        }),
      )
      .handleRaw(
        "session.events",
        Effect.fn(function* (ctx) {
          const after = ctx.query.after ?? -1
          if (!Number.isSafeInteger(after) || after < -1)
            return yield* new InvalidCursorError({
              message: "Event cursor must be a safe integer greater than or equal to -1",
            })
          if (ctx.query.generation !== undefined) {
            const status = yield* control.status
            if (status.mode !== "managed" || status.id !== ctx.query.generation)
              return yield* new ConflictError({
                message: "Node Service generation changed; rediscover before watching events",
              })
          }
          if (after > (yield* EventBus.latestSequence(db, ctx.params.sessionID)))
            return yield* new InvalidCursorError({
              message: "Event cursor is ahead of this session's recorded history",
            })
          const stream = events.durable({ aggregateID: ctx.params.sessionID, after }).pipe(
            Stream.mapEffect((event) =>
              encodeEvent(event).pipe(Effect.flatMap((encoded) => SseTransport.encodeJsonEvent(encoded))),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          )
          // Flush headers even when the session has no persisted events yet.
          return HttpServerResponse.stream(
            Stream.concat(Stream.make(new TextEncoder().encode(": connected\n\n")), stream),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
      .handleRaw(
        "session.deltas",
        Effect.fn(function* (ctx) {
          if (ctx.query.generation !== undefined) {
            const status = yield* control.status
            if (status.mode !== "managed" || status.id !== ctx.query.generation)
              return yield* new ConflictError({
                message: "Node Service generation changed; rediscover before watching tokens",
              })
          }
          const stream = events.sessionDeltas(ctx.params.sessionID).pipe(
            Stream.mapEffect((frame) =>
              encodeLive(frame).pipe(Effect.flatMap((encoded) => SseTransport.encodeJsonEvent(encoded))),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          )
          // The first reset comes from the registered subscription itself,
          // not an eagerly flushed comment that precedes subscription.
          return HttpServerResponse.stream(stream, {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-store, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          })
        }),
      )
      .handle(
        "session.verificationHistory",
        Effect.fn(function* (ctx) {
          const data = yield* session.verificationHistory(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: "Session not found",
                }),
              ),
            ),
            Effect.catchTag("VerificationHistory.DecodeError", () =>
              Effect.fail(
                new UnknownError({
                  message: "Unable to read verification history",
                }),
              ),
            ),
          )
          return { data }
        }),
      )
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              title: ctx.payload.title,
              permissionMode: ctx.payload.permissionMode,
              model: ctx.payload.model,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.input",
        Effect.fn(function* (ctx) {
          const input = yield* SessionInput.find(db, ctx.params.messageID)
          if (!input || input.sessionID !== ctx.params.sessionID)
            return yield* new MessageNotFoundError({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID,
              message: "Durable input not found in this session" })
          return { data: input }
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("SessionInputOrigin.UnavailableError", originUnavailable),
              ),
          }
        }),
      )
      .handle(
        "session.resume",
        Effect.fn(function* (ctx) {
          yield* session.scheduleResume(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionInputOrigin.UnavailableError", originUnavailable),
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return { sessionID: ctx.params.sessionID, status: "scheduled" as const }
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          // Core also supports orphan-owner cleanup; the public API requires a recorded session.
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          // Only the authenticated explicit endpoint marks user intent. Host
          // shutdown, transport failure and lease cleanup use generic interrupt.
          yield* Effect.uninterruptible(execution.interrupt(ctx.params.sessionID, { requested: true }))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          yield* session.command({ ...ctx.payload, sessionID: ctx.params.sessionID })
            .pipe(Effect.mapError(operationError))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session
            .shell({ ...ctx.payload, sessionID: ctx.params.sessionID })
            .pipe(Effect.mapError(operationError))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          yield* session
            .skill({ ...ctx.payload, sessionID: ctx.params.sessionID })
            .pipe(Effect.mapError(operationError))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(Effect.mapError(operationError))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag("SessionInputOrigin.UnavailableError", originUnavailable),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionInputOrigin.UnavailableError", originUnavailable),
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionInputOrigin.UnavailableError", originUnavailable),
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
  }),
)
