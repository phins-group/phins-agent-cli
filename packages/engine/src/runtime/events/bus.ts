export * as EventBus from "./bus"

import { Cause, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Event } from "../../contracts/events/event"
import type { Data, Definition, Payload } from "../../contracts/events/event"
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm"
import { Database } from "../../storage/database"
import { EventSequenceTable, EventTable } from "../../storage/tables/events"
import { Location } from "../../workspace/location"
import { ServiceGraph } from "../effect/service-graph"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "../../contracts/events/durable-manifest"
import { SessionEvent } from "../../contracts/events/session"
import { SessionLive } from "../../contracts/session/live"
import { SessionID } from "../../contracts/session/id"
import * as SessionDeltas from "./session-deltas"

export const ID = Event.ID
export type ID = import("../../contracts/events/event").ID
export type { Data, Definition, Payload } from "../../contracts/events/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

export class UnauthorizedEventOperationError extends Schema.TaggedErrorClass<UnauthorizedEventOperationError>()(
  "EventV2.UnauthorizedOperation",
  {
    operation: Schema.Literals(["publish", "replay"]),
    type: Schema.String,
    message: Schema.String,
  },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export interface PublishBatchOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
}

export interface PublishBatchItem<D extends Definition = Definition> {
  readonly definition: D
  readonly data: Data<D>
  readonly options?: PublishBatchOptions
}

export const MAX_ATOMIC_BATCH_EVENTS = 256

export interface ReplayOptions {
  readonly publish?: boolean
  readonly ownerID?: string
  readonly strictOwner?: boolean
  /** Rotate ownership only when this exact durable event commits. */
  readonly ownerRotation?: {
    readonly eventID: ID
    readonly nextOwnerID: string
  }
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly publishBatch: (items: readonly PublishBatchItem[]) => Effect.Effect<readonly Payload[]>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  readonly sessionDeltas: (sessionID: SessionID) => Stream.Stream<SessionLive.Frame>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (event: SerializedEvent, options?: ReplayOptions) => Effect.Effect<void>
  readonly replayAll: (events: SerializedEvent[], options?: ReplayOptions) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@phins/Event") {}

export interface VerificationSettlementPublisherInterface {
  readonly settle: (
    data: Data<typeof SessionEvent.VerificationSettled>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<typeof SessionEvent.VerificationSettled>>
}

export class VerificationSettlementPublisherService extends Context.Service<
  VerificationSettlementPublisherService,
  VerificationSettlementPublisherInterface
>()("@phins/VerificationSettlementPublisher") {}

export interface ProtectedEventReplayInterface {
  readonly replay: (event: SerializedEvent, options?: ReplayOptions) => Effect.Effect<void>
  readonly replayAll: (events: SerializedEvent[], options?: ReplayOptions) => Effect.Effect<string | undefined>
}

export class ProtectedEventReplayService extends Context.Service<
  ProtectedEventReplayService,
  ProtectedEventReplayInterface
>()("@phins/ProtectedEventReplay") {}

const liveSettlementCapability = Object.freeze({})
const protectedReplayCapability = Object.freeze({})
const authorizedOperations = Symbol("@phins/Event/authorizedOperations")

interface AuthorizedOperations {
  readonly publish: <D extends Definition>(
    capability: object,
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly replay: (capability: object, event: SerializedEvent, options?: ReplayOptions) => Effect.Effect<void>
  readonly replayAll: (
    capability: object,
    events: SerializedEvent[],
    options?: ReplayOptions,
  ) => Effect.Effect<string | undefined>
}

type InternalInterface = Interface & {
  readonly [authorizedOperations]: AuthorizedOperations
}

type DefinitionSnapshot = {
  readonly type: string
  readonly durable:
    | {
        readonly version: number
        readonly aggregate: string
      }
    | undefined
  readonly data: Definition["data"]
}

type SerializedEventSnapshot = Readonly<SerializedEvent>

type ReplayOptionsSnapshot = {
  readonly publish: boolean | undefined
  readonly ownerID: string | undefined
  readonly strictOwner: boolean | undefined
  readonly ownerRotation:
    | {
        readonly eventID: ID
        readonly nextOwnerID: string
      }
    | undefined
}

const snapshotDefinition = (definition: Definition): DefinitionSnapshot => {
  const type: unknown = definition.type
  if (typeof type !== "string") {
    throw new InvalidDurableEventError({
      type: "unknown",
      message: "Event definition type must be a primitive string",
    })
  }
  const durable: unknown = definition.durable
  let durableSnapshot: DefinitionSnapshot["durable"]
  if (durable !== undefined) {
    if (typeof durable !== "object" || durable === null) {
      throw new InvalidDurableEventError({
        type,
        message: "Durable event definition must be an object",
      })
    }
    const version: unknown = (durable as { readonly version?: unknown }).version
    const aggregate: unknown = (durable as { readonly aggregate?: unknown }).aggregate
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      throw new InvalidDurableEventError({
        type,
        message: "Durable event version must be a positive safe integer",
      })
    }
    if (typeof aggregate !== "string") {
      throw new InvalidDurableEventError({
        type,
        message: "Durable event aggregate must be a primitive string",
      })
    }
    durableSnapshot = { version, aggregate }
  }
  const data = definition.data
  return {
    type,
    durable: durableSnapshot,
    data,
  }
}

const projectorKey = (definition: DefinitionSnapshot) =>
  definition.durable
    ? versionedType(definition.type, definition.durable.version)
    : definition.type

const snapshotSerializedEvent = (event: SerializedEvent): SerializedEventSnapshot => {
  const type: unknown = event.type
  if (typeof type !== "string") {
    throw new InvalidDurableEventError({
      type: "unknown",
      message: "Serialized event type must be a primitive string",
    })
  }
  const id: unknown = event.id
  if (typeof id !== "string" || !id.startsWith("evt_")) {
    throw new InvalidDurableEventError({
      type,
      message: "Serialized event id must be a primitive event ID string",
    })
  }
  const seq: unknown = event.seq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidDurableEventError({
      type,
      message: "Serialized event sequence must be a nonnegative safe integer",
    })
  }
  const aggregateID: unknown = event.aggregateID
  if (typeof aggregateID !== "string") {
    throw new InvalidDurableEventError({
      type,
      message: "Serialized event aggregate ID must be a primitive string",
    })
  }
  const data: unknown = event.data
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InvalidDurableEventError({
      type,
      message: "Serialized event data must be a record",
    })
  }
  return {
    id: id as ID,
    type,
    seq,
    aggregateID,
    data: data as Record<string, unknown>,
  }
}

