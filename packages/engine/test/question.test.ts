import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { UserQuestions } from "../src/agents/questions"
import { SessionManager } from "../src/sessions/service"
import { PermissionOrigin } from "../src/security/permissions/origin"
import { testEffect } from "./lib/effect"

const questions = UserQuestions.layer.pipe(Layer.provide(EventBus.defaultLayer))
const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer, questions),
)

const sessionID = SessionManager.ID.make("ses_question_test")
const question: UserQuestions.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

const waitForAsk = Effect.fn("QuestionV2Test.waitForAsk")(function* (
  service: UserQuestions.Interface,
  input: UserQuestions.AskInput,
) {
  const events = yield* EventBus.Service
  const asked = yield* Deferred.make<UserQuestions.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === UserQuestions.Event.Asked.type
      ? Deferred.succeed(asked, event.data as UserQuestions.Request).pipe(
          Effect.asVoid,
        )
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("QuestionV2", () => {
  it.effect("rechecks the captured origin before accepting an answer", () =>
    Effect.gen(function* () {
      const service = yield* UserQuestions.Service
      let valid = true
      const { fiber, request } = yield* PermissionOrigin.restrict(
        {
          sessionID,
          rules: [{ action: "question", resource: "*", effect: "allow" }],
          valid: Effect.sync(() => valid),
        },
        waitForAsk(service, { sessionID, questions: [question] }),
      )
      valid = false
      expect(
        yield* service
          .reply({ requestID: request.id, answers: [["One"]] })
          .pipe(Effect.flip),
      ).toEqual(new UserQuestions.NotFoundError({ requestID: request.id }))
      expect(yield* service.list()).toEqual([request])
      // A negative dismissal remains possible without restoring authority.
      yield* service.reject(request.id)
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
    }),
  )

  it.effect(
    "revocation after the reply event prevents continuation with that answer",
    () =>
      Effect.gen(function* () {
        const service = yield* UserQuestions.Service
        const events = yield* EventBus.Service
        let valid = true
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === UserQuestions.Event.Replied.type) valid = false
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const { fiber, request } = yield* PermissionOrigin.restrict(
          {
            sessionID,
            rules: [{ action: "question", resource: "*", effect: "allow" }],
            valid: Effect.sync(() => valid),
          },
          waitForAsk(service, { sessionID, questions: [question] }),
        )
        yield* service.reply({ requestID: request.id, answers: [["One"]] })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
        expect(yield* service.list()).toEqual([])
      }),
  )

  it.effect(
    "concurrent answers have one winner while origin authorization is pending",
    () =>
      Effect.gen(function* () {
        const service = yield* UserQuestions.Service
        const events = yield* EventBus.Service
        const checking = yield* Deferred.make<void>()
        const allowed = yield* Deferred.make<boolean>()
        let replies = 0
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === UserQuestions.Event.Replied.type) replies++
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const { fiber, request } = yield* PermissionOrigin.restrict(
          {
            sessionID,
            rules: [{ action: "question", resource: "*", effect: "allow" }],
            valid: Deferred.succeed(checking, undefined).pipe(
              Effect.andThen(Deferred.await(allowed)),
            ),
          },
          waitForAsk(service, { sessionID, questions: [question] }),
        )
        const first = yield* service
          .reply({ requestID: request.id, answers: [["One"]] })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(checking)
        expect(
          yield* service
            .reply({ requestID: request.id, answers: [["Other"]] })
            .pipe(Effect.flip),
        ).toEqual(new UserQuestions.NotFoundError({ requestID: request.id }))
        yield* Deferred.succeed(allowed, true)
        yield* Fiber.join(first)
        expect(yield* Fiber.join(fiber)).toEqual([["One"]])
        expect(replies).toBe(1)
      }),
  )

  it.effect("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* UserQuestions.Service
      const events = yield* EventBus.Service
      const published: EventBus.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.v2.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, {
        sessionID,
        questions: [question],
      })

      expect(request.id).toMatch(/^que_/)
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [UserQuestions.Event.Asked.type, request],
        [
          UserQuestions.Event.Replied.type,
          { sessionID, requestID: request.id, answers: [["One"]] },
        ],
      ])
    }),
  )

  it.effect("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* UserQuestions.Service
      const events = yield* EventBus.Service
      const published: EventBus.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === UserQuestions.Event.Rejected.type)
            published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, {
        sessionID,
        questions: [question],
      })

      yield* service.reject(request.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      expect(published.map((event) => event.data)).toEqual([
        { sessionID, requestID: request.id },
      ])

      const unknown = UserQuestions.ID.ascending("que_unknown")
      expect(
        yield* service
          .reply({ requestID: unknown, answers: [] })
          .pipe(Effect.flip),
      ).toEqual(new UserQuestions.NotFoundError({ requestID: unknown }))
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new UserQuestions.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.effect(
    "isolates pending requests by location-layer instance and rejects them on finalization",
    () =>
      Effect.gen(function* () {
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()
        const first = Context.get(
          yield* Layer.buildWithScope(Layer.fresh(questions), firstScope),
          UserQuestions.Service,
        )
        const second = Context.get(
          yield* Layer.buildWithScope(Layer.fresh(questions), secondScope),
          UserQuestions.Service,
        )
        const fiber = yield* first
          .ask({ sessionID, questions: [question] })
          .pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        const request = (yield* first.list())[0]!

        expect(yield* second.list()).toEqual([])
        expect(
          yield* second
            .reply({ requestID: request.id, answers: [["One"]] })
            .pipe(Effect.flip),
        ).toEqual(new UserQuestions.NotFoundError({ requestID: request.id }))

        yield* Scope.close(firstScope, Exit.void)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
        yield* Scope.close(secondScope, Exit.void)
      }),
  )
})
