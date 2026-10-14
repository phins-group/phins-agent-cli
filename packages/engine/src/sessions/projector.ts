export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { isDeepStrictEqual } from "node:util"
import { Database } from "../storage/database"
import { EventBus } from "../runtime/events/bus"
import { ServiceGraph } from "../runtime/effect/service-graph"
import { SessionEvent } from "../contracts/events/session"
import { SessionV1 } from "../contracts/session/compat"
import { WorkspaceTable } from "../storage/tables/workspaces"
import { SessionMessage } from "./messages/service"
import { SessionMessageUpdater } from "./messages/updater"
import { SessionInput } from "./input/inbox"
import { Workspace as WorkspaceIdentity } from "../contracts/workspace/workspace"
import { SessionContextEpoch } from "./context/epoch"
import { CompatibilityCheckpoint } from "./context/checkpoint"
import { SessionRunState } from "./run/state"
import { SessionUsageContribution } from "./usage/contribution"
import {
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  VerificationLocationStateTable,
  VerificationReceiptTable,
} from "../storage/tables/sessions"
import { SessionMessageID } from "../contracts/session/message-id"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}
export class SessionIdentityProjectionError extends Error {}

export interface ReadinessMarker {
  readonly ready: true
}

/** Available only after every session projector has been registered. */
export class Readiness extends Context.Service<Readiness, ReadinessMarker>()("@phins/SessionProjector/Readiness") {}

