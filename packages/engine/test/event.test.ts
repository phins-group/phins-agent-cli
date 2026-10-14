import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { EventBus } from "../src/runtime/events/bus"
import { Event } from "../src/contracts/events/event"
import { Session } from "../src/contracts/session/info"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionV1 } from "../src/contracts/session/compat"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { Database } from "../src/storage/database"
import { EventSequenceTable, EventTable } from "../src/storage/tables/events"
import { Location } from "../src/workspace/location"
import { AbsolutePath } from "../src/shared/schema"
import { Workspace as WorkspaceIdentity } from "../src/contracts/workspace/workspace"
import { asc, eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({
      directory: AbsolutePath.make("project"),
      workspaceID: WorkspaceIdentity.ID.make("wrk_test"),
    }),
  ),
)
const Message = EventBus.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventBus.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventBus.define({
  type: "test.sent",
  durable: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const BatchFirst = EventBus.define({
  type: "test.batch.first",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const BatchSecond = EventBus.define({
  type: "test.batch.second",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventBus.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventBus.define({
  type: "test.versioned",
  durable: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved
const TranscriptRemovedV1 = SessionV1.Event.MessageRemoved
const TranscriptRemovedV2 = SessionEvent.Transcript.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})
const serializedSettlement = (sessionID: Session.ID, seq = 0): EventBus.SerializedEvent => ({
  id: EventBus.ID.create(),
  type: EventBus.versionedType(
    SessionEvent.VerificationSettled.type,
    SessionEvent.VerificationSettled.durable!.version,
  ),
  seq,
  aggregateID: sessionID,
  data: {
    sessionID,
    timestamp: 20,
    settlement: {
      id: VerificationReceipt.ID.make("vrc_event_replay_authority"),
      verdict: "missing",
      checks: [],
      reason: "No trusted verifier selected",
    },
  },
})

const eventLayer = Layer.mergeAll(EventBus.layerWith().pipe(Layer.provide(Database.defaultLayer)), Database.defaultLayer)
const it = testEffect(eventLayer.pipe(Layer.provideMerge(locationLayer)))
const itWithoutLocation = testEffect(eventLayer)

describe("EventV2", () => {
  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceIdentity.ID.make("wrk_test"),
      })
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const event = yield* events.publish(VersionedMessage, {
        id: "one",
        text: "hello",
      })

      expect(event.type).toBe("test.versioned")
      expect(event.durable?.version).toBe(2)
    }),
  )

  it.effect("selects the latest durable definition independent of declaration order", () =>
    Effect.sync(() => {
      const latest = EventBus.define({
        type: "test.out-of-order",
        durable: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      const historical = EventBus.define({
        type: "test.out-of-order",
        durable: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(Event.latest([latest, historical]).get("test.out-of-order")).toBe(latest)
      expect(Event.latest([historical, latest]).get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, {
        id: "one",
        text: "hello",
      })
      yield* events.publish(SyncMessage, {
        id: "one",
        text: "after unsubscribe",
      })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({
        id: "one",
        text: "after unsubscribe",
      })
    }),
  )

  it.effect("routes single and batch durable projectors by exact event version", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const received = new Array<string>()
      const singleV1 = SessionV1.MessageID.ascending("msg_single_v1")
      const singleV2 = SessionV1.MessageID.ascending("msg_single_v2")
      const batchV1 = SessionV1.MessageID.ascending("msg_batch_v1")
      const batchV2 = SessionV1.MessageID.ascending("msg_batch_v2")
      yield* events.project(TranscriptRemovedV1, (event) =>
        Effect.sync(() => received.push(`v1:${event.data.messageID}`)),
      )
      yield* events.project(TranscriptRemovedV2, (event) =>
        Effect.sync(() => received.push(`v2:${event.data.messageID}`)),
      )

      yield* events.publish(TranscriptRemovedV1, {
        sessionID: aggregateID,
        messageID: singleV1,
      })
      yield* events.publish(TranscriptRemovedV2, {
        sessionID: aggregateID,
        messageID: singleV2,
      })
      yield* events.publishBatch([
        {
          definition: TranscriptRemovedV1,
          data: { sessionID: aggregateID, messageID: batchV1 },
        },
        {
          definition: TranscriptRemovedV2,
          data: { sessionID: aggregateID, messageID: batchV2 },
        },
      ])

      expect(received).toEqual([
        `v1:${singleV1}`,
        `v2:${singleV2}`,
        `v1:${batchV1}`,
        `v2:${batchV2}`,
      ])
    }),
  )

  it.effect("keeps typed live subscriptions routed by unversioned public type", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const subscribeV1 = SessionV1.MessageID.ascending("msg_subscribe_v1")
      const subscribeV2 = SessionV1.MessageID.ascending("msg_subscribe_v2")
      const v1 = yield* events
        .subscribe(TranscriptRemovedV1)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      const v2 = yield* events
        .subscribe(TranscriptRemovedV2)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const first = yield* events.publish(TranscriptRemovedV1, {
        sessionID: aggregateID,
        messageID: subscribeV1,
      })
      const second = yield* events.publish(TranscriptRemovedV2, {
        sessionID: aggregateID,
        messageID: subscribeV2,
      })

      expect(Array.from(yield* Fiber.join(v1))).toEqual([first, second])
      expect(Array.from(yield* Fiber.join(v2))).toEqual([first, second])
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<string>()
      const aggregateID = EventBus.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        {
          commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)),
        },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("commits an aggregate batch before notifying observers in event order", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      const observed = new Array<string>()
      yield* events.listen((event) =>
        event.type !== BatchFirst.type && event.type !== BatchSecond.type
          ? Effect.void
          : db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, aggregateID))
              .all()
              .pipe(
                Effect.orDie,
                Effect.tap((rows) => Effect.sync(() => observed.push(`${event.type}:${rows.length}`))),
                Effect.asVoid,
              ),
      )

      const committed = yield* events.publishBatch([
        { definition: BatchFirst, data: { id: aggregateID, text: "first" } },
        {
          definition: BatchSecond,
          data: { id: aggregateID, text: "second" },
        },
      ])

      expect(committed.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(observed).toEqual([`${BatchFirst.type}:2`, `${BatchSecond.type}:2`])
      expect(
        yield* db
          .select({ type: EventTable.type, seq: EventTable.seq })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, aggregateID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { type: EventBus.versionedType(BatchFirst.type, 1), seq: 0 },
        { type: EventBus.versionedType(BatchSecond.type, 1), seq: 1 },
      ])
    }),
  )

  it.effect("rolls back every event and projection when the second batch projector fails", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      const observed = new Array<string>()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_batch_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_batch_probe")
      yield* events.project(BatchFirst, () =>
        db.run("INSERT INTO event_batch_probe (value) VALUES ('first')").pipe(Effect.orDie, Effect.asVoid),
      )
      yield* events.project(BatchSecond, () =>
        db
          .run("INSERT INTO event_batch_probe (value) VALUES ('second')")
          .pipe(Effect.orDie, Effect.andThen(Effect.die("second projector failed"))),
      )
      yield* events.listen((event) => Effect.sync(() => observed.push(event.type)))

      const exit = yield* events
        .publishBatch([
          {
            definition: BatchFirst,
            data: { id: aggregateID, text: "first" },
          },
          {
            definition: BatchSecond,
            data: { id: aggregateID, text: "second" },
          },
        ])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("second projector failed")
      expect(yield* db.all("SELECT value FROM event_batch_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(observed).toEqual([])
    }),
  )

  it.effect("validates batch durability and aggregate identity before writing", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const firstID = EventBus.ID.create()
      const otherID = EventBus.ID.create()

      const liveOnly = yield* events
        .publishBatch([
          { definition: BatchFirst, data: { id: firstID, text: "first" } },
          { definition: Message, data: { text: "live" } },
        ])
        .pipe(Effect.exit)
      const crossAggregate = yield* events
        .publishBatch([
          { definition: BatchFirst, data: { id: firstID, text: "first" } },
          { definition: BatchSecond, data: { id: otherID, text: "second" } },
        ])
        .pipe(Effect.exit)

      expect(String(liveOnly)).toContain("Atomic batches require durable events")
      expect(String(crossAggregate)).toContain("same aggregate")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, firstID)).all()).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, otherID)).all()).toEqual([])
    }),
  )

  it.effect("rejects oversized atomic batches before encoding or writing", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      const exit = yield* events
        .publishBatch(
          Array.from({ length: EventBus.MAX_ATOMIC_BATCH_EVENTS + 1 }, (_, index) => ({
            definition: BatchFirst,
            data: { id: aggregateID, text: String(index) },
          })),
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`limited to ${EventBus.MAX_ATOMIC_BATCH_EVENTS} events`)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("pre-authorizes the whole batch and cannot bypass protected settlement authority", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      const exit = yield* events
        .publishBatch([
          {
            definition: BatchFirst,
            data: { id: aggregateID, text: "first" },
          },
          { definition: SessionEvent.VerificationSettled, data: {} as never },
        ])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("requires verification settlement authority")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("captures a single publish definition before authority and projector routing", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      let typeReads = 0
      let protectedProjections = 0
      const definition = Object.create(BatchFirst) as typeof BatchFirst
      Object.defineProperty(definition, "type", {
        get: () => (++typeReads === 1 ? BatchFirst.type : SessionEvent.VerificationSettled.type),
      })
      yield* events.project(SessionEvent.VerificationSettled, () =>
        Effect.sync(() => {
          protectedProjections += 1
        }),
      )

      const event = yield* events.publish(definition, {
        id: aggregateID,
        text: "single",
      })
      const stored = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(typeReads).toBe(1)
      expect(event.type).toBe(BatchFirst.type)
      expect(stored?.type).toBe(EventBus.versionedType(BatchFirst.type, 1))
      expect(protectedProjections).toBe(0)
    }),
  )

  it.effect("captures a proxied batch definition before authority and projector routing", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      let typeReads = 0
      let protectedProjections = 0
      const definition = new Proxy(BatchSecond, {
        get: (target, property, receiver) => {
          if (property === "type") return ++typeReads === 1 ? BatchSecond.type : SessionEvent.VerificationSettled.type
          return Reflect.get(target, property, receiver)
        },
      })
      yield* events.project(SessionEvent.VerificationSettled, () =>
        Effect.sync(() => {
          protectedProjections += 1
        }),
      )

      const [event] = yield* events.publishBatch([{ definition, data: { id: aggregateID, text: "batch" } }])
      const stored = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(typeReads).toBe(1)
      expect(event?.type).toBe(BatchSecond.type)
      expect(stored?.type).toBe(EventBus.versionedType(BatchSecond.type, 1))
      expect(protectedProjections).toBe(0)
    }),
  )

  it.effect("rejects coercible protected types before single or batch authority checks", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      let coercions = 0
      const protectedLike = {
        [Symbol.toPrimitive]: () => {
          coercions += 1
          return SessionEvent.VerificationSettled.type
        },
      }
      const single = Object.create(BatchFirst) as typeof BatchFirst
      Object.defineProperty(single, "type", { value: protectedLike })
      const batch = new Proxy(BatchSecond, {
        get: (target, property, receiver) =>
          property === "type" ? protectedLike : Reflect.get(target, property, receiver),
      })

      const singleExit = yield* events
        .publish(single, { id: aggregateID, text: "single" })
        .pipe(Effect.exit)
      const batchExit = yield* events
        .publishBatch([{ definition: batch, data: { id: aggregateID, text: "batch" } }])
        .pipe(Effect.exit)

      expect(String(singleExit)).toContain("type must be a primitive string")
      expect(String(batchExit)).toContain("type must be a primitive string")
      expect(coercions).toBe(0)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("rejects non-primitive durable version and aggregate fields", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = EventBus.ID.create()
      const version = Object.create(BatchFirst) as typeof BatchFirst
      Object.defineProperty(version, "durable", {
        value: {
          version: { [Symbol.toPrimitive]: () => 1 },
          aggregate: "id",
        },
      })
      const aggregate = Object.create(BatchSecond) as typeof BatchSecond
      Object.defineProperty(aggregate, "durable", {
        value: {
          version: 1,
          aggregate: { [Symbol.toPrimitive]: () => "id" },
        },
      })

      const versionExit = yield* events
        .publish(version, { id: aggregateID, text: "version" })
        .pipe(Effect.exit)
      const aggregateExit = yield* events
        .publishBatch([{ definition: aggregate, data: { id: aggregateID, text: "aggregate" } }])
        .pipe(Effect.exit)

      expect(String(versionExit)).toContain("version must be a positive safe integer")
      expect(String(aggregateExit)).toContain("aggregate must be a primitive string")
    }),
  )

  it.effect("stops consuming a custom batch iterator at the first over-limit item", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()
      let requested = 0
      const items: Iterable<EventBus.PublishBatchItem> = {
        [Symbol.iterator]: () => ({
          next: () => {
            requested += 1
            if (requested > EventBus.MAX_ATOMIC_BATCH_EVENTS + 1)
              throw new Error("Atomic batch iterator was consumed past its bound")
            return {
              done: false as const,
              value: { definition: BatchFirst, data: { id: aggregateID, text: String(requested) } },
            }
          },
        }),
      }

      const exit = yield* events
        .publishBatch(items as unknown as readonly EventBus.PublishBatchItem[])
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`limited to ${EventBus.MAX_ATOMIC_BATCH_EVENTS} events`)
      expect(requested).toBe(EventBus.MAX_ATOMIC_BATCH_EVENTS + 1)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a durable event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, {
        id: "one",
        text: "after unsubscribe",
      })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<string>()
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, {
        id: "one",
        text: "hello",
      })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventBus.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))
      const fiber = yield* events
        .durable({ aggregateID, after: 0 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(DurableMessage, durableData(aggregateID, "two"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = EventBus.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(Database.defaultLayer))

      yield* Effect.gen(function* () {
        const events = yield* EventBus.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(DurableMessage, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(Layer.mergeAll(Database.defaultLayer, eventLayer)))
    }),
  )

  it.effect("reads a multi-page durable history without gaps, duplicates or another aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const other = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(other, "private"))
      for (const offset of [0, 200]) {
        yield* events.publishBatch(Array.from({ length: Math.min(200, 260 - offset) }, (_, index) => ({
          definition: DurableMessage,
          data: durableData(aggregateID, String(index + offset)),
        })))
      }
      const rows = yield* events.durable({ aggregateID, after: 0 }).pipe(Stream.take(259), Stream.runCollect)
      expect(Array.from(rows).map((event) => event.durable?.seq)).toEqual(Array.from({ length: 259 }, (_, index) => index + 1))
      expect(Array.from(rows).every((event) => event.durable?.aggregateID === aggregateID)).toBe(true)
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const count = 260
      const fiber = yield* events
        .durable({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(DurableMessage, durableData(aggregateID, "durable"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("captures a public replay event before protected authority and manifest lookup", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const sessionID = Session.ID.create()
      const protectedEvent = serializedSettlement(sessionID)
      let typeReads = 0
      let protectedProjections = 0
      const event = new Proxy(protectedEvent, {
        get: (target, property, receiver) => {
          if (property === "type") return ++typeReads === 1 ? "test.unprotected.replay.1" : target.type
          return Reflect.get(target, property, receiver)
        },
      })
      yield* events.project(SessionEvent.VerificationSettled, () =>
        Effect.sync(() => {
          protectedProjections += 1
        }),
      )

      const exit = yield* events.replay(event).pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type test.unprotected.replay.1")
      expect(typeReads).toBe(1)
      expect(protectedProjections).toBe(0)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
    }),
  )

  it.effect("captures replayAll events once before protected preflight and replay", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const sessionID = Session.ID.create()
      const protectedEvent = serializedSettlement(sessionID)
      let typeReads = 0
      let protectedProjections = 0
      const event = new Proxy(protectedEvent, {
        get: (target, property, receiver) => {
          if (property === "type") return ++typeReads <= 2 ? "test.unprotected.replay-all.1" : target.type
          return Reflect.get(target, property, receiver)
        },
      })
      yield* events.project(SessionEvent.VerificationSettled, () =>
        Effect.sync(() => {
          protectedProjections += 1
        }),
      )

      const exit = yield* events.replayAll([event]).pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type test.unprotected.replay-all.1")
      expect(typeReads).toBe(1)
      expect(protectedProjections).toBe(0)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
    }),
  )

  it.effect("rejects coercible serialized replay fields and owner rotation without coercion", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const sessionID = Session.ID.create()
      const base = serializedSettlement(sessionID)
      let coercions = 0
      const coercible = (value: string | number) => ({
        [Symbol.toPrimitive]: () => {
          coercions += 1
          return value
        },
      })
      const invalid = [
        { event: { ...base, id: coercible(base.id) }, message: "id must be a primitive event ID string" },
        { event: { ...base, seq: coercible(0) }, message: "sequence must be a nonnegative safe integer" },
        { event: { ...base, aggregateID: coercible(sessionID) }, message: "aggregate ID must be a primitive string" },
        { event: { ...base, data: [] }, message: "data must be a record" },
      ] as const
      for (const test of invalid) {
        const exit = yield* events.replay(test.event as unknown as EventBus.SerializedEvent).pipe(Effect.exit)
        expect(String(exit)).toContain(test.message)
      }
      const options = {
        ownerRotation: {
          eventID: coercible(base.id),
          nextOwnerID: "owner-next",
        },
      }
      const optionExit = yield* events
        .replayAll([base], options as unknown as EventBus.ReplayOptions)
        .pipe(Effect.exit)

      expect(String(optionExit)).toContain("owner-rotation event ID must be an event ID string")
      expect(coercions).toBe(0)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
    }),
  )

  it.effect("replays durable events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "hello"),
      })

      expect(received[0]?.type).toBe(DurableMessage.type)
      expect(received[0]?.data).toEqual(durableData(aggregateID, "hello"))
    }),
  )

  it.effect("routes replay projectors by the serialized event version", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const received = new Array<string>()
      yield* events.project(TranscriptRemovedV1, (event) =>
        Effect.sync(() => received.push(`v1:${event.data.messageID}`)),
      )
      yield* events.project(TranscriptRemovedV2, (event) =>
        Effect.sync(() => received.push(`v2:${event.data.messageID}`)),
      )

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(TranscriptRemovedV1.type, 1),
        seq: 0,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_replay_v1" },
      })
      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(TranscriptRemovedV2.type, 2),
        seq: 1,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_replay_v2" },
      })

      expect(received).toEqual(["v1:msg_replay_v1", "v2:msg_replay_v2"])
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventBus.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = Session.ID.create()
        const payloadAggregateID = Session.ID.create()
        const received = new Array<EventBus.Payload>()
        yield* events.publish(DurableMessage, durableData(payloadAggregateID, "seed"))
        yield* events.project(DurableMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventBus.ID.create(),
            type: EventBus.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: durableData(payloadAggregateID, "replayed"),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })
      const exit = yield* events
        .replay({
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 5,
          aggregateID,
          data: durableData(aggregateID, "bad"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const received = new Array<typeof SessionEvent.ContextUpdated.Type>()
      yield* events.project(SessionEvent.ContextUpdated, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(SessionEvent.ContextUpdated.type, 1),
        seq: 0,
        aggregateID,
        data: {
          sessionID: aggregateID,
          messageID: "msg_context",
          timestamp: 0,
          text: "context",
        },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const exit = yield* events
        .replay({
          id: EventBus.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventBus.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "three"),
        },
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 3,
          aggregateID,
          data: durableData(aggregateID, "four"),
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner accepts an exact replay without changing authority", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const id = EventBus.ID.create()
      const replayed = {
        id,
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "owned"),
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      yield* events.replay(replayed, {
        ownerID: "owner-b",
        strictOwner: true,
      })

      expect(
        yield* db
          .select({ ownerID: EventSequenceTable.owner_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ ownerID: "owner-a" })
    }),
  )

  it.effect("atomically rotates replay ownership while former-owner exact retries stay idempotent", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const first = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "before-rotation"),
      }
      const rotation = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 1,
        aggregateID,
        data: durableData(aggregateID, "rotation"),
      }

      yield* events.replay(first, { ownerID: "owner-a", strictOwner: true })
      yield* events.replay(rotation, {
        ownerID: "owner-a",
        strictOwner: true,
        ownerRotation: { eventID: rotation.id, nextOwnerID: "owner-b" },
      })

      const authority = () =>
        db
          .select({
            seq: EventSequenceTable.seq,
            ownerID: EventSequenceTable.owner_id,
            ownerGeneration: EventSequenceTable.owner_generation,
          })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie)
      expect(yield* authority()).toEqual({
        seq: 1,
        ownerID: "owner-b",
        ownerGeneration: 1,
      })

      // A source retry can replay both the earlier prefix and the exact
      // rotation event after ownership has already moved.
      yield* events.replayAll([first, rotation], {
        ownerID: "owner-a",
        strictOwner: true,
        ownerRotation: { eventID: rotation.id, nextOwnerID: "owner-b" },
      })
      expect(yield* authority()).toEqual({
        seq: 1,
        ownerID: "owner-b",
        ownerGeneration: 1,
      })

      const formerOwner = yield* events
        .replay(
          {
            id: EventBus.ID.create(),
            type: EventBus.versionedType(DurableMessage.type, 1),
            seq: 2,
            aggregateID,
            data: durableData(aggregateID, "former-owner-write"),
          },
          { ownerID: "owner-a", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(formerOwner)).toContain("Replay owner mismatch")
      expect(yield* authority()).toEqual({
        seq: 1,
        ownerID: "owner-b",
        ownerGeneration: 1,
      })

      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "new-owner-write"),
        },
        { ownerID: "owner-b", strictOwner: true },
      )
      expect(yield* authority()).toEqual({
        seq: 2,
        ownerID: "owner-b",
        ownerGeneration: 1,
      })
    }),
  )

  it.effect("rolls back owner rotation when the final event projection fails", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "seed"),
        },
        { ownerID: "owner-a", strictOwner: true },
      )
      yield* events.project(DurableMessage, () => Effect.die(new Error("projection failed")))
      const final = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 1,
        aggregateID,
        data: durableData(aggregateID, "failed-rotation"),
      }

      const exit = yield* events
        .replay(final, {
          ownerID: "owner-a",
          strictOwner: true,
          ownerRotation: { eventID: final.id, nextOwnerID: "owner-b" },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(
        yield* db
          .select({
            seq: EventSequenceTable.seq,
            ownerID: EventSequenceTable.owner_id,
            ownerGeneration: EventSequenceTable.owner_generation,
          })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ seq: 0, ownerID: "owner-a", ownerGeneration: 0 })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects an exact final rotation when a third owner has taken authority", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const first = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "third-owner-prefix"),
      }
      const rotation = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 1,
        aggregateID,
        data: durableData(aggregateID, "third-owner-rotation"),
      }
      yield* events.replay(first, { ownerID: "owner-a", strictOwner: true })
      yield* events.replay(rotation, {
        ownerID: "owner-a",
        strictOwner: true,
        ownerRotation: { eventID: rotation.id, nextOwnerID: "owner-b" },
      })
      yield* events.claim(aggregateID, "owner-c")

      const exit = yield* events
        .replayAll([first, rotation], {
          ownerID: "owner-a",
          strictOwner: true,
          ownerRotation: { eventID: rotation.id, nextOwnerID: "owner-b" },
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
      expect(
        yield* db
          .select({
            seq: EventSequenceTable.seq,
            ownerID: EventSequenceTable.owner_id,
            ownerGeneration: EventSequenceTable.owner_generation,
          })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ seq: 1, ownerID: "owner-c", ownerGeneration: 2 })
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "owned"))
      const replayed = {
        id: published.id,
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({
          ownerID: EventSequenceTable.owner_id,
          ownerGeneration: EventSequenceTable.owner_generation,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ ownerID: "owner-a", ownerGeneration: 1 })
      const exit = yield* events
        .replay(
          {
            ...replayed,
            id: EventBus.ID.create(),
            seq: 1,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "owned"),
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({
          seq: EventSequenceTable.seq,
          ownerID: EventSequenceTable.owner_id,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "local"))

      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "fenced"),
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({
          seq: EventSequenceTable.seq,
          ownerID: EventSequenceTable.owner_id,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventBus.ID.create(),
            type: EventBus.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([
        {
          id: replayed.id,
          durable: { seq: 0, version: 1 },
          data: replayed.data,
        },
      ])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      const aggregateID = Session.ID.create()
      const replayed = {
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "original"),
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: durableData(aggregateID, "divergent") }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const aggregateID = Session.ID.create()
      const id = EventBus.ID.create()
      yield* events.replay({
        id,
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })

      const exit = yield* events
        .replay({
          id,
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "second"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventBus.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "first"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventBus.ID.create(),
          type: EventBus.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({
          seq: EventSequenceTable.seq,
          ownerID: EventSequenceTable.owner_id,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const aggregateID = EventBus.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({
          seq: EventSequenceTable.seq,
          ownerID: EventSequenceTable.owner_id,
          ownerGeneration: EventSequenceTable.owner_generation,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2", ownerGeneration: 2 })
    }),
  )

  it.effect("remove clears durable event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const received = new Array<EventBus.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.remove(aggregateID)
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventBus.ID.create(),
        type: EventBus.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })

      expect(received[0]?.data).toEqual(durableData(aggregateID, "replayed"))
    }),
  )
})