const snapshotSerializedEvents = (events: readonly SerializedEvent[]) => {
  if (!Array.isArray(events)) {
    throw new InvalidDurableEventError({
      type: "unknown",
      message: "Replay events must be an array",
    })
  }
  const length: unknown = events.length
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new InvalidDurableEventError({
      type: "unknown",
      message: "Replay event array length must be a nonnegative safe integer",
    })
  }
  const captured = new Array<SerializedEventSnapshot>()
  for (let index = 0; index < length; index++) {
    const event = events[index]
    if (event === undefined) {
      throw new InvalidDurableEventError({
        type: captured[0]?.type ?? "unknown",
        message: `Replay event is missing at index ${index}`,
      })
    }
    captured.push(snapshotSerializedEvent(event))
  }
  return captured as readonly SerializedEventSnapshot[]
}

const snapshotReplayOptions = (options: ReplayOptions | undefined, type: string): ReplayOptionsSnapshot => {
  if (options === undefined) {
    return { publish: undefined, ownerID: undefined, strictOwner: undefined, ownerRotation: undefined }
  }
  if (typeof options !== "object" || options === null) {
    throw new InvalidDurableEventError({ type, message: "Replay options must be an object" })
  }
  const publish: unknown = options.publish
  const ownerID: unknown = options.ownerID
  const strictOwner: unknown = options.strictOwner
  const ownerRotation: unknown = options.ownerRotation
  if (publish !== undefined && typeof publish !== "boolean") {
    throw new InvalidDurableEventError({ type, message: "Replay publish option must be a boolean" })
  }
  if (ownerID !== undefined && typeof ownerID !== "string") {
    throw new InvalidDurableEventError({ type, message: "Replay owner ID must be a primitive string" })
  }
  if (strictOwner !== undefined && typeof strictOwner !== "boolean") {
    throw new InvalidDurableEventError({ type, message: "Replay strict-owner option must be a boolean" })
  }
  if (ownerRotation === undefined) {
    return { publish, ownerID, strictOwner, ownerRotation: undefined }
  }
  if (typeof ownerRotation !== "object" || ownerRotation === null) {
    throw new InvalidDurableEventError({ type, message: "Replay owner rotation must be an object" })
  }
  const eventID: unknown = (ownerRotation as { readonly eventID?: unknown }).eventID
  const nextOwnerID: unknown = (ownerRotation as { readonly nextOwnerID?: unknown }).nextOwnerID
  if (typeof eventID !== "string" || !eventID.startsWith("evt_")) {
    throw new InvalidDurableEventError({ type, message: "Replay owner-rotation event ID must be an event ID string" })
  }
  if (typeof nextOwnerID !== "string") {
    throw new InvalidDurableEventError({
      type,
      message: "Replay next-owner ID must be a primitive string",
    })
  }
  return {
    publish,
    ownerID,
    strictOwner,
    ownerRotation: { eventID: eventID as ID, nextOwnerID },
  }
}

