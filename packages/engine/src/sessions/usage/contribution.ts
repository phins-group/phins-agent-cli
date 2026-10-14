export * as SessionUsageContribution from "./contribution"
export {
  eventContributionKey,
  fromPart,
  partContributionKey,
  residualContributionKey,
  type Usage,
} from "./contribution-value"

import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { EventTable } from "../../storage/tables/events"
import { SessionV1 } from "../../contracts/session/compat"
import { SessionEvent } from "../../contracts/events/session"
import { SessionMessage } from "../messages/service"
import { Session as SessionSchema } from "../../contracts/session/info"
import {
  eventContributionKey,
  fromPart,
  partContributionKey,
  type Usage,
} from "./contribution-value"
import {
  SessionMessageTable,
  SessionTable,
  SessionUsageContributionTable,
} from "../../storage/tables/sessions"

type DatabaseService = Database.Interface["db"]
type ContributionRow = typeof SessionUsageContributionTable.$inferSelect

export class UsageContributionError extends Error {}

const zero: Usage = {
  cost: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

export function fromStepEnded(event: SessionEvent.Step.Ended): Usage {
  return {
    cost: event.data.cost,
    input: event.data.tokens.input,
    output: event.data.tokens.output,
    reasoning: event.data.tokens.reasoning,
    cacheRead: event.data.tokens.cache.read,
    cacheWrite: event.data.tokens.cache.write,
  }
}

export function rowUsage(row: ContributionRow): Usage {
  return {
    cost: row.cost,
    input: row.tokens_input,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    cacheRead: row.tokens_cache_read,
    cacheWrite: row.tokens_cache_write,
  }
}

function subtract(left: Usage, right: Usage): Usage {
  return {
    cost: left.cost - right.cost,
    input: left.input - right.input,
    output: left.output - right.output,
    reasoning: left.reasoning - right.reasoning,
    cacheRead: left.cacheRead - right.cacheRead,
    cacheWrite: left.cacheWrite - right.cacheWrite,
  }
}

function add(left: Usage, right: Usage): Usage {
  return {
    cost: left.cost + right.cost,
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

function same(left: Usage, right: Usage) {
  return (
    left.cost === right.cost &&
    left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  )
}

const applyDelta = Effect.fn("SessionUsageContribution.applyDelta")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delta: Usage,
) {
  if (same(delta, zero)) return
  const updated = yield* db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${delta.cost}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${delta.input}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${delta.output}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${delta.reasoning}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${delta.cacheRead}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${delta.cacheWrite}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .returning({ sessionID: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) {
    return yield* Effect.die(new UsageContributionError(`Usage contribution has missing session ${sessionID}`))
  }
})

interface ContributionInput {
  readonly key: string
  readonly sessionID: SessionSchema.ID
  readonly compatibilityMessageID?: SessionV1.MessageID
  readonly compatibilityMessageTimeCreated?: number
  readonly canonicalMessageID?: SessionMessage.ID
  readonly partID?: SessionV1.PartID
  readonly eventSeq: number
  readonly usage: Usage
}

const upsert = Effect.fn("SessionUsageContribution.upsert")(function* (
  db: DatabaseService,
  input: ContributionInput,
) {
  const existing = yield* db
    .select()
    .from(SessionUsageContributionTable)
    .where(eq(SessionUsageContributionTable.contribution_key, input.key))
    .get()
    .pipe(Effect.orDie)
  if (
    existing &&
    (existing.session_id !== input.sessionID ||
      existing.part_id !== (input.partID ?? null) ||
      (existing.compatibility_message_id !== null &&
        input.compatibilityMessageID !== undefined &&
        existing.compatibility_message_id !== input.compatibilityMessageID) ||
      (existing.canonical_message_id !== null &&
        input.canonicalMessageID !== undefined &&
        existing.canonical_message_id !== input.canonicalMessageID) ||
      (existing.compatibility_message_time_created !== null &&
        input.compatibilityMessageTimeCreated !== undefined &&
        existing.compatibility_message_time_created !== input.compatibilityMessageTimeCreated))
  ) {
    return yield* Effect.die(
      new UsageContributionError(`Usage contribution ${input.key} attempted to change immutable identity`),
    )
  }

  const previous = existing ? rowUsage(existing) : zero
  const delta = subtract(input.usage, previous)
  yield* applyDelta(db, input.sessionID, delta)

  if (!existing) {
    yield* db
      .insert(SessionUsageContributionTable)
      .values({
        contribution_key: input.key,
        session_id: input.sessionID,
        compatibility_message_id: input.compatibilityMessageID,
        compatibility_message_time_created: input.compatibilityMessageTimeCreated,
        canonical_message_id: input.canonicalMessageID,
        part_id: input.partID,
        event_seq: input.eventSeq,
        cost: input.usage.cost,
        tokens_input: input.usage.input,
        tokens_output: input.usage.output,
        tokens_reasoning: input.usage.reasoning,
        tokens_cache_read: input.usage.cacheRead,
        tokens_cache_write: input.usage.cacheWrite,
      })
      .run()
      .pipe(Effect.orDie)
    return
  }

  const gainedCanonical = existing.canonical_message_id === null && input.canonicalMessageID !== undefined
  const eventSeq = same(previous, input.usage) && !gainedCanonical ? existing.event_seq : input.eventSeq
  yield* db
    .update(SessionUsageContributionTable)
    .set({
      compatibility_message_id:
        existing.compatibility_message_id ?? input.compatibilityMessageID,
      compatibility_message_time_created:
        existing.compatibility_message_time_created ?? input.compatibilityMessageTimeCreated,
      canonical_message_id: existing.canonical_message_id ?? input.canonicalMessageID,
      event_seq: eventSeq,
      cost: input.usage.cost,
      tokens_input: input.usage.input,
      tokens_output: input.usage.output,
      tokens_reasoning: input.usage.reasoning,
      tokens_cache_read: input.usage.cacheRead,
      tokens_cache_write: input.usage.cacheWrite,
    })
    .where(eq(SessionUsageContributionTable.contribution_key, input.key))
    .run()
    .pipe(Effect.orDie)
})

const removeRows = Effect.fn("SessionUsageContribution.removeRows")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<ContributionRow>,
) {
  if (rows.length === 0) return
  const total = rows.reduce((result, row) => add(result, rowUsage(row)), zero)
  yield* applyDelta(db, sessionID, subtract(zero, total))
  yield* db
    .delete(SessionUsageContributionTable)
    .where(
      inArray(
        SessionUsageContributionTable.contribution_key,
        rows.map((row) => row.contribution_key),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

function requireSequence(event: { readonly durable?: { readonly seq: number } }) {
  if (event.durable === undefined) throw new Error("Durable Session event is missing aggregate sequence")
  return event.durable.seq
}

const messageUpdatedTypes = [
  EventBus.versionedType(
    SessionV1.Event.MessageUpdated.type,
    SessionV1.Event.MessageUpdated.durable!.version,
  ),
  EventBus.versionedType(
    SessionEvent.Transcript.MessageUpdated.type,
    SessionEvent.Transcript.MessageUpdated.durable!.version,
  ),
]
const decodeMessageUpdated = Schema.decodeUnknownSync(SessionV1.Event.MessageUpdated.data)

const compatibilityMessageTime = Effect.fn("SessionUsageContribution.compatibilityMessageTime")(
  function* (
    db: DatabaseService,
    sessionID: SessionSchema.ID,
    messageID: SessionV1.MessageID,
  ) {
    const rows = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          inArray(EventTable.type, messageUpdatedTypes),
        ),
      )
      .orderBy(desc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      const data = decodeMessageUpdated(row.data)
      if (data.info.id === messageID) return data.info.time.created
    }
    return undefined
  },
)

export const projectStepEnded = Effect.fn("SessionUsageContribution.projectStepEnded")(
  function* (db: DatabaseService, event: SessionEvent.Step.Ended) {
    const seq = requireSequence(event)
    const projection = event.data.legacyProjection
    const stepFinish = projection?.parts.find(({ part }) => part.type === "step-finish")
    if (stepFinish?.part.type === "step-finish" && projection) {
      yield* upsert(db, {
        key: partContributionKey(event.data.sessionID, stepFinish.part.id),
        sessionID: event.data.sessionID,
        compatibilityMessageID: stepFinish.part.messageID,
        compatibilityMessageTimeCreated: projection.message.time.created,
        canonicalMessageID: event.data.assistantMessageID,
        partID: stepFinish.part.id,
        eventSeq: seq,
        usage: fromStepEnded(event),
      })
      return
    }
    yield* upsert(db, {
      key: eventContributionKey(event.id),
      sessionID: event.data.sessionID,
      canonicalMessageID: event.data.assistantMessageID,
      eventSeq: seq,
      usage: fromStepEnded(event),
    })
  },
)

type PartUpdatedEvent =
  | typeof SessionV1.Event.PartUpdated.Type
  | typeof SessionEvent.Transcript.PartUpdated.Type

export const projectPartUpdated = Effect.fn("SessionUsageContribution.projectPartUpdated")(
  function* (db: DatabaseService, event: PartUpdatedEvent) {
    const seq = requireSequence(event)
    const part = event.data.part
    if (part.sessionID !== event.data.sessionID) {
      return yield* Effect.die(
        new UsageContributionError(
          `Usage part ${part.id} belongs to ${part.sessionID}, expected ${event.data.sessionID}`,
        ),
      )
    }
    const key = partContributionKey(event.data.sessionID, part.id)
    const existing = yield* db
      .select()
      .from(SessionUsageContributionTable)
      .where(eq(SessionUsageContributionTable.contribution_key, key))
      .get()
      .pipe(Effect.orDie)
    const usage = fromPart(part)
    if (!usage) {
      if (existing) {
        if (existing.compatibility_message_id !== part.messageID) {
          return yield* Effect.die(
            new UsageContributionError(`Usage part ${part.id} attempted to change its parent message`),
          )
        }
        yield* removeRows(db, event.data.sessionID, [existing])
      }
      return
    }
    const timeCreated =
      existing?.compatibility_message_time_created ??
      (yield* compatibilityMessageTime(db, event.data.sessionID, part.messageID))
    if (timeCreated === undefined) {
      return yield* Effect.die(
        new UsageContributionError(`Usage part ${part.id} has missing compatibility message ${part.messageID}`),
      )
    }
    yield* upsert(db, {
      key,
      sessionID: event.data.sessionID,
      compatibilityMessageID: part.messageID,
      compatibilityMessageTimeCreated: timeCreated,
      partID: part.id,
      eventSeq: seq,
      usage,
    })
  },
)

type PartRemovedEvent =
  | typeof SessionV1.Event.PartRemoved.Type
  | typeof SessionEvent.Transcript.PartRemoved.Type

export const projectPartRemoved = Effect.fn("SessionUsageContribution.projectPartRemoved")(
  function* (db: DatabaseService, event: PartRemovedEvent) {
    const row = yield* db
      .select()
      .from(SessionUsageContributionTable)
      .where(
        eq(
          SessionUsageContributionTable.contribution_key,
          partContributionKey(event.data.sessionID, event.data.partID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return
    if (row.compatibility_message_id !== event.data.messageID) {
      return yield* Effect.die(
        new UsageContributionError(`Usage part ${event.data.partID} does not belong to ${event.data.messageID}`),
      )
    }
    yield* removeRows(db, event.data.sessionID, [row])
  },
)

type MessageRemovedEvent =
  | typeof SessionV1.Event.MessageRemoved.Type
  | typeof SessionEvent.Transcript.MessageRemoved.Type

export const projectMessageRemoved = Effect.fn("SessionUsageContribution.projectMessageRemoved")(
  function* (db: DatabaseService, event: MessageRemovedEvent) {
    const rows = yield* db
      .select()
      .from(SessionUsageContributionTable)
      .where(
        and(
          eq(SessionUsageContributionTable.session_id, event.data.sessionID),
          or(
            eq(SessionUsageContributionTable.compatibility_message_id, event.data.messageID),
            eq(
              SessionUsageContributionTable.canonical_message_id,
              SessionMessage.ID.make(event.data.messageID),
            ),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    yield* removeRows(db, event.data.sessionID, rows)
  },
)

export const projectReset = Effect.fn("SessionUsageContribution.projectReset")(function* (
  db: DatabaseService,
  event: SessionEvent.Transcript.Reset,
) {
  const rows = yield* db
    .select()
    .from(SessionUsageContributionTable)
    .where(eq(SessionUsageContributionTable.session_id, event.data.sessionID))
    .all()
    .pipe(Effect.orDie)
  yield* removeRows(db, event.data.sessionID, rows)
  // Reset is an exact replacement boundary. This also clears any untracked
  // aggregate imported immediately before the replacement starts.
  yield* db
    .update(SessionTable)
    .set({
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, event.data.sessionID))
    .run()
    .pipe(Effect.orDie)
})

export const projectRevertCommitted = Effect.fn(
  "SessionUsageContribution.projectRevertCommitted",
)(function* (
  db: DatabaseService,
  event: typeof SessionEvent.RevertEvent.Committed.Type,
) {
  const boundary = yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      timeCreated: SessionMessageTable.time_created,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.sessionID),
        eq(SessionMessageTable.id, event.data.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary) {
    return yield* Effect.die(
      new UsageContributionError(`Revert boundary message not found: ${event.data.messageID}`),
    )
  }
  const [contributions, messages] = yield* Effect.all([
    db
      .select()
      .from(SessionUsageContributionTable)
      .where(eq(SessionUsageContributionTable.session_id, event.data.sessionID))
      .all()
      .pipe(Effect.orDie),
    db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, event.data.sessionID))
      .all()
      .pipe(Effect.orDie),
  ])
  const canonicalSequences = new Map(messages.map((message) => [message.id, message.seq] as const))
  const removed = contributions.filter((row) => {
    if (
      row.canonical_message_id === null &&
      row.compatibility_message_id === null &&
      row.part_id === null
    ) {
      // A migration residual is an unattributed pre-cutover baseline. There is
      // no sound basis for assigning it after a later canonical boundary.
      return false
    }
    if (row.canonical_message_id !== null) {
      if (String(row.canonical_message_id) === String(boundary.id)) return false
      const messageSeq = canonicalSequences.get(row.canonical_message_id)
      return messageSeq === undefined ? row.event_seq > boundary.seq : messageSeq > boundary.seq
    }
    if (String(row.compatibility_message_id) === String(boundary.id)) return false
    if (row.compatibility_message_time_created !== null) {
      return (
        row.compatibility_message_time_created > boundary.timeCreated ||
        (row.compatibility_message_time_created === boundary.timeCreated &&
          String(row.compatibility_message_id) > String(boundary.id))
      )
    }
    return row.event_seq > boundary.seq
  })
  yield* removeRows(db, event.data.sessionID, removed)
})
