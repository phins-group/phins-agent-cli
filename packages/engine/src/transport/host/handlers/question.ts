/** Hiện thực thao tác question list/reply/reject. @module */
import { UserQuestions } from "../../../agents/questions"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { QuestionNotFoundError } from "../../api/errors"
import { response } from "../location"

function missingRequest(id: UserQuestions.ID) {
  return new QuestionNotFoundError({ requestID: id, message: `Question request not found: ${id}` })
}

export const QuestionHandler = HttpApiBuilder.group(Api, "server.question", (handlers) =>
  Effect.gen(function* () {
    const withOwnedQuestion = Effect.fnUntraced(function* <A, E>(
      sessionID: UserQuestions.Request["sessionID"],
      requestID: UserQuestions.ID,
      use: (question: UserQuestions.Interface) => Effect.Effect<A, E>,
    ) {
      const question = yield* UserQuestions.Service
      const request = (yield* question.list()).find((request) => request.id === requestID)
      if (!request || request.sessionID !== sessionID) return yield* missingRequest(requestID)
      return yield* use(question)
    })

    return handlers
      .handle(
        "question.request.list",
        Effect.fn(function* () {
          return yield* response((yield* UserQuestions.Service).list())
        }),
      )
      .handle(
        "session.question.list",
        Effect.fn(function* (ctx) {
          const requests = yield* (yield* UserQuestions.Service).list()
          return { data: requests.filter((request) => request.sessionID === ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.question.reply",
        Effect.fn(function* (ctx) {
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reply({ requestID: ctx.params.requestID, answers: ctx.payload.answers })
              .pipe(Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.question.reject",
        Effect.fn(function* (ctx) {
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reject(ctx.params.requestID)
              .pipe(Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
