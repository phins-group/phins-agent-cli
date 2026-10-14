export * as UserQuestions from "./questions"

import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Question } from "../contracts/agents/question"
import { EventBus } from "../runtime/events/bus"
import { Session as SessionSchema } from "../contracts/session/info"
import { PermissionOrigin } from "../security/permissions/origin"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()(
  "QuestionV2.RejectedError",
  {},
) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "QuestionV2.NotFoundError",
  {
    requestID: ID,
  },
) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (
    input: AskInput,
  ) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/Question",
) {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  readonly origin: ReadonlyArray<PermissionOrigin.Constraint>
  replying: boolean
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventBus.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        pending.values(),
        (item) => Deferred.fail(item.deferred, new RejectedError()),
        {
          discard: true,
        },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<
            ReadonlyArray<Answer>,
            RejectedError
          >()
          const request: Request = { id, ...input }
          const origin = yield* PermissionOrigin.capture
          pending.set(id, { request, deferred, origin, replying: false })
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.flatMap((answers) =>
              PermissionOrigin.permits(
                {
                  sessionID: input.sessionID,
                  action: "question",
                  resources: ["*"],
                },
                origin,
              ).pipe(
                Effect.flatMap((valid) =>
                  valid
                    ? Effect.succeed(answers)
                    : Effect.fail(new RejectedError()),
                ),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing || existing.replying)
            return yield* new NotFoundError({ requestID: input.requestID })
          existing.replying = true
          yield* Effect.gen(function* () {
            const valid = yield* PermissionOrigin.permits(
              {
                sessionID: existing.request.sessionID,
                action: "question",
                resources: ["*"],
              },
              existing.origin,
            )
            if (!valid || pending.get(input.requestID) !== existing)
              return yield* new NotFoundError({ requestID: input.requestID })
            yield* events.publish(Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              answers: input.answers.map((answer) => [...answer]),
            })
            yield* Deferred.succeed(existing.deferred, input.answers)
            pending.delete(input.requestID)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                existing.replying = false
              }),
            ),
          )
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing || existing.replying)
            return yield* new NotFoundError({ requestID })
          existing.replying = true
          yield* events
            .publish(Event.Rejected, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
            })
            .pipe(
              Effect.andThen(
                Deferred.fail(existing.deferred, new RejectedError()),
              ),
              Effect.andThen(Effect.sync(() => pending.delete(requestID))),
              Effect.ensuring(
                Effect.sync(() => {
                  existing.replying = false
                }),
              ),
            )
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer
