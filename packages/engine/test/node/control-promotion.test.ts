import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import path from "node:path"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { EventTable } from "../../src/storage/tables/events"
import { Location } from "../../src/workspace/location"
import * as Promotion from "../../src/execution/control/promotion"
import * as Receiver from "../../src/execution/control/receiver"
import * as Restoration from "../../src/execution/control/restoration"
import { PermissionOrigin } from "../../src/security/permissions/origin"
import { SessionEvent } from "../../src/contracts/events/session"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionInputOrigin } from "../../src/sessions/input/origin"
import { SessionMessage } from "../../src/sessions/messages/service"
import { Prompt } from "../../src/contracts/session/prompt"
import { SessionProjector } from "../../src/sessions/projector"
import { SessionRunState } from "../../src/sessions/run/state"
import {
  SessionMessageTable,
  SessionRunStateTable,
} from "../../src/storage/tables/sessions"
import {
  counts,
  expected,
  layer,
  location,
  node,
  proof,
  sessionID,
  setup,
} from "../fixture/node-control"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(layer)
const target = Object.freeze({
  sessionID,
  messageID: SessionMessage.ID.make(`msg_node_${expected.attempt.id}`),
})
const record = Effect.gen(function* () {
  yield* setup
  return yield* Receiver.receivePrompt(node(), expected)
})
const granted = () => ({
  ...proof(),
  rules: [{ action: "read", resource: "src/*", effect: "allow" as const }],
})
const client = () => node(async () => granted())
const failed = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.exit,
    Effect.tap((exit) => Effect.sync(() => expect(exit._tag).toBe("Failure"))),
  )
const find = Database.Service.use(({ db }) =>
  SessionInput.find(db, target.messageID),
)
const state = Database.Service.use(({ db }) =>
  SessionRunState.load(db, sessionID),
)
const encodeOrigin = Schema.encodeSync(SessionInputOrigin.Origin)