const protectedLiveType = SessionEvent.VerificationSettled.type
const protectedReplayType = versionedType(
  SessionEvent.VerificationSettled.type,
  SessionEvent.VerificationSettled.durable!.version,
)

const assertPublishAuthority = (type: string, capability?: object) =>
  type !== protectedLiveType || capability === liveSettlementCapability
    ? Effect.void
    : Effect.die(
        new UnauthorizedEventOperationError({
          operation: "publish",
          type,
          message: `Publishing protected event ${type} requires verification settlement authority`,
        }),
      )

const assertReplayAuthority = (type: string, capability?: object) =>
  type !== protectedReplayType || capability === protectedReplayCapability
    ? Effect.void
    : Effect.die(
        new UnauthorizedEventOperationError({
          operation: "replay",
          type,
          message: `Replaying protected event ${type} requires protected replay authority`,
        }),
      )

const assertReplayAllAuthority = (events: readonly SerializedEventSnapshot[], capability?: object) => {
  const protectedEvent = events.find((event) => event.type === protectedReplayType)
  return protectedEvent ? assertReplayAuthority(protectedEvent.type, capability) : Effect.void
}

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      const listeners = new Array<Subscriber>()
      const deltas = yield* SessionDeltas.make()
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            {
              discard: true,
            },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, {
            discard: true,
          })
        }),
      )

      function commitDurableEvent(
        definition: DefinitionSnapshot,
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
          readonly nextOwnerID?: string
        },
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (durable) {
            const type = definition.type
            const dataSchema = definition.data
            const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${durable.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidDurableEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(projectorKey(definition)) ?? []
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            .select({
                              seq: EventSequenceTable.seq,
                              ownerID: EventSequenceTable.owner_id,
                            })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          const encoded = Schema.encodeUnknownSync(dataSchema)(event.data) as Record<string, unknown>
                          if (input && input.seq <= latest) {
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            if (
                              stored?.id === event.id &&
                              stored.type === versionedType(type, durable.version) &&
                              isDeepStrictEqual(stored.data, encoded)
                            ) {
                              if (
                                input.nextOwnerID &&
                                input.strictOwner &&
                                row?.ownerID &&
                                row.ownerID !== input.ownerID &&
                                row.ownerID !== input.nextOwnerID
                              ) {
                                yield* Effect.die(
                                  new InvalidDurableEventError({
                                    type: event.type,
                                    message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                                  }),
                                )
                              }
                              const replayOwnerID = input.nextOwnerID ?? input.ownerID
                              if (
                                replayOwnerID &&
                                row?.ownerID !== replayOwnerID &&
                                (row?.ownerID == null || row.ownerID === input.ownerID)
                              ) {
                                yield* db
                                  .update(EventSequenceTable)
                                  .set({
                                    owner_id: replayOwnerID,
                                    owner_generation: sql`${EventSequenceTable.owner_generation} + 1`,
                                  })
                                  .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                  .run()
                                  .pipe(Effect.orDie)
                              }
                              return
                            }
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                              }),
                            )
                          }
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                            return
                          }
                          const seq = input?.seq ?? latest + 1
                          if (input && seq !== latest + 1) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                              }),
                            )
                          }
                          const stored = yield* db
                            .select({
                              aggregateID: EventTable.aggregate_id,
                              seq: EventTable.seq,
                            })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (stored)
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                          const committed = {
                            ...event,
                            durable: {
                              aggregateID,
                              seq,
                              version: durable.version,
                            },
                          } as Payload
                          for (const projector of list) {
                            yield* projector(committed)
                          }
                          if (commit) yield* commit(seq)
                          const replayOwnerID = input?.nextOwnerID ?? input?.ownerID
                          const ownerChanged = replayOwnerID !== undefined && replayOwnerID !== row?.ownerID
                          yield* db
                            .insert(EventSequenceTable)
                            .values([
                              {
                                aggregate_id: aggregateID,
                                seq,
                                owner_id: replayOwnerID,
                                owner_generation: input?.nextOwnerID && input.nextOwnerID !== input.ownerID ? 1 : 0,
                              },
                            ])
                            .onConflictDoUpdate({
                              target: EventSequenceTable.aggregate_id,
                              set: {
                                seq,
                                ...(ownerChanged
                                  ? {
                                      owner_id: replayOwnerID,
                                      owner_generation: sql`${EventSequenceTable.owner_generation} + 1`,
                                    }
                                  : {}),
                              },
                            })
                            .run()
                            .pipe(Effect.orDie)
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(type, durable.version),
                                data: encoded,
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          return { aggregateID, seq }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed) {
                    yield* Effect.forEach(
                      pubsub.durable.get(committed.aggregateID) ?? [],
                      (wake) => PubSub.publish(wake, undefined),
                      {
                        discard: true,
                      },
                    )
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishEvent<D extends Definition>(
        definition: DefinitionSnapshot,
        event: Payload<D>,
        commit?: PublishOptions["commit"],
      ) {
        return Effect.gen(function* () {
          const durable = definition.durable
          if (!durable && commit)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          if (durable) {
            const committed = yield* commitDurableEvent(definition, event as Payload, undefined, commit)
            if (committed) {
              event = {
                ...event,
                durable: {
                  aggregateID: committed.aggregateID,
                  seq: committed.seq,
                  version: durable.version,
                },
              }
              yield* notify(event as Payload, true)
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("Event listener failed", {
                eventID: event.id,
                eventType: event.type,
                cause,
              }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          deltas.publish(event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      function publishWithCapability<D extends Definition>(
        definition: D,
        data: Data<D>,
        options?: PublishOptions,
        capability?: object,
      ) {
        return Effect.gen(function* () {
          const captured = snapshotDefinition(definition)
          yield* assertPublishAuthority(captured.type, capability)
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? {
                  directory: serviceLocation.directory,
                  workspaceID: serviceLocation.workspaceID,
                }
              : undefined)
          return yield* publishEvent(
            captured,
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: captured.type,
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options?.commit,
          )
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return publishWithCapability(definition, data, options)
      }

      function publishBatch(items: readonly PublishBatchItem[]) {
        return Effect.gen(function* () {
          // Capture and authorize the exact definitions that the batch will use.
          const capturedItems = new Array<{
            readonly definition: DefinitionSnapshot
            readonly data: unknown
            readonly options: PublishBatchOptions | undefined
          }>()
          for (const item of items) {
            if (capturedItems.length >= MAX_ATOMIC_BATCH_EVENTS) {
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: capturedItems[0]?.definition.type ?? "unknown",
                  message: `Atomic batches are limited to ${MAX_ATOMIC_BATCH_EVENTS} events`,
                }),
              )
            }
            const definition = snapshotDefinition(item.definition)
            const captured = {
              definition,
              data: item.data,
              options: item.options,
            }
            yield* assertPublishAuthority(definition.type)
            capturedItems.push(captured)
          }
          if (capturedItems.length === 0) return [] as readonly Payload[]

          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const eventIDs = new Set<ID>()
          const prepared = capturedItems.map((item) => {
            const durable = item.definition.durable
            if (!durable) {
              throw new InvalidDurableEventError({
                type: item.definition.type,
                message: "Atomic batches require durable events",
              })
            }
            const aggregateID = (item.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              throw new InvalidDurableEventError({
                type: item.definition.type,
                message: `Expected string aggregate field ${durable.aggregate}`,
              })
            }
            const id = item.options?.id ?? ID.create()
            if (eventIDs.has(id)) {
              throw new InvalidDurableEventError({
                type: item.definition.type,
                message: `Event ${id} appears more than once in the batch`,
              })
            }
            eventIDs.add(id)
            const location =
              item.options?.location ??
              (serviceLocation
                ? {
                    directory: serviceLocation.directory,
                    workspaceID: serviceLocation.workspaceID,
                  }
                : undefined)
            const event = {
              id,
              ...(item.options?.metadata ? { metadata: item.options.metadata } : {}),
              type: item.definition.type,
              ...(location ? { location } : {}),
              data: item.data,
            } as Payload
            return {
              definition: item.definition,
              durable,
              aggregateID,
              event,
              encoded: Schema.encodeUnknownSync(item.definition.data)(item.data) as Record<string, unknown>,
            }
          })
          const aggregateID = prepared[0]!.aggregateID
          const crossAggregate = prepared.find((item) => item.aggregateID !== aggregateID)
          if (crossAggregate) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: crossAggregate.definition.type,
                message: "Atomic batch events must belong to the same aggregate",
              }),
            )
          }

          const committed = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const result = yield* db
                .transaction(
                  () =>
                    Effect.gen(function* () {
                      const row = yield* db
                        .select({ seq: EventSequenceTable.seq })
                        .from(EventSequenceTable)
                        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                        .get()
                        .pipe(Effect.orDie)
                      let seq = row?.seq ?? -1
                      const events = new Array<Payload>()
                      for (const item of prepared) {
                        seq += 1
                        const stored = yield* db
                          .select({
                            aggregateID: EventTable.aggregate_id,
                            seq: EventTable.seq,
                          })
                          .from(EventTable)
                          .where(eq(EventTable.id, item.event.id))
                          .get()
                          .pipe(Effect.orDie)
                        if (stored) {
                          return yield* Effect.die(
                            new InvalidDurableEventError({
                              type: item.event.type,
                              message: `Event ${item.event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                            }),
                          )
                        }
                        const event = {
                          ...item.event,
                          durable: {
                            aggregateID,
                            seq,
                            version: item.durable.version,
                          },
                        } as Payload
                        for (const projector of projectors.get(projectorKey(item.definition)) ?? []) {
                          yield* projector(event)
                        }
                        yield* db
                          .insert(EventSequenceTable)
                          .values([{ aggregate_id: aggregateID, seq }])
                          .onConflictDoUpdate({
                            target: EventSequenceTable.aggregate_id,
                            set: { seq },
                          })
                          .run()
                          .pipe(Effect.orDie)
                        yield* db
                          .insert(EventTable)
                          .values([
                            {
                              id: event.id,
                              aggregate_id: aggregateID,
                              seq,
                              type: versionedType(item.definition.type, item.durable.version),
                              data: item.encoded,
                            },
                          ])
                          .run()
                          .pipe(Effect.orDie)
                        events.push(event)
                      }
                      return events as readonly Payload[]
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)
              yield* Effect.forEach(pubsub.durable.get(aggregateID) ?? [], (wake) => PubSub.publish(wake, undefined), {
                discard: true,
              })
              return result
            }),
          )
          for (const event of committed) yield* notify(event, true)
          return committed
        })
      }

      function replayCapturedWithCapability(
        event: SerializedEventSnapshot,
        options: ReplayOptionsSnapshot,
        capability?: object,
        authorize = true,
      ) {
        return Effect.gen(function* () {
          if (authorize) yield* assertReplayAuthority(event.type, capability)
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Unknown durable event type ${event.type}`,
              }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(snapshotDefinition(definition), payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options.ownerID,
              strictOwner: options.strictOwner,
              nextOwnerID: options.ownerRotation?.eventID === event.id ? options.ownerRotation.nextOwnerID : undefined,
            })
            if (committed && options.publish) {
              yield* notify(
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                  },
                },
                true,
              )
            }
          }
        })
      }

      function replayWithCapability(event: SerializedEvent, options?: ReplayOptions, capability?: object) {
        return Effect.gen(function* () {
          const capturedEvent = snapshotSerializedEvent(event)
          const capturedOptions = snapshotReplayOptions(options, capturedEvent.type)
          yield* replayCapturedWithCapability(capturedEvent, capturedOptions, capability)
        })
      }

      function replay(event: SerializedEvent, options?: ReplayOptions) {
        return replayWithCapability(event, options)
      }

      function replayAllWithCapability(events: SerializedEvent[], options?: ReplayOptions, capability?: object) {
        return Effect.gen(function* () {
          const capturedEvents = snapshotSerializedEvents(events)
          const capturedOptions = snapshotReplayOptions(options, capturedEvents[0]?.type ?? "unknown")
          // Authorization is deliberately checked for the whole batch before
          // any replay can project or commit an earlier event.
          yield* assertReplayAllAuthority(capturedEvents, capability)
          const source = capturedEvents[0]?.aggregateID
          if (!source) return undefined
          if (capturedEvents.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: capturedEvents[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = capturedEvents[0]?.seq ?? 0
          for (const [index, event] of capturedEvents.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          if (capturedOptions.ownerRotation && capturedEvents.at(-1)?.id !== capturedOptions.ownerRotation.eventID) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: capturedEvents.at(-1)?.type ?? "unknown",
                message: "Replay owner rotation must target the final event",
              }),
            )
          }
          for (const event of capturedEvents) {
            yield* replayCapturedWithCapability(event, capturedOptions, capability, false)
          }
          return source
        })
      }

      function replayAll(events: SerializedEvent[], options?: ReplayOptions) {
        return replayAllWithCapability(events, options)
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({
            owner_id: ownerID,
            owner_generation: sql`${EventSequenceTable.owner_generation} + 1`,
          })
          .where(
            and(
              eq(EventSequenceTable.aggregate_id, aggregateID),
              or(isNull(EventSequenceTable.owner_id), ne(EventSequenceTable.owner_id, ownerID)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const decodeSerializedEvent = (event: SerializedEvent) => {
        const definition = Durable.get(event.type)
        if (!definition?.durable) {
          throw new InvalidDurableEventError({
            type: event.type,
            message: `Unknown durable event type ${event.type}`,
          })
        }
        return {
          id: event.id,
          type: definition.type,
          durable: {
            aggregateID: event.aggregateID,
            seq: event.seq,
            version: definition.durable.version,
          },
          data: Schema.decodeUnknownSync(definition.data)(event.data),
        }
      }

      const durablePageSize = 128
      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .limit(durablePageSize)
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              }),
            ),
          ),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, sequence)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  sequence = events.at(-1)?.durable?.seq ?? sequence
                }),
              ),
            )
            const catchUp = () =>
              Stream.paginate(undefined, () =>
                read.pipe(
                  Effect.map((events) => [
                    events,
                    events.length === durablePageSize ? Option.some(undefined) : Option.none(),
                  ] as const),
                ),
              )
            const live = Stream.fromSubscription(wakes).pipe(Stream.flatMap(() => catchUp()))
            return Stream.concat(catchUp(), live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const key = projectorKey(snapshotDefinition(definition))
          const list = projectors.get(key) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(key, list)
        })

      const implementation: InternalInterface = {
        publish,
        publishBatch,
        subscribe,
        all: streamAll,
        durable,
        sessionDeltas: deltas.stream,
        listen,
        project,
        replay,
        replayAll,
        remove,
        claim,
        [authorizedOperations]: {
          publish: (capability, definition, data, options) =>
            publishWithCapability(definition, data, options, capability),
          replay: (capability, event, options) => replayWithCapability(event, options, capability),
          replayAll: (capability, events, options) => replayAllWithCapability(events, options, capability),
        },
      }
      return Service.of(implementation)
    }),
  )