export class VerificationReceiptProjectionError extends Schema.TaggedErrorClass<VerificationReceiptProjectionError>()(
  "SessionProjector.VerificationReceiptProjectionError",
  {
    receiptID: VerificationReceipt.ID,
    reason: Schema.Literals([
      "not-requested",
      "already-settled",
      "verifier-not-requested",
      "verifier-mismatch",
      "verifier-not-allowed",
      "missing-with-requested-verifier",
      "invalid-time",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-requested":
        return `Verification receipt was not requested: ${this.receiptID}`
      case "already-settled":
        return `Verification receipt is already settled: ${this.receiptID}`
      case "verifier-not-requested":
        return `Verification receipt has no requested verifier: ${this.receiptID}`
      case "verifier-mismatch":
        return `Verification settlement changed the requested verifier: ${this.receiptID}`
      case "verifier-not-allowed":
        return `Verification settlement contains evidence for a non-evidence verdict: ${this.receiptID}`
      case "missing-with-requested-verifier":
        return `Verification receipt cannot be missing after a verifier was requested: ${this.receiptID}`
      case "invalid-time":
        return `Verification settlement has an invalid time range: ${this.receiptID}`
    }
  }
}

type VerificationLocationSubject = {
  readonly mutationEpoch: number
  readonly snapshot: string | null
}

/**
 * Canonical merge order for request projections from independent session
 * aggregates. The subject is the maximum by epoch, then known snapshot, then
 * lexicographic snapshot. The row keeps the minimum request time as created
 * and the maximum request time for the winning subject as updated.
 */
function compareVerificationLocationSubject(left: VerificationLocationSubject, right: VerificationLocationSubject) {
  if (left.mutationEpoch !== right.mutationEpoch) return left.mutationEpoch < right.mutationEpoch ? -1 : 1
  if (left.snapshot === right.snapshot) return 0
  if (left.snapshot === null) return -1
  if (right.snapshot === null) return 1
  return left.snapshot < right.snapshot ? -1 : 1
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessageID.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const data = event.data as typeof event.data & {
      readonly legacyProjection?: SessionEvent.LegacyProjection
    }
    if (data.legacyProjection) CompatibilityCheckpoint.validate(event, data.legacyProjection)
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

export const layer = Layer.effect(
  Readiness,
  Effect.gen(function* () {
    const events = yield* EventBus.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        if (event.data.info.id !== event.data.sessionID)
          return yield* Effect.die(
            new SessionIdentityProjectionError(
              `Created Session identity does not match aggregate ${event.data.sessionID}`,
            ),
          )
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      Effect.gen(function* () {
        const current = yield* db
          .select({
            id: SessionTable.id,
            projectID: SessionTable.project_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!current || event.data.info.id !== event.data.sessionID || event.data.info.projectID !== current.projectID)
          return yield* Effect.die(
            new SessionIdentityProjectionError(
              `Updated Session identity or project does not match aggregate ${event.data.sessionID}`,
            ),
          )
        const { id: _, project_id: __, ...mutable } = sessionRow(event.data.info)
        yield* db
          .update(SessionTable)
          .set(mutable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceIdentity.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        const current = yield* db
          .select({
            id: SessionTable.id,
            projectID: SessionTable.project_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!current || event.data.info.id !== event.data.sessionID || event.data.info.projectID !== current.projectID)
          return yield* Effect.die(
            new SessionIdentityProjectionError(
              `Deleted Session identity or project does not match aggregate ${event.data.sessionID}`,
            ),
          )
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      SessionUsageContribution.projectMessageRemoved(db, event),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      SessionUsageContribution.projectPartRemoved(db, event),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      SessionUsageContribution.projectPartUpdated(db, event),
    )
    yield* events.project(SessionEvent.Transcript.Reset, (event) => SessionUsageContribution.projectReset(db, event))
    yield* events.project(SessionEvent.Transcript.MessageRemoved, (event) =>
      SessionUsageContribution.projectMessageRemoved(db, event),
    )
    yield* events.project(SessionEvent.Transcript.PartRemoved, (event) =>
      SessionUsageContribution.projectPartRemoved(db, event),
    )
    yield* events.project(SessionEvent.Transcript.PartUpdated, (event) =>
      SessionUsageContribution.projectPartUpdated(db, event),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.OriginPrompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectOriginPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
          origin: event.data.origin,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.OriginPromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          origin: event.data.origin,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.MessageCopied, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.VerificationRequested, (event) =>
      Effect.gen(function* () {
        const requested = DateTime.toEpochMillis(event.data.timestamp)
        const request = event.data.request
        const incoming = {
          mutationEpoch: request.subject.mutationEpoch,
          snapshot: request.subject.snapshot ?? null,
        } satisfies VerificationLocationSubject
        const current = yield* db
          .select()
          .from(VerificationLocationStateTable)
          .where(eq(VerificationLocationStateTable.location_key, request.locationKey))
          .get()
          .pipe(Effect.orDie)
        if (!current) {
          yield* db
            .insert(VerificationLocationStateTable)
            .values({
              location_key: request.locationKey,
              mutation_epoch: incoming.mutationEpoch,
              snapshot: incoming.snapshot,
              time_created: requested,
              time_updated: requested,
            })
            .run()
            .pipe(Effect.orDie)
        } else {
          const existing = {
            mutationEpoch: current.mutation_epoch,
            snapshot: current.snapshot,
          } satisfies VerificationLocationSubject
          const subjectOrder = compareVerificationLocationSubject(incoming, existing)
          const winner = subjectOrder > 0 ? incoming : existing
          const timeCreated = Math.min(current.time_created, requested)
          const timeUpdated =
            subjectOrder > 0
              ? requested
              : subjectOrder === 0
                ? Math.max(current.time_updated, requested)
                : current.time_updated
          if (
            winner.mutationEpoch !== current.mutation_epoch ||
            winner.snapshot !== current.snapshot ||
            timeCreated !== current.time_created ||
            timeUpdated !== current.time_updated
          ) {
            yield* db
              .update(VerificationLocationStateTable)
              .set({
                mutation_epoch: winner.mutationEpoch,
                snapshot: winner.snapshot,
                time_created: timeCreated,
                time_updated: timeUpdated,
              })
              .where(eq(VerificationLocationStateTable.location_key, request.locationKey))
              .run()
              .pipe(Effect.orDie)
          }
        }
        yield* db
          .insert(VerificationReceiptTable)
          .values({
            id: request.id,
            session_id: event.data.sessionID,
            assistant_message_id: request.assistantMessageID,
            location_key: request.locationKey,
            mode: request.mode,
            mutation_epoch: request.subject.mutationEpoch,
            subject_snapshot: request.subject.snapshot,
            verifier: request.verifier,
            checks: [],
            time_requested: requested,
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.VerificationSettled, (event) =>
      Effect.gen(function* () {
        const settlement = event.data.settlement
        const current = yield* db
          .select({
            verdict: VerificationReceiptTable.verdict,
            verifier: VerificationReceiptTable.verifier,
            timeRequested: VerificationReceiptTable.time_requested,
          })
          .from(VerificationReceiptTable)
          .where(
            and(
              eq(VerificationReceiptTable.id, settlement.id),
              eq(VerificationReceiptTable.session_id, event.data.sessionID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!current)
          return yield* Effect.die(
            new VerificationReceiptProjectionError({
              receiptID: settlement.id,
              reason: "not-requested",
            }),
          )
        if (current.verdict)
          return yield* Effect.die(
            new VerificationReceiptProjectionError({
              receiptID: settlement.id,
              reason: "already-settled",
            }),
          )
        const evidenceVerdict =
          settlement.verdict === "passed" ||
          settlement.verdict === "failed" ||
          settlement.verdict === "error" ||
          settlement.verdict === "timeout"
        let verifier: VerificationReceipt.Verifier | null
        const completed = DateTime.toEpochMillis(event.data.timestamp)
        if (completed < current.timeRequested)
          return yield* Effect.die(
            new VerificationReceiptProjectionError({
              receiptID: settlement.id,
              reason: "invalid-time",
            }),
          )
        if (evidenceVerdict) {
          if (!current.verifier)
            return yield* Effect.die(
              new VerificationReceiptProjectionError({
                receiptID: settlement.id,
                reason: "verifier-not-requested",
              }),
            )
          if (!settlement.verifier || !isDeepStrictEqual(settlement.verifier, current.verifier))
            return yield* Effect.die(
              new VerificationReceiptProjectionError({
                receiptID: settlement.id,
                reason: "verifier-mismatch",
              }),
            )
          const started = settlement.startedAt ? DateTime.toEpochMillis(settlement.startedAt) : undefined
          if (started === undefined || started < current.timeRequested || started > completed)
            return yield* Effect.die(
              new VerificationReceiptProjectionError({
                receiptID: settlement.id,
                reason: "invalid-time",
              }),
            )
          verifier = current.verifier
        } else {
          if (settlement.verifier)
            return yield* Effect.die(
              new VerificationReceiptProjectionError({
                receiptID: settlement.id,
                reason: "verifier-not-allowed",
              }),
            )
          if (settlement.verdict === "missing" && current.verifier)
            return yield* Effect.die(
              new VerificationReceiptProjectionError({
                receiptID: settlement.id,
                reason: "missing-with-requested-verifier",
              }),
            )
          verifier = settlement.verdict === "stale" || settlement.verdict === "abandoned" ? current.verifier : null
        }
        yield* db
          .update(VerificationReceiptTable)
          .set({
            verifier,
            verdict: settlement.verdict,
            checks: [...settlement.checks],
            reason: settlement.reason,
            attestation: settlement.attestation,
            time_started: settlement.startedAt ? DateTime.toEpochMillis(settlement.startedAt) : undefined,
            time_completed: completed,
          })
          .where(
            and(
              eq(VerificationReceiptTable.id, settlement.id),
              eq(VerificationReceiptTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      run(db, event).pipe(Effect.andThen(SessionUsageContribution.projectStepEnded(db, event))),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Run.Started, (event) => SessionRunState.projectStarted(db, event))
    yield* events.project(SessionEvent.Run.Retried, (event) => SessionRunState.projectRetried(db, event))
    yield* events.project(SessionEvent.Run.Settled, (event) => SessionRunState.projectSettled(db, event))
    yield* events.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        yield* SessionUsageContribution.projectRevertCommitted(db, event)
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    return Readiness.of({ ready: true })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventBus.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = ServiceGraph.node(layer, [EventBus.node, Database.node])
