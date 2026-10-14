/** Hiện thực liệt kê/chiếu message session bền vững. @module */
import { SessionManager } from "../../../sessions/service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../../api/errors"
import { MessageCursor } from "../../api/resources/message"

const DefaultMessagesLimit = 50

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionManager.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = yield* Effect.try({
          try: () => (ctx.query.cursor ? MessageCursor.decode(ctx.query.cursor) : undefined),
          catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
        })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const messages = yield* session
          .messages({
            sessionID: ctx.params.sessionID,
            limit: ctx.query.limit ?? DefaultMessagesLimit,
            order,
            cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
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
          )
        const first = messages[0]
        const last = messages.at(-1)
        return {
          data: messages,
          cursor: {
            previous: first ? MessageCursor.encode(first, order, "previous") : undefined,
            next: last ? MessageCursor.encode(last, order, "next") : undefined,
          },
        }
      }),
    )
  }),
)
