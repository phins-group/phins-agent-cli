import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import * as Receiver from "../src/execution/control/receiver"
import { SessionInput } from "../src/sessions/input/inbox"
import * as InputTurns from "../src/sessions/input/turns"
import { SessionMessage } from "../src/sessions/messages/service"
import { Prompt } from "../src/contracts/session/prompt"
import {
  SessionInputOriginTable,
  SessionInputTable,
} from "../src/storage/tables/sessions"
import {
  counts,
  expected,
  layer,
  node,
  proof,
  sessionID,
  setup,
} from "./fixture/node-control"
import { testEffect } from "./lib/effect"

const it = testEffect(layer)
const messages = (...values: string[]) =>
  values.map((value) => SessionMessage.ID.make(value))
const local = (name: string, delivery: "steer" | "queue") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* SessionInput.admit(db, yield* EventBus.Service, {
      id: SessionMessage.ID.make(`msg_${name}`),
      sessionID,
      prompt: Prompt.make({ text: "Local prompt" }),
      delivery,
    })
  })

describe("read-only pending input turn plan", () => {
  it.effect("an empty inbox yields no turns and no state changes", () =>
    Effect.gen(function* () {
      yield* setup
      expect(yield* InputTurns.pending(sessionID)).toEqual([])
      expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
    }),
  )

  it.effect("captures only input admitted through the requested cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* local("a", "steer")
      yield* local("b", "queue")
      expect(yield* InputTurns.pending(sessionID, -1)).toEqual([])
      expect(yield* InputTurns.pending(sessionID, first.admittedSeq)).toEqual([
        { source: "local", delivery: "steer", messageIDs: messages("msg_a") },
      ])
      expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 2 })
      for (const cutoff of [
        -2,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ])
        expect(
          yield* InputTurns.pending(sessionID, cutoff).pipe(Effect.flip),
        ).toBeInstanceOf(InputTurns.PlanError)
      expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 2 })
    }),
  )

  it.effect(
    "groups only adjacent local steers and keeps every queue input separate",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* local("a", "steer")
        yield* local("b", "steer")
        yield* local("c", "queue")
        yield* local("d", "queue")
        yield* local("e", "steer")
        const plan = yield* InputTurns.pending(sessionID)
        expect(plan).toEqual([
          {
            source: "local",
            delivery: "steer",
            messageIDs: messages("msg_a", "msg_b"),
          },
          { source: "local", delivery: "queue", messageIDs: messages("msg_c") },
          { source: "local", delivery: "queue", messageIDs: messages("msg_d") },
          { source: "local", delivery: "steer", messageIDs: messages("msg_e") },
        ])
        expect(Object.isFrozen(plan)).toBe(true)
        expect(
          plan.every(
            (turn) => Object.isFrozen(turn) && Object.isFrozen(turn.messageIDs),
          ),
        ).toBe(true)
        expect(yield* counts).toEqual({ inputs: 5, origins: 0, events: 5 })
      }),
  )

  it.effect(
    "does not merge local and remote commands, even with the same actor and grant",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* local("a", "steer")
        yield* local("b", "steer")
        yield* local("c", "queue")
        yield* Receiver.receivePrompt(node(), expected)
        const other = {
          ...expected,
          attempt: {
            ...expected.attempt,
            id: "80000000-0000-4000-8000-000000000009",
          },
        }
        const second = {
          ...proof(),
          ...other,
          command: { ...proof().command, id: other.attempt.id },
        }
        yield* Receiver.receivePrompt(
          node(async () => second),
          other,
        )
        const channel = {
          ...other,
          scope: { ...other.scope, source: "channel" as const },
          attempt: {
            ...other.attempt,
            id: "80000000-0000-4000-8000-000000000010",
          },
        }
        yield* Receiver.receivePrompt(
          node(async () => ({
            ...proof(),
            ...channel,
            command: { ...proof().command, id: channel.attempt.id },
          })),
          channel,
        )
        const before = yield* counts
        expect(yield* InputTurns.pending(sessionID)).toEqual([
          {
            source: "local",
            delivery: "steer",
            messageIDs: messages("msg_a", "msg_b"),
          },
          { source: "local", delivery: "queue", messageIDs: messages("msg_c") },
          {
            source: "web",
            delivery: "queue",
            messageIDs: messages(`msg_node_${expected.attempt.id}`),
          },
          {
            source: "web",
            delivery: "queue",
            messageIDs: messages(`msg_node_${other.attempt.id}`),
          },
          {
            source: "channel",
            delivery: "queue",
            messageIDs: messages(`msg_node_${channel.attempt.id}`),
          },
        ])
        expect(yield* counts).toEqual(before)
        expect(before).toEqual({ inputs: 6, origins: 3, events: 6 })
      }),
  )

  it.effect(
    "rejects mismatched, unsupported or malformed provenance instead of planning local fallback",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* Receiver.receivePrompt(node(), expected)
        const { db } = yield* Database.Service
        const row = yield* db
          .select()
          .from(SessionInputOriginTable)
          .get()
          .pipe(Effect.orDie)
        for (const change of [
          { node_id: "changed" },
          { command_id: "changed" },
          { admitted_seq: row!.admitted_seq + 1 },
          { origin: { ...row!.origin, source: "local" } },
          { origin: { ...row!.origin, credential: "PRIVATE_SECRET" } },
        ]) {
          yield* db
            .update(SessionInputOriginTable)
            .set({ ...row!, ...change } as NonNullable<typeof row>)
            .where(eq(SessionInputOriginTable.id, row!.id))
            .run()
            .pipe(Effect.orDie)
          expect(
            yield* InputTurns.pending(sessionID).pipe(Effect.flip),
          ).toBeInstanceOf(InputTurns.PlanError)
        }
        yield* db
          .update(SessionInputOriginTable)
          .set(row!)
          .where(eq(SessionInputOriginTable.id, row!.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionInputTable)
          .set({ delivery: "steer" })
          .where(eq(SessionInputTable.id, row!.id))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* InputTurns.pending(sessionID).pipe(Effect.flip),
        ).toBeInstanceOf(InputTurns.PlanError)
      }),
  )

  it.effect(
    "retained provenance without an input remains blocked rather than disappearing from the plan",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* Receiver.receivePrompt(node(), expected)
        const { db } = yield* Database.Service
        yield* db.delete(SessionInputTable).run().pipe(Effect.orDie)
        expect(
          yield* InputTurns.pending(sessionID).pipe(Effect.flip),
        ).toBeInstanceOf(InputTurns.PlanError)
        expect(yield* counts).toEqual({ inputs: 0, origins: 1, events: 1 })
      }),
  )

  it.effect("omits promoted local inputs without promoting pending ones", () =>
    Effect.gen(function* () {
      yield* setup
      const a = yield* local("a", "queue")
      yield* local("b", "queue")
      yield* SessionInput.promoteNextQueued(
        (yield* Database.Service).db,
        yield* EventBus.Service,
        sessionID,
      )
      expect(yield* InputTurns.pending(sessionID)).toEqual([
        { source: "local", delivery: "queue", messageIDs: messages("msg_b") },
      ])
      expect(
        (yield* SessionInput.find((yield* Database.Service).db, a.id))
          ?.promotedSeq,
      ).toBeDefined()
      expect(yield* counts).toEqual({ inputs: 2, origins: 0, events: 3 })
    }),
  )
})
