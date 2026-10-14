import { asc, eq, max } from "drizzle-orm"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import { Event } from "../../contracts/events/event"
import type { DatabaseMigration } from "../migration"
import { EventSequenceTable, EventTable } from "../tables/events"
import { SessionEvent } from "../../contracts/events/session"
import {
  fromPart,
  partContributionKey,
  residualContributionKey,
  type Usage,
} from "../../sessions/usage/contribution-value"
import type { Session as SessionSchema } from "../../contracts/session/info"
import { SessionMessageTable, SessionTable } from "../tables/sessions"
import type { MessageID, PartID, SessionV1 } from "../../contracts/session/compat"

type LegacyMessageData = Omit<SessionV1.Info, "id" | "sessionID">
type LegacyPartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

// These descriptors intentionally live in the upgrade migration. The current
// schema no longer owns the legacy tables, but an existing database still has
// them when this migration runs.
const LegacyMessageTable = sqliteTable("message", {
  id: text().$type<MessageID>().primaryKey(),
  session_id: text().$type<SessionSchema.ID>().notNull(),
  time_created: integer().notNull(),
  data: text({ mode: "json" }).$type<LegacyMessageData>().notNull(),
})

const LegacyPartTable = sqliteTable("part", {
  id: text().$type<PartID>().primaryKey(),
  message_id: text().$type<MessageID>().notNull(),
  session_id: text().$type<SessionSchema.ID>().notNull(),
  time_created: integer().notNull(),
  data: text({ mode: "json" }).$type<LegacyPartData>().notNull(),
})

// Kept migration-local so future ledger evolution cannot change the upgrade
// contract that consumes the legacy tables below.
const UsageContributionTable = sqliteTable("session_usage_contribution", {
  contribution_key: text().primaryKey(),
  session_id: text().$type<SessionSchema.ID>().notNull(),
  compatibility_message_id: text().$type<MessageID>(),
  compatibility_message_time_created: integer(),
  canonical_message_id: text(),
  part_id: text().$type<PartID>(),
  event_seq: integer().notNull(),
  cost: real().notNull(),
  tokens_input: integer().notNull(),
  tokens_output: integer().notNull(),
  tokens_reasoning: integer().notNull(),
  tokens_cache_read: integer().notNull(),
  tokens_cache_write: integer().notNull(),
})

type UsageSeed = {
  readonly partID: PartID
  readonly compatibilityMessageID: MessageID
  readonly compatibilityMessageTimeCreated: number
  readonly canonicalMessageID?: string
  readonly sourceEventSeq?: number
  readonly usage: Usage
}

type Correlation = {
  readonly canonicalMessageID: string
  readonly compatibilityMessageID: MessageID
  readonly compatibilityMessageTimeCreated: number
  readonly sourceEventSeq: number
}

type Snapshot = {
  readonly time: number
  readonly rank: 0 | 1
  readonly id: string
  readonly event: typeof EventTable.$inferInsert
}

export class TranscriptBackfillInvariantError extends Error {}

/** Length framing makes the deterministic IDs injective for every source key. */
export function transcriptBackfillEventID(
  kind: "reset" | "message" | "part",
  sessionID: string,
  entityID = "",
) {
  return Event.ID.make(
    `evt_transcript_v2_${kind}_${sessionID.length}_${sessionID}_${entityID.length}_${entityID}`,
  )
}

const resetType = Event.versionedType(
  SessionEvent.Transcript.Reset.type,
  SessionEvent.Transcript.Reset.durable!.version,
)
const messageUpdatedType = Event.versionedType(
  SessionEvent.Transcript.MessageUpdated.type,
  SessionEvent.Transcript.MessageUpdated.durable!.version,
)
const partUpdatedType = Event.versionedType(
  SessionEvent.Transcript.PartUpdated.type,
  SessionEvent.Transcript.PartUpdated.durable!.version,
)
const decodeReset = Schema.decodeUnknownSync(SessionEvent.Transcript.Reset.data)
const encodeReset = Schema.encodeSync(SessionEvent.Transcript.Reset.data)
const decodeMessageUpdated = Schema.decodeUnknownSync(SessionEvent.Transcript.MessageUpdated.data)
const encodeMessageUpdated = Schema.encodeSync(SessionEvent.Transcript.MessageUpdated.data)
const decodePartUpdated = Schema.decodeUnknownSync(SessionEvent.Transcript.PartUpdated.data)
const encodePartUpdated = Schema.encodeSync(SessionEvent.Transcript.PartUpdated.data)
const decodeLegacyProjection = Schema.decodeUnknownSync(SessionEvent.LegacyProjection)