describe("native command promotion and durable run owner", () => {
  it.effect("a new local input can follow a settled remote run without inheriting its authority", () =>
    Effect.gen(function* () {
      yield* record
      const owner = yield* Promotion.startPrompt(client(), target)
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      yield* failed(SessionInputOrigin.requireLocalRun(db, sessionID))
      yield* failed(SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(), sessionID, delivery: "queue",
        prompt: Prompt.make({ text: "Must not join an active remote run" }),
      }))
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
      yield* events.publish(SessionEvent.Run.Settled, {
        sessionID, runID: owner.runID, timestamp: DateTime.makeUnsafe(20),
        outcome: { type: "idle" },
      })
      // A local Resume cannot turn a remote command into local authority.
      yield* failed(SessionInputOrigin.requireLocalRun(db, sessionID))
      const localID = SessionMessage.ID.create()
      yield* SessionInput.admit(db, events, {
        id: localID, sessionID, delivery: "queue",
        prompt: Prompt.make({ text: "A new explicit local request" }),
      })
      yield* SessionInputOrigin.requireLocalRun(db, sessionID)
      expect(yield* SessionInput.promoteSelected(db, events, sessionID, {
        delivery: "queue", messageIDs: [localID],
      })).toBe(1)
      expect((yield* SessionInput.find(db, localID))?.origin).toBeUndefined()
      expect((yield* find)?.origin).toBeDefined()
      yield* failed(Restoration.restoreContinuation(client(), owner))
      yield* failed(SessionInputOrigin.requireLocal(db, sessionID))
    }),
  )

  it.effect("local selection never skips a pending remote head or partially promotes a mixed batch", () =>
    Effect.gen(function* () {
      yield* record
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const localID = SessionMessage.ID.create()
      // Replay can contain mixed admissions. Promotion must still fail closed
      // even though the current local admission API rejects this remote head.
      yield* events.publish(SessionEvent.PromptAdmitted, {
        messageID: localID, sessionID, delivery: "steer",
        prompt: Prompt.make({ text: "Local tail" }), timestamp: DateTime.makeUnsafe(1),
      })
      const before = yield* counts
      yield* failed(SessionInput.promoteSelected(db, events, sessionID, {
        delivery: "steer", messageIDs: [localID, target.messageID],
      }))
      yield* failed(SessionInput.promoteSelected(db, events, sessionID, {
        delivery: "steer", messageIDs: [localID],
      }))
      expect(yield* counts).toEqual(before)
      expect((yield* SessionInput.find(db, localID))?.promotedSeq).toBeUndefined()
      expect((yield* find)?.promotedSeq).toBeUndefined()
    }),
  )

  it.effect(
    "settles only the committed owner when publication notification fails",
    () =>
      Effect.gen(function* () {
        yield* record
        const events = yield* EventBus.Service
        let dispatched = false
        yield* failed(
          Promotion.startPrompt(client(), target, () =>
            Effect.sync(() => {
              dispatched = true
            }),
          ).pipe(
            Effect.provideService(EventBus.Service, {
              ...events,
              publishBatch: (batch) =>
                events
                  .publishBatch(batch)
                  .pipe(
                    Effect.andThen(Effect.die("Fixture notification failed")),
                  ),
            }),
          ),
        )
        expect(dispatched).toBe(false)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 4 })
        expect(yield* state).toMatchObject({
          status: "terminal-failure",
          inputID: target.messageID,
          error: {
            type: "unknown",
            message: "Node command preparation publication failed",
          },
        })
        expect((yield* find)?.promotedSeq).toBe(1)
      }),
  )

  it.effect(
    "commits source-preserving promotion and the exact owner together, without dispatch",
    () =>
      Effect.gen(function* () {
        const input = yield* record
        const pending = yield* Restoration.restorePrompt(client(), target)
        const owner = yield* Promotion.startPrompt(client(), target)
        expect(Object.isFrozen(owner)).toBe(true)
        expect(owner).toMatchObject(target)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
        expect(yield* state).toMatchObject({
          status: "busy",
          runID: owner.runID,
          inputID: target.messageID,
        })
        const promoted = yield* find
        expect(promoted).toMatchObject({ ...input, promotedSeq: 1 })
        const { db } = yield* Database.Service
        const message = yield* db
          .select()
          .from(SessionMessageTable)
          .get()
          .pipe(Effect.orDie)
        expect(message).toMatchObject({
          id: target.messageID,
          type: "user",
          seq: 1,
        })
        expect(message?.data).toMatchObject({ text: input.prompt.text })
        const stored = yield* db
          .select()
          .from(EventTable)
          .all()
          .pipe(Effect.orDie)
        expect(stored.map((event) => event.type)).toEqual([
          "session.next.prompt.origin.admitted.1",
          "session.next.prompt.origin.promoted.1",
          "session.next.run.started.1",
        ])
        expect(stored[1]?.data.origin).toEqual(encodeOrigin(input.origin!))
        expect(yield* pending.valid).toBe(false)
        expect(yield* PermissionOrigin.capture).toEqual([])
        yield* failed(SessionInputOrigin.requireLocal(db, sessionID))
      }),
  )

  it.effect(
    "does not interpret missing, local or caller-supplied origin as an authenticated command",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const local = SessionMessage.ID.make("msg_local")
        yield* SessionInput.admit(db, yield* EventBus.Service, {
          id: local,
          sessionID,
          prompt: Prompt.make({ text: "local" }),
          delivery: "queue",
        })
        let reads = 0
        const source = node(async () => {
          reads++
          return granted()
        })
        for (const value of [
          target,
          { sessionID, messageID: local },
          { ...target, origin: {} },
          { ...target, runID: "run_caller" },
        ])
          yield* failed(Promotion.startPrompt(source, value))
        expect(reads).toBe(0)
        expect(yield* counts).toEqual({ inputs: 1, origins: 0, events: 1 })
      }),
  )

  it.effect(
    "cannot promote a command with a generic permission scope or a revoked native proof",
    () =>
      Effect.gen(function* () {
        yield* record
        const { db } = yield* Database.Service
        yield* failed(
          PermissionOrigin.restrict(
            {
              sessionID,
              rules: [{ action: "*", resource: "*", effect: "allow" }],
              valid: Effect.succeed(true),
            },
            SessionInput.promoteSelected(
              db,
              yield* EventBus.Service,
              sessionID,
              {
                delivery: "queue",
                messageIDs: [target.messageID],
              },
            ),
          ),
        )
        yield* failed(
          Promotion.startPrompt(
            node(async () => {
              throw new Error("PRIVATE_TOKEN")
            }),
            target,
          ),
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "reverifies immediately before committing and does not cache the first proof",
    () =>
      Effect.gen(function* () {
        yield* record
        let reads = 0
        yield* failed(
          Promotion.startPrompt(
            node(async () => {
              if (++reads === 2) throw new Error("revoked")
              return granted()
            }),
            target,
          ),
        )
        expect(reads).toBe(2)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
        expect(yield* state).toBeUndefined()
      }),
  )

  it.effect(
    "rolls back promotion when another run still owns the session",
    () =>
      Effect.gen(function* () {
        yield* record
        const { db } = yield* Database.Service
        const runID = SessionRunState.ID.make("run_existing")
        yield* db
          .insert(SessionRunStateTable)
          .values({
            session_id: sessionID,
            run_id: runID,
            status: "busy",
            time_started: 0,
          })
          .run()
          .pipe(Effect.orDie)
        yield* failed(Promotion.startPrompt(client(), target))
        expect((yield* find)?.promotedSeq).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
        expect(yield* state).toMatchObject({ runID, status: "busy" })
        expect(
          yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie),
        ).toEqual([])
      }),
  )

  it.effect("two competing native preparations commit exactly one owner", () =>
    Effect.gen(function* () {
      yield* record
      const outcomes = yield* Effect.all(
        [
          Promotion.startPrompt(client(), target).pipe(Effect.exit),
          Promotion.startPrompt(client(), target).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      expect(outcomes.filter((exit) => exit._tag === "Failure")).toHaveLength(1)
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
    }),
  )

  it.effect(
    "pins the caller target before waiting and never drains another queued command",
    () =>
      Effect.gen(function* () {
        yield* record
        const next = {
          ...expected,
          attempt: { ...expected.attempt, id: expected.id },
        }
        yield* Receiver.receivePrompt(
          node(async () => ({
            ...granted(),
            attempt: next.attempt,
            command: { ...granted().command, id: next.attempt.id },
          })),
          next,
        )
        const started = Deferred.makeUnsafe<void>(),
          release = Deferred.makeUnsafe<void>()
        const value = { ...target }
        const source = node(async () => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Deferred.await(release))
          return granted()
        })
        const fiber = yield* Promotion.startPrompt(source, value).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        Object.assign(value, {
          sessionID: "ses_other",
          messageID: `msg_node_${next.attempt.id}`,
        })
        yield* Deferred.succeed(release, undefined)
        const owner = yield* Fiber.join(fiber)
        expect(owner).toMatchObject(target)
        const { db } = yield* Database.Service
        expect(
          (yield* SessionInput.find(
            db,
            SessionMessage.ID.make(`msg_node_${next.attempt.id}`),
          ))?.promotedSeq,
        ).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 2, origins: 2, events: 4 })
      }),
  )

  it.effect(
    "rejects missing or changed admission during projection, without orphan promotion events",
    () =>
      Effect.gen(function* () {
        const input = yield* record
        const events = yield* EventBus.Service
        const data = {
          ...target,
          timestamp: input.timeCreated,
          prompt: input.prompt,
          delivery: input.delivery,
          origin: input.origin!,
        }
        for (const change of [
          { origin: { ...input.origin!, userID: expected.id } },
          { prompt: Prompt.make({ text: "changed" }) },
          { delivery: "steer" as const },
          {
            timestamp: DateTime.makeUnsafe(
              DateTime.toEpochMillis(input.timeCreated) + 1,
            ),
          },
          { messageID: SessionMessage.ID.make("msg_missing") },
        ])
          yield* failed(
            events.publish(SessionEvent.OriginPrompted, { ...data, ...change }),
          )
        yield* failed(
          events.publish(SessionEvent.Prompted, {
            ...target,
            timestamp: input.timeCreated,
            prompt: input.prompt,
            delivery: input.delivery,
          }),
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
        expect((yield* find)?.promotedSeq).toBeUndefined()
      }),
  )

  it.effect(
    "refuses local fallback and owner bindings to missing or unpromoted input",
    () =>
      Effect.gen(function* () {
        yield* record
        const events = yield* EventBus.Service
        for (const inputID of [
          undefined,
          target.messageID,
          SessionMessage.ID.make("msg_missing"),
        ])
          yield* failed(
            events.publish(SessionEvent.Run.Started, {
              sessionID,
              runID: SessionRunState.ID.create(),
              timestamp: yield* DateTime.now,
              ...(inputID === undefined ? {} : { inputID }),
            }),
          )
        expect(yield* state).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )
})

describe("command-bound continuation restoration", () => {
  it.effect(
    "restores only the exact active owner and reverifies each permission boundary",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const before = yield* counts
        let reads = 0
        const restored = yield* Restoration.restoreContinuation(
          node(async () => {
            reads++
            return granted()
          }),
          owner,
        )
        expect(yield* restored.valid).toBe(true)
        expect(
          yield* PermissionOrigin.permits(
            { sessionID, action: "read", resources: ["src/a.ts"] },
            [restored],
          ),
        ).toBe(true)
        expect(
          yield* PermissionOrigin.permits(
            { sessionID, action: "edit", resources: ["src/a.ts"] },
            [restored],
          ),
        ).toBe(false)
        expect(reads).toBe(3)
        expect(yield* PermissionOrigin.capture).toEqual([])
        expect(yield* counts).toEqual(before)
        yield* failed(Restoration.restorePrompt(client(), target))
        yield* failed(
          Restoration.restoreContinuation(client(), {
            ...owner,
            runID: SessionRunState.ID.make("run_stale"),
          }),
        )
        yield* failed(
          Restoration.restoreContinuation(client(), {
            ...owner,
            messageID: SessionMessage.ID.make("msg_other"),
          }),
        )
        yield* failed(
          Restoration.restoreContinuation(client(), {
            ...owner,
            source: "local",
          } as typeof owner),
        )
      }),
  )

  it.effect(
    "retains the same command during retry and invalidates its ceiling after settlement",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const restored = yield* Restoration.restoreContinuation(client(), owner)
        const events = yield* EventBus.Service
        yield* events.publish(SessionEvent.Run.Retried, {
          sessionID,
          runID: owner.runID,
          attempt: 1,
          nextRetryAt: DateTime.makeUnsafe(10),
          error: { message: "fixture", isRetryable: true },
        })
        expect(yield* state).toMatchObject({
          inputID: target.messageID,
          runID: owner.runID,
          status: "retrying",
        })
        expect(yield* restored.valid).toBe(true)
        yield* events.publish(SessionEvent.Run.Settled, {
          sessionID,
          runID: owner.runID,
          timestamp: DateTime.makeUnsafe(20),
          outcome: { type: "idle" },
        })
        expect(yield* restored.valid).toBe(false)
        yield* failed(Restoration.restoreContinuation(client(), owner))
        yield* failed(Promotion.startPrompt(client(), target))
        yield* failed(
          events.publish(SessionEvent.Run.Started, {
            sessionID,
            runID: SessionRunState.ID.create(),
            timestamp: DateTime.makeUnsafe(30),
            inputID: target.messageID,
          }),
        )
        expect(yield* state).toMatchObject({
          inputID: target.messageID,
          runID: owner.runID,
          status: "idle",
        })
      }),
  )

  it.effect(
    "will not borrow a newer run, changed input or promoted transcript",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const restored = yield* Restoration.restoreContinuation(client(), owner)
        const { db } = yield* Database.Service
        const initial = yield* db
          .select()
          .from(SessionRunStateTable)
          .get()
          .pipe(Effect.orDie)
        for (const change of [
          { input_id: SessionMessage.ID.make("msg_other") },
          { run_id: SessionRunState.ID.make("run_newer") },
          { status: "interrupted" as const, time_settled: 20 },
        ]) {
          yield* db
            .update(SessionRunStateTable)
            .set({ ...initial!, ...change })
            .run()
            .pipe(Effect.orDie)
          expect(yield* restored.valid).toBe(false)
        }
        yield* db
          .update(SessionRunStateTable)
          .set(initial!)
          .run()
          .pipe(Effect.orDie)
        expect(yield* restored.valid).toBe(true)
        const message = yield* db
          .select()
          .from(SessionMessageTable)
          .get()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionMessageTable)
          .set({
            data: {
              ...message!.data,
              text: "changed",
            } as (typeof SessionMessageTable.$inferInsert)["data"],
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* restored.valid).toBe(false)
        yield* db
          .update(SessionMessageTable)
          .set(message!)
          .run()
          .pipe(Effect.orDie)
        const event = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.prompt.origin.promoted.1"))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .update(EventTable)
          .set({
            data: {
              ...event!.data,
              origin: { ...(event!.data.origin as object), source: "channel" },
            },
          })
          .where(eq(EventTable.id, event!.id))
          .run()
          .pipe(Effect.orDie)
        expect(yield* restored.valid).toBe(false)
      }),
  )

  it.effect(
    "rejects authority when the active owner changes during native verification",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const { db } = yield* Database.Service
        yield* failed(
          Restoration.restoreContinuation(
            node(async () => {
              await Effect.runPromise(
                db
                  .update(SessionRunStateTable)
                  .set({ run_id: SessionRunState.ID.make("run_replaced") })
                  .run()
                  .pipe(Effect.orDie),
              )
              return granted()
            }),
            owner,
          ),
        )
      }),
  )

  it.effect(
    "requires the durable run binding as well as the current projection",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const restored = yield* Restoration.restoreContinuation(client(), owner)
        const { db } = yield* Database.Service
        const event = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.run.started.1"))
          .get()
          .pipe(Effect.orDie)
        const row = yield* db
          .select()
          .from(SessionRunStateTable)
          .get()
          .pipe(Effect.orDie)
        for (const data of [
          { ...event!.data, inputID: "msg_other" },
          { ...event!.data, runID: "run_other" },
          { ...event!.data, timestamp: 999 },
        ]) {
          yield* db
            .update(EventTable)
            .set({ data })
            .where(eq(EventTable.id, event!.id))
            .run()
            .pipe(Effect.orDie)
          expect(yield* restored.valid).toBe(false)
        }
        yield* db
          .update(EventTable)
          .set(event!)
          .where(eq(EventTable.id, event!.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionRunStateTable)
          .set({ time_started: row!.time_started + 1 })
          .run()
          .pipe(Effect.orDie)
        expect(yield* restored.valid).toBe(false)
        yield* db
          .update(SessionRunStateTable)
          .set(row!)
          .run()
          .pipe(Effect.orDie)
        expect(yield* restored.valid).toBe(true)
      }),
  )

  it.effect(
    "rejects revoked or renewed attempt identity instead of upgrading the stored command",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        for (const source of [
          node(async () => {
            throw new Error("revoked")
          }),
          node(async () => ({
            ...granted(),
            attempt: { ...expected.attempt, leaseId: expected.id },
          })),
          node(async () => ({
            ...granted(),
            command: {
              ...proof().command,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            },
          })),
        ])
          yield* failed(Restoration.restoreContinuation(source, owner))
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
      }),
  )

  it.effect(
    "does not resume a command after a later user input is promoted",
    () =>
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const restored = yield* Restoration.restoreContinuation(client(), owner)
        yield* (yield* EventBus.Service).publish(SessionEvent.Prompted, {
          sessionID,
          messageID: SessionMessage.ID.make("msg_newer"),
          timestamp: DateTime.makeUnsafe(1),
          prompt: Prompt.make({ text: "other turn" }),
          delivery: "queue",
        })
        expect(yield* restored.valid).toBe(false)
        yield* failed(Restoration.restoreContinuation(client(), owner))
      }),
  )

  test("reopens a promoted command on disk with a fresh native proof, not an inherited scope", async () => {
    await using tmp = await tmpdir()
    const persistent = () => {
      const database = Database.layerFromPath(
        path.join(tmp.path, "command-owner.sqlite"),
      )
      const events = EventBus.layer.pipe(Layer.provide(database))
      return Layer.mergeAll(
        database,
        events,
        Layer.succeed(Location.Service, location),
        SessionProjector.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
        ),
      )
    }
    const owner = await Effect.runPromise(
      record.pipe(
        Effect.andThen(Promotion.startPrompt(client(), target)),
        Effect.provide(persistent()),
        Effect.scoped,
      ),
    )
    const previous = await Effect.runPromise(
      Restoration.restoreContinuation(client(), owner).pipe(
        Effect.provide(persistent()),
        Effect.scoped,
      ),
    )
    expect(await Effect.runPromise(previous.valid)).toBe(false)
    await Effect.runPromise(
      Effect.gen(function* () {
        const restored = yield* Restoration.restoreContinuation(client(), owner)
        expect(yield* restored.valid).toBe(true)
        expect(yield* state).toMatchObject({
          inputID: target.messageID,
          runID: owner.runID,
        })
        expect(yield* PermissionOrigin.capture).toEqual([])
        yield* failed(
          Restoration.restoreContinuation(
            node(async () => {
              throw new Error("revoked")
            }),
            owner,
          ),
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
      }).pipe(Effect.provide(persistent()), Effect.scoped),
    )
  })

  test("replay rebuilds provenance and the same run owner without granting execution", async () => {
    const recorded = await Effect.runPromise(
      Effect.gen(function* () {
        yield* record
        const owner = yield* Promotion.startPrompt(client(), target)
        const { db } = yield* Database.Service
        return {
          owner,
          rows: yield* db.select().from(EventTable).all().pipe(Effect.orDie),
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const events = yield* EventBus.Service
        const replay = recorded.rows.map((row) => ({
          ...row,
          aggregateID: row.aggregate_id,
        }))
        yield* events.replayAll(replay)
        yield* events.replayAll(replay)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 3 })
        expect(yield* state).toMatchObject({
          inputID: target.messageID,
          runID: recorded.owner.runID,
        })
        expect(yield* PermissionOrigin.capture).toEqual([])
        const { db } = yield* Database.Service
        yield* failed(SessionInputOrigin.requireLocal(db, sessionID))
        const restored = yield* Restoration.restoreContinuation(
          client(),
          recorded.owner,
        )
        expect(yield* restored.valid).toBe(true)
        yield* failed(
          Restoration.restoreContinuation(
            node(async () => {
              throw new Error("revoked")
            }),
            recorded.owner,
          ),
        )
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})
