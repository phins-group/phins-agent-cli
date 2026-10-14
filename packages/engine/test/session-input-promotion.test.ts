import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { Location } from "../src/workspace/location"
import * as Receiver from "../src/execution/control/receiver"
import { PermissionOrigin } from "../src/security/permissions/origin"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionInputOrigin } from "../src/sessions/input/origin"
import * as InputTurns from "../src/sessions/input/turns"
import { SessionMessage } from "../src/sessions/messages/service"
import { Prompt } from "../src/contracts/session/prompt"
import { Session as SessionSchema } from "../src/contracts/session/info"
import { SessionInputTable } from "../src/storage/tables/sessions"
import {
  counts,
  expected,
  layer,
  location,
  node,
  sessionID,
  setup,
} from "./fixture/node-control"
import { testEffect } from "./lib/effect"

const it = testEffect(layer)
const admit = (name: string, delivery: "steer" | "queue" = "steer") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* SessionInput.admit(db, yield* EventBus.Service, {
      id: SessionMessage.ID.make(`msg_${name}`),
      sessionID,
      prompt: Prompt.make({ text: name }),
      delivery,
    })
  })
const find = (id: SessionMessage.ID) =>
  Database.Service.use(({ db }) => SessionInput.find(db, id))
const promote = (selection: Pick<InputTurns.Turn, "delivery" | "messageIDs">) =>
  Effect.gen(function* () {
    return yield* SessionInput.promoteSelected(
      (yield* Database.Service).db,
      yield* EventBus.Service,
      sessionID,
      selection,
    )
  })