const zeroUsage = (): Usage => ({
  cost: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

const addUsage = (left: Usage, right: Usage): Usage => ({
  cost: left.cost + right.cost,
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
})

const subtractUsage = (left: Usage, right: Usage): Usage => ({
  cost: left.cost - right.cost,
  input: left.input - right.input,
  output: left.output - right.output,
  reasoning: left.reasoning - right.reasoning,
  cacheRead: left.cacheRead - right.cacheRead,
  cacheWrite: left.cacheWrite - right.cacheWrite,
})

const nonZeroUsage = (usage: Usage) =>
  usage.cost !== 0 ||
  usage.input !== 0 ||
  usage.output !== 0 ||
  usage.reasoning !== 0 ||
  usage.cacheRead !== 0 ||
  usage.cacheWrite !== 0

const finiteUsage = (usage: Usage) => Object.values(usage).every(Number.isFinite)

const costClose = (left: number, right: number) =>
  Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))

const compare = (left: Snapshot, right: Snapshot) => {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1
  if (left.rank !== right.rank) return left.rank - right.rank
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export default {
  id: "20260801163000_backfill_session_transcript",
  up(tx) {
    return Effect.gen(function* () {
      const sessions = yield* tx
        .select({
          id: SessionTable.id,
          timeCreated: SessionTable.time_created,
          cost: SessionTable.cost,
          input: SessionTable.tokens_input,
          output: SessionTable.tokens_output,
          reasoning: SessionTable.tokens_reasoning,
          cacheRead: SessionTable.tokens_cache_read,
          cacheWrite: SessionTable.tokens_cache_write,
        })
        .from(SessionTable)
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all()
      const sessionIDs = new Set(sessions.map((session) => session.id))
      const messageRows = yield* tx
        .select({ id: LegacyMessageTable.id, sessionID: LegacyMessageTable.session_id })
        .from(LegacyMessageTable)
        .all()
      const messageOwners = new Map(
        messageRows.map((message) => [message.id, message.sessionID] as const),
      )
      for (const message of messageRows) {
        if (!sessionIDs.has(message.sessionID)) {
          throw new TranscriptBackfillInvariantError(
            `Message ${message.id} has missing session ${message.sessionID}`,
          )
        }
      }
      const partOwners = yield* tx
        .select({
          id: LegacyPartTable.id,
          sessionID: LegacyPartTable.session_id,
          messageID: LegacyPartTable.message_id,
        })
        .from(LegacyPartTable)
        .all()
      for (const part of partOwners) {
        if (!sessionIDs.has(part.sessionID) || messageOwners.get(part.messageID) !== part.sessionID) {
          throw new TranscriptBackfillInvariantError(
            `Part ${part.id} has missing or cross-session parent ${part.messageID}`,
          )
        }
      }

      for (const session of sessions) {
        const sequence = yield* tx
          .select({
            seq: EventSequenceTable.seq,
            ownerID: EventSequenceTable.owner_id,
            ownerGeneration: EventSequenceTable.owner_generation,
          })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
        const latest = yield* tx
          .select({ seq: max(EventTable.seq) })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .get()
        const storedLatest = latest?.seq ?? -1
        const sequencedLatest = sequence?.seq ?? -1
        if (sequencedLatest < -1 || storedLatest !== sequencedLatest) {
          throw new TranscriptBackfillInvariantError(
            `Event sequence mismatch for ${session.id}: sequence=${sequencedLatest}, event=${storedLatest}`,
          )
        }

        const correlations = new Map<string, Correlation>()
        const existingEvents = yield* tx
          .select({ seq: EventTable.seq, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .orderBy(asc(EventTable.seq))
          .all()
        for (const row of existingEvents) {
          const raw = row.data as { readonly legacyProjection?: unknown }
          if (raw.legacyProjection === undefined) continue
          let projection: SessionEvent.LegacyProjection
          try {
            projection = decodeLegacyProjection(raw.legacyProjection)
          } catch {
            throw new TranscriptBackfillInvariantError(
              `Event ${session.id}/${row.seq} has an invalid legacy projection`,
            )
          }
          if (projection.message.sessionID !== session.id) {
            throw new TranscriptBackfillInvariantError(
              `Event ${session.id}/${row.seq} projects message ${projection.message.id} for another session`,
            )
          }
          for (const item of projection.parts) {
            if (
              item.part.sessionID !== session.id ||
              item.part.messageID !== projection.message.id
            ) {
              throw new TranscriptBackfillInvariantError(
                `Event ${session.id}/${row.seq} projects part ${item.part.id} with invalid ownership`,
              )
            }
            if (item.part.type !== "step-finish") continue
            const existing = correlations.get(item.part.id)
            if (
              existing &&
              (existing.canonicalMessageID !== projection.canonicalMessageID ||
                existing.compatibilityMessageID !== projection.message.id ||
                existing.compatibilityMessageTimeCreated !== projection.message.time.created)
            ) {
              throw new TranscriptBackfillInvariantError(
                `Step-finish part ${item.part.id} changed its event correlation`,
              )
            }
            correlations.set(item.part.id, {
              canonicalMessageID: projection.canonicalMessageID,
              compatibilityMessageID: projection.message.id,
              compatibilityMessageTimeCreated: projection.message.time.created,
              sourceEventSeq: row.seq,
            })
          }
        }

        const canonicalMessages = yield* tx
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, session.id))
          .all()
        const canonicalIDs = new Set(canonicalMessages.map((message) => String(message.id)))

        const messages = yield* tx
          .select()
          .from(LegacyMessageTable)
          .where(eq(LegacyMessageTable.session_id, session.id))
          .orderBy(asc(LegacyMessageTable.time_created), asc(LegacyMessageTable.id))
          .all()
        const messageTimes = new Map<string, number>()
        const snapshots = new Array<Snapshot>()
        const usageSeeds = new Array<UsageSeed>()
        for (const message of messages) {
          const data = encodeMessageUpdated(
            decodeMessageUpdated({
              sessionID: session.id,
              info: {
                ...message.data,
                id: message.id,
                sessionID: message.session_id,
              },
            }),
          )
          if (data.info.time.created !== message.time_created) {
            throw new TranscriptBackfillInvariantError(
              `Message ${message.id} creation time does not match its legacy row`,
            )
          }
          messageTimes.set(message.id, message.time_created)
          snapshots.push({
            time: message.time_created,
            rank: 0,
            id: message.id,
            event: {
              id: transcriptBackfillEventID("message", session.id, message.id),
              aggregate_id: session.id,
              seq: -1,
              type: messageUpdatedType,
              data,
            },
          })
        }

        const parts = yield* tx
          .select()
          .from(LegacyPartTable)
          .where(eq(LegacyPartTable.session_id, session.id))
          .orderBy(asc(LegacyPartTable.time_created), asc(LegacyPartTable.id))
          .all()
        for (const part of parts) {
          const parentTime = messageTimes.get(part.message_id)
          if (parentTime === undefined) {
            throw new TranscriptBackfillInvariantError(
              `Part ${part.id} has missing or cross-session parent ${part.message_id}`,
            )
          }
          if (part.time_created < parentTime) {
            throw new TranscriptBackfillInvariantError(
              `Part ${part.id} predates parent ${part.message_id}`,
            )
          }
          const data = encodePartUpdated(
            decodePartUpdated({
              sessionID: session.id,
              part: {
                ...part.data,
                id: part.id,
                sessionID: part.session_id,
                messageID: part.message_id,
              },
              time: part.time_created,
            }),
          )
          snapshots.push({
            time: part.time_created,
            rank: 1,
            id: part.id,
            event: {
              id: transcriptBackfillEventID("part", session.id, part.id),
              aggregate_id: session.id,
              seq: -1,
              type: partUpdatedType,
              data,
            },
          })
          if (data.part.type === "step-finish") {
            const usage = fromPart(data.part)
            if (!usage || !finiteUsage(usage)) {
              throw new TranscriptBackfillInvariantError(
                `Step-finish part ${part.id} contains invalid usage`,
              )
            }
            const correlation = correlations.get(part.id)
            if (
              correlation &&
              (correlation.compatibilityMessageID !== part.message_id ||
                correlation.compatibilityMessageTimeCreated !== parentTime)
            ) {
              throw new TranscriptBackfillInvariantError(
                `Step-finish part ${part.id} does not match its event correlation`,
              )
            }
            usageSeeds.push({
              partID: part.id,
              compatibilityMessageID: part.message_id,
              compatibilityMessageTimeCreated: parentTime,
              canonicalMessageID:
                correlation?.canonicalMessageID ??
                (canonicalIDs.has(String(part.message_id)) ? String(part.message_id) : undefined),
              sourceEventSeq: correlation?.sourceEventSeq,
              usage,
            })
          }
        }
        snapshots.sort(compare)

        const reset = encodeReset(decodeReset({ sessionID: session.id, timestamp: session.timeCreated }))
        const events = [
          {
            id: transcriptBackfillEventID("reset", session.id),
            aggregate_id: session.id,
            seq: -1,
            type: resetType,
            data: reset,
          } satisfies typeof EventTable.$inferInsert,
          ...snapshots.map((snapshot) => snapshot.event),
        ]
        const finalSequence = sequencedLatest + events.length
        if (sequence) {
          yield* tx
            .update(EventSequenceTable)
            .set({ seq: finalSequence })
            .where(eq(EventSequenceTable.aggregate_id, session.id))
            .run()
        } else {
          yield* tx
            .insert(EventSequenceTable)
            .values({
              aggregate_id: session.id,
              seq: finalSequence,
              owner_id: null,
              owner_generation: 0,
            })
            .run()
        }
        for (const [index, event] of events.entries()) {
          yield* tx
            .insert(EventTable)
            .values({ ...event, seq: sequencedLatest + index + 1 })
            .run()
        }

        const eventSequences = new Map(
          events.map((event, index) => [event.id, sequencedLatest + index + 1] as const),
        )
        let accounted = zeroUsage()
        for (const seed of usageSeeds) {
          const eventSeq =
            seed.sourceEventSeq ??
            eventSequences.get(transcriptBackfillEventID("part", session.id, seed.partID))
          if (eventSeq === undefined) {
            throw new TranscriptBackfillInvariantError(
              `Step-finish part ${seed.partID} has no durable source sequence`,
            )
          }
          yield* tx
            .insert(UsageContributionTable)
            .values({
              contribution_key: partContributionKey(session.id, seed.partID),
              session_id: session.id,
              compatibility_message_id: seed.compatibilityMessageID,
              compatibility_message_time_created:
                seed.compatibilityMessageTimeCreated,
              canonical_message_id: seed.canonicalMessageID,
              part_id: seed.partID,
              event_seq: eventSeq,
              cost: seed.usage.cost,
              tokens_input: seed.usage.input,
              tokens_output: seed.usage.output,
              tokens_reasoning: seed.usage.reasoning,
              tokens_cache_read: seed.usage.cacheRead,
              tokens_cache_write: seed.usage.cacheWrite,
            })
            .run()
          accounted = addUsage(accounted, seed.usage)
        }

        const aggregate = {
          cost: session.cost,
          input: session.input,
          output: session.output,
          reasoning: session.reasoning,
          cacheRead: session.cacheRead,
          cacheWrite: session.cacheWrite,
        } satisfies Usage
        if (!finiteUsage(aggregate)) {
          throw new TranscriptBackfillInvariantError(
            `Session ${session.id} contains non-finite aggregate usage`,
          )
        }
        const residual = subtractUsage(aggregate, accounted)
        if (nonZeroUsage(residual)) {
          // Historical versions could aggregate assistant totals before every
          // step-finish part was durably attributable. Keep that exact,
          // pre-cutover balance as an identity-free seq=-1 contribution; it is
          // retained by reverts and retired by an explicit transcript reset.
          yield* tx
            .insert(UsageContributionTable)
            .values({
              contribution_key: residualContributionKey(session.id),
              session_id: session.id,
              event_seq: -1,
              cost: residual.cost,
              tokens_input: residual.input,
              tokens_output: residual.output,
              tokens_reasoning: residual.reasoning,
              tokens_cache_read: residual.cacheRead,
              tokens_cache_write: residual.cacheWrite,
            })
            .run()
          accounted = addUsage(accounted, residual)
        }
        if (
          !costClose(accounted.cost, aggregate.cost) ||
          accounted.input !== aggregate.input ||
          accounted.output !== aggregate.output ||
          accounted.reasoning !== aggregate.reasoning ||
          accounted.cacheRead !== aggregate.cacheRead ||
          accounted.cacheWrite !== aggregate.cacheWrite
        ) {
          throw new TranscriptBackfillInvariantError(
            `Session ${session.id} usage ledger does not reconcile with its aggregate`,
          )
        }

        // Explicitly retain ownership state; the update above must remain a
        // sequence-only append even if this migration is refactored later.
        if (sequence) {
          const retained = yield* tx
            .select({
              ownerID: EventSequenceTable.owner_id,
              ownerGeneration: EventSequenceTable.owner_generation,
            })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, session.id))
            .get()
          if (
            retained?.ownerID !== sequence.ownerID ||
            retained?.ownerGeneration !== sequence.ownerGeneration
          ) {
            throw new TranscriptBackfillInvariantError(`Event ownership changed for ${session.id}`)
          }
        }
      }

      // The reset + exact snapshots now own compatibility reads. Retire the
      // source tables only after every aggregate has been validated and
      // appended; DatabaseMigration.applyOnly wraps this whole effect in one
      // transaction, so any failure restores both tables and all source rows.
      yield* tx.run(`DROP TABLE \`part\`;`)
      yield* tx.run(`DROP TABLE \`message\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