export const layer = layerWith()
export const node = ServiceGraph.node(layer, [Database.node])

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

const internalOperations = (events: Interface) => (events as InternalInterface)[authorizedOperations]

export const verificationSettlementPublisherLayer = Layer.effect(
  VerificationSettlementPublisherService,
  Effect.gen(function* () {
    const operations = internalOperations(yield* Service)
    return VerificationSettlementPublisherService.of({
      settle: (data, options) =>
        operations.publish(liveSettlementCapability, SessionEvent.VerificationSettled, data, options),
    })
  }),
)

export const verificationSettlementPublisherNode = ServiceGraph.node(verificationSettlementPublisherLayer, [node])

export const verificationSettlementPublisherDefaultLayer = verificationSettlementPublisherLayer.pipe(
  Layer.provide(defaultLayer),
)

export const protectedEventReplayLayer = Layer.effect(
  ProtectedEventReplayService,
  Effect.gen(function* () {
    const operations = internalOperations(yield* Service)
    return ProtectedEventReplayService.of({
      replay: (event, options) => operations.replay(protectedReplayCapability, event, options),
      replayAll: (events, options) => operations.replayAll(protectedReplayCapability, events, options),
    })
  }),
)

export const protectedEventReplayNode = ServiceGraph.node(protectedEventReplayLayer, [node])

export const protectedEventReplayDefaultLayer = protectedEventReplayLayer.pipe(Layer.provide(defaultLayer))