describe("captured local input promotion", () => {
  it.effect(
    "promotes captured IDs only and defers input admitted after the cutoff",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first")
        const selection = (yield* InputTurns.pending(
          sessionID,
          first.admittedSeq,
        ))[0]!
        const second = yield* admit("second")
        expect(yield* promote(selection)).toBe(1)
        expect((yield* find(first.id))?.promotedSeq).toBeDefined()
        expect((yield* find(second.id))?.promotedSeq).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 3 })
        expect(yield* promote(selection)).toBe(0)
        expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 3 })
      }),
  )

  it.effect(
    "promotes selected queued input without draining its successor",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first", "queue")
        const second = yield* admit("second", "queue")
        const selection = (yield* InputTurns.pending(sessionID))[0]!
        expect(yield* promote(selection)).toBe(1)
        expect((yield* find(first.id))?.promotedSeq).toBeDefined()
        expect((yield* find(second.id))?.promotedSeq).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 3 })
      }),
  )

  it.effect(
    "rejects duplicate IDs, multiple queues and delivery mismatches before any promotion",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first", "queue")
        const second = yield* admit("second", "queue")
        const before = yield* counts
        for (const selection of [
          { delivery: "steer" as const, messageIDs: [first.id] },
          { delivery: "queue" as const, messageIDs: [first.id, second.id] },
          { delivery: "steer" as const, messageIDs: [first.id, first.id] },
        ]) {
          expect(
            yield* promote(selection).pipe(Effect.catchDefect(Effect.succeed)),
          ).toBeInstanceOf(SessionInput.InputLifecycleConflict)
          expect(yield* counts).toEqual(before)
        }
      }),
  )

  it.effect(
    "does not replace a removed selection with the next queued input",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first", "queue")
        const second = yield* admit("second", "queue")
        const selection = (yield* InputTurns.pending(sessionID))[0]!
        const { db } = yield* Database.Service
        yield* db
          .delete(SessionInputTable)
          .where(eq(SessionInputTable.id, first.id))
          .run()
          .pipe(Effect.orDie)
        const before = yield* counts
        expect(
          yield* promote(selection).pipe(Effect.catchDefect(Effect.succeed)),
        ).toBeInstanceOf(SessionInput.InputLifecycleConflict)
        expect(yield* counts).toEqual(before)
        expect((yield* find(second.id))?.promotedSeq).toBeUndefined()
      }),
  )

  it.effect(
    "validates the entire selected group before publishing its first event",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first")
        const second = yield* admit("second")
        const selection = (yield* InputTurns.pending(sessionID))[0]!
        const { db } = yield* Database.Service
        yield* db
          .update(SessionInputTable)
          .set({ delivery: "queue" })
          .where(eq(SessionInputTable.id, second.id))
          .run()
          .pipe(Effect.orDie)
        const before = yield* counts
        expect(
          yield* promote(selection).pipe(Effect.catchDefect(Effect.succeed)),
        ).toBeInstanceOf(SessionInput.InputLifecycleConflict)
        expect(yield* counts).toEqual(before)
        expect((yield* find(first.id))?.promotedSeq).toBeUndefined()
      }),
  )

  it.effect(
    "rejects cross-session selection instead of retargeting the captured input",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first")
        const { db } = yield* Database.Service
        const before = yield* counts
        expect(
          yield* SessionInput.promoteSelected(
            db,
            yield* EventBus.Service,
            SessionSchema.ID.make("ses_other"),
            { delivery: "steer", messageIDs: [first.id] },
          ).pipe(Effect.catchDefect(Effect.succeed)),
        ).toBeInstanceOf(SessionInput.InputLifecycleConflict)
        expect(yield* counts).toEqual(before)
      }),
  )

  it.effect(
    "snapshots caller-owned IDs before an asynchronous publication",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* admit("first")
        const second = yield* admit("second")
        const ids = [first.id]
        const events = yield* EventBus.Service
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const guarded = {
          ...events,
          publish: ((...args: Parameters<typeof events.publish>) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(events.publish(...args)),
            )) as typeof events.publish,
        }
        const fiber = yield* SessionInput.promoteSelected(
          (yield* Database.Service).db,
          guarded,
          sessionID,
          { delivery: "steer", messageIDs: ids },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        ids.push(second.id)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(fiber)).toBe(1)
        expect((yield* find(second.id))?.promotedSeq).toBeUndefined()
      }),
  )

  it.effect("concurrent exact selections still project one user message", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit("first")
      const selection = (yield* InputTurns.pending(sessionID))[0]!
      yield* Effect.all([promote(selection), promote(selection)], {
        concurrency: "unbounded",
      })
      expect(yield* counts).toEqual({ inputs: 1, origins: 0, events: 2 })
    }),
  )

  it.effect(
    "does not treat a plan or transient permission ceiling as execution authority",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* admit("first")
        const selection = (yield* InputTurns.pending(sessionID))[0]!
        const before = yield* counts
        expect(
          yield* PermissionOrigin.restrict(
            { sessionID, rules: [], valid: Effect.succeed(true) },
            promote(selection),
          ).pipe(Effect.flip),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(yield* counts).toEqual(before)
        yield* Receiver.receivePrompt(node(), expected)
        const plan = yield* InputTurns.pending(sessionID)
        const recorded = yield* counts
        for (const turn of plan) {
          expect(yield* promote(turn).pipe(Effect.flip)).toBeInstanceOf(
            SessionInputOrigin.UnavailableError,
          )
          expect(yield* counts).toEqual(recorded)
        }
      }),
  )

  for (const mode of ["selected", "legacy"] as const)
    it.effect(
      `stops ${mode} batch promotion if remote provenance arrives between events`,
      () =>
        Effect.gen(function* () {
          yield* setup
          const first = yield* admit("first")
          const second = yield* admit("second")
          const selection = (yield* InputTurns.pending(sessionID))[0]!
          const events = yield* EventBus.Service
          const receive = Receiver.receivePrompt(node(), expected).pipe(
            Effect.provideService(Database.Service, yield* Database.Service),
            Effect.provideService(EventBus.Service, events),
            Effect.provideService(Location.Service, location),
            Effect.orDie,
            Effect.asVoid,
          )
          yield* events.listen((event) =>
            event.type === SessionEvent.Prompted.type &&
            (event as SessionEvent.Prompted).data.messageID === first.id
              ? receive
              : Effect.void,
          )
          const work =
            mode === "selected"
              ? promote(selection)
              : SessionInput.promoteSteers(
                  (yield* Database.Service).db,
                  events,
                  sessionID,
                  Number.MAX_SAFE_INTEGER,
                )
          expect(yield* work.pipe(Effect.flip)).toBeInstanceOf(
            SessionInputOrigin.UnavailableError,
          )
          expect((yield* find(first.id))?.promotedSeq).toBeDefined()
          expect((yield* find(second.id))?.promotedSeq).toBeUndefined()
          expect(yield* counts).toEqual({ inputs: 3, origins: 1, events: 4 })
        }),
    )
})
