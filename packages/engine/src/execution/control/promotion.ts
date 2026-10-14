import { Cause, DateTime, Effect, Schema } from "effect"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { SessionEvent } from "../../contracts/events/session"
import { SessionInput } from "../../sessions/input/inbox"
import { SessionMessage } from "../../sessions/messages/service"
import { SessionRunState } from "../../sessions/run/state"
import { Session as SessionSchema } from "../../contracts/session/info"
import type { Node } from "./receiver"
import { RestorationError, restorePrompt } from "./restoration"

const Target = Schema.Struct({
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
})

/**
 * Promotion and the exact run owner commit together. Without a continuation
 * this only prepares ownership. A native host may enter its runner cleanup
 * frame before the publication mask is lifted; no queue drain is implied.
 */
export const startPrompt = Effect.fn("NodeControl.startPrompt")(function* <
  E = never,
  R = never,
>(
  node: Node,
  value: typeof Target.Type,
  onPrepared?: (
    owner: typeof Target.Type & { readonly runID: SessionRunState.ID },
  ) => Effect.Effect<void, E, R>,
) {
  const parsed = Schema.decodeUnknownExit(Target, {
    onExcessProperty: "error",
  })(value)
  const unavailable = () =>
    new RestorationError({
      message: "Stored Node prompt is unavailable or no longer authorized",
    })
  if (parsed._tag === "Failure") return yield* unavailable()
  const target = Object.freeze({ ...parsed.value })
  const constraint = yield* restorePrompt(node, target)
  const { db } = yield* Database.Service
  const input = yield* SessionInput.find(db, target.messageID)
  if (!input?.origin || !(yield* constraint.valid)) return yield* unavailable()
  const runID = SessionRunState.ID.create()
  const events = yield* EventBus.Service
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* events
        .publishBatch([
          {
            definition: SessionEvent.OriginPrompted,
            data: {
              ...target,
              timestamp: input.timeCreated,
              prompt: input.prompt,
              delivery: input.delivery,
              origin: input.origin,
            },
          },
          {
            definition: SessionEvent.Run.Started,
            data: {
              sessionID: target.sessionID,
              runID,
              inputID: target.messageID,
              timestamp: yield* DateTime.now,
            },
          },
        ])
        .pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              // Publication may commit before a notification fails. Clean only our owner;
              // a transaction rollback or a different run must remain untouched.
              const state = yield* SessionRunState.load(
                db,
                target.sessionID,
              ).pipe(Effect.orDie)
              if (
                state?.runID !== runID ||
                state.inputID !== target.messageID ||
                (state.status !== "busy" && state.status !== "retrying")
              )
                return
              yield* events.publish(SessionEvent.Run.Settled, {
                sessionID: target.sessionID,
                runID,
                timestamp: DateTime.makeUnsafe(
                  Math.max(
                    DateTime.toEpochMillis(state.time.started),
                    DateTime.toEpochMillis(yield* DateTime.now),
                  ),
                ),
                outcome: Cause.hasInterruptsOnly(cause)
                  ? { type: "interrupted" }
                  : {
                      type: "terminal-failure",
                      error: {
                        type: "unknown",
                        message: "Node command preparation publication failed",
                      },
                    },
              })
            }),
          ),
        )
      const owner = Object.freeze({ ...target, runID })
      if (onPrepared) yield* onPrepared(owner)
      return owner
    }),
  )
})
