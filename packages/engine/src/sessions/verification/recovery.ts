export * as SessionVerificationRecovery from "./recovery"

import { VerificationReceipt } from "../../contracts/execution/verification-receipt"
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Cause, Clock, DateTime, Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { EventSequenceTable, EventTable } from "../../storage/tables/events"
import type { Snapshot } from "../../workspace/repository/snapshot"
import { VerifierRegistry } from "../../verification/registry"
import { VerifierSettlementAdmission } from "../../verification/settlement-admission"
import { VerificationSettlementPublisher } from "../../runtime/events/verification-publisher"
import { SessionEvent } from "../../contracts/events/session"
import type { SessionMessage } from "../messages/service"
import type { Session as SessionSchema } from "../../contracts/session/info"
import {
  SessionTable,
  VerificationLocationStateTable,
  VerificationReceiptTable,
  VerificationRequestOutboxTable,
} from "../../storage/tables/sessions"

type DatabaseService = Database.Interface["db"]

export const RECOVERY_MIN_AGE_MS = VerifierRegistry.MAX_TIMEOUT_MS + 60_000
export const RECOVERY_BATCH_SIZE = 256
export const ATTEMPT_LEASE_GRACE_MS = 60_000
export const ATTEMPT_LEASE_MAX_MS = VerifierRegistry.MAX_TIMEOUT_MS + ATTEMPT_LEASE_GRACE_MS

export type AttemptClaim = {
  readonly receiptID: VerificationReceipt.ID
  readonly sessionID: SessionSchema.ID
  /** Exact aggregate owner observed when this attempt was admitted. */
  readonly ownerID: string | undefined
  /** Monotonic fence for owner identity, including A -> B -> A handoffs. */
  readonly ownerGeneration: number
  /** Exact verifier-plan timeout pinned by the initial request claim. */
  readonly timeoutMs: number
  readonly token: string
  readonly claimedAtMs: number
  readonly expiresAtMs: number
}

export type AttemptLease = AttemptClaim & {
  readonly generation: number
}

export type PrepareAttemptClaimInput = {
  readonly receiptID: VerificationReceipt.ID
  readonly sessionID: SessionSchema.ID
  readonly timeoutMs: number
}

export type ClaimAttemptInput = PrepareAttemptClaimInput

export class AttemptFenceError extends Error {
  override readonly name = "SessionVerificationRecovery.AttemptFenceError"
}

export type PrepareInput = {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly locationKey: VerificationReceipt.LocationKey
  readonly snapshot: Snapshot.ID
  readonly verifier?: VerificationReceipt.Verifier
}

export type PreparedRequest = {
  readonly id: VerificationReceipt.ID
  readonly eventID: EventBus.ID
  readonly requestedAt: DateTime.Utc
  readonly mutationEpoch: number
  readonly request: VerificationReceipt.Request
}

export type PublishPreparedRequestOptions = {
  readonly recovery?: RecoveryAuthority
  /** Initial selected-verifier lease, committed atomically with its request. */
  readonly attempt?: AttemptClaim
}

export type RecoveryAuthority = {
  /** Exact aggregate owner observed by candidate discovery. */
  readonly ownerID: string | undefined
  /** Exact monotonic owner fence observed with ownerID. */
  readonly ownerGeneration: number
}

export type RecoveryInput = RecoveryAuthority & {
  readonly sessionID: SessionSchema.ID
  readonly nowMs?: number
  readonly minAgeMs?: number
  readonly limit?: number
}

export type RecoveryResult = {
  readonly authorized: boolean
  readonly requestIntentsScanned: number
  readonly requestsRecovered: number
  readonly receiptsScanned: number
  readonly receiptsSettled: number
  readonly alreadyTerminal: number
  readonly failures: number
}

export const attemptLeaseDurationMs = (timeoutMs: number) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VerifierRegistry.MAX_TIMEOUT_MS)
    throw new AttemptFenceError(
      `Verifier attempt timeout must be an integer between 1 and ${VerifierRegistry.MAX_TIMEOUT_MS} milliseconds`,
    )
  return Math.min(ATTEMPT_LEASE_MAX_MS, timeoutMs + ATTEMPT_LEASE_GRACE_MS)
}

const attemptOwner = Effect.fn("SessionVerificationRecovery.attemptOwner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({
      ownerID: EventSequenceTable.owner_id,
      ownerGeneration: EventSequenceTable.owner_generation,
    })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const ownerGeneration = row?.ownerGeneration ?? 0
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0)
    return yield* Effect.die(
      new AttemptFenceError("Session owner generation is invalid"),
    )
  return {
    exists: row !== undefined,
    ownerID: row?.ownerID ?? undefined,
    ownerGeneration,
  }
})

const assertAttemptOwner = Effect.fn("SessionVerificationRecovery.assertAttemptOwner")(function* (
  db: DatabaseService,
  lease: Pick<
    AttemptClaim,
    "sessionID" | "ownerID" | "ownerGeneration"
  >,
  options?: { readonly allowMissingLocal?: boolean },
) {
  const current = yield* attemptOwner(db, lease.sessionID)
  if (
    current.ownerID !== lease.ownerID ||
    current.ownerGeneration !== lease.ownerGeneration ||
    (!current.exists && !(options?.allowMissingLocal && lease.ownerID === undefined))
  )
    return yield* Effect.die(
      new AttemptFenceError("Session ownership changed before verifier attempt commit"),
    )
})

export const prepareAttemptClaim = Effect.fn("SessionVerificationRecovery.prepareAttemptClaim")(function* (
  db: DatabaseService,
  input: PrepareAttemptClaimInput,
) {
  const claimedAtMs = yield* Clock.currentTimeMillis
  const expiresAtMs = claimedAtMs + attemptLeaseDurationMs(input.timeoutMs)
  if (!Number.isSafeInteger(claimedAtMs) || !Number.isSafeInteger(expiresAtMs))
    return yield* Effect.die(new AttemptFenceError("Verifier attempt lease timestamps exceed SQLite integer precision"))
  const owner = yield* attemptOwner(db, input.sessionID)
  return {
    receiptID: input.receiptID,
    sessionID: input.sessionID,
    ownerID: owner.ownerID,
    ownerGeneration: owner.ownerGeneration,
    timeoutMs: input.timeoutMs,
    token: `vat_${crypto.randomUUID()}`,
    claimedAtMs,
    expiresAtMs,
  } satisfies AttemptClaim
})

/** The request projector initializes every new receipt at generation zero. */
export const initialAttemptLease = (claim: AttemptClaim): AttemptLease => ({ ...claim, generation: 1 })

const claimPreparedAttemptUnsafe = Effect.fn("SessionVerificationRecovery.claimPreparedAttemptUnsafe")(function* (
  db: DatabaseService,
  claim: AttemptClaim,
  options?: {
    readonly allowMissingLocal?: boolean
    readonly pinTimeout?: boolean
  },
) {
  if (
    claim.token.length === 0 ||
    !Number.isSafeInteger(claim.timeoutMs) ||
    claim.timeoutMs < 1 ||
    claim.timeoutMs > VerifierRegistry.MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(claim.claimedAtMs) ||
    !Number.isSafeInteger(claim.expiresAtMs) ||
    claim.expiresAtMs <= claim.claimedAtMs ||
    claim.expiresAtMs - claim.claimedAtMs !==
      attemptLeaseDurationMs(claim.timeoutMs)
  )
    return yield* Effect.die(new AttemptFenceError("Invalid verifier attempt claim"))
  const nowMs = yield* Clock.currentTimeMillis
  if (claim.expiresAtMs <= nowMs)
    return yield* Effect.die(new AttemptFenceError("Verifier attempt claim expired before it was committed"))
  yield* assertAttemptOwner(db, claim, options)

  const claimed = yield* db
    .update(VerificationReceiptTable)
    .set({
      attempt_generation: sql`${VerificationReceiptTable.attempt_generation} + 1`,
      ...(options?.pinTimeout
        ? { attempt_timeout_ms: claim.timeoutMs }
        : {}),
      attempt_token: claim.token,
      attempt_lease_expires: claim.expiresAtMs,
    })
    .where(
      and(
        eq(VerificationReceiptTable.id, claim.receiptID),
        eq(VerificationReceiptTable.session_id, claim.sessionID),
        options?.pinTimeout
          ? isNull(VerificationReceiptTable.attempt_timeout_ms)
          : eq(
              VerificationReceiptTable.attempt_timeout_ms,
              claim.timeoutMs,
            ),
        isNull(VerificationReceiptTable.verdict),
        isNotNull(VerificationReceiptTable.verifier),
        or(
          and(isNull(VerificationReceiptTable.attempt_token), isNull(VerificationReceiptTable.attempt_lease_expires)),
          and(
            isNotNull(VerificationReceiptTable.attempt_token),
            isNotNull(VerificationReceiptTable.attempt_lease_expires),
            lte(VerificationReceiptTable.attempt_lease_expires, nowMs),
          ),
        ),
      ),
    )
    .returning({ generation: VerificationReceiptTable.attempt_generation })
    .get()
    .pipe(Effect.orDie)
  if (!claimed) return undefined
  if (!Number.isSafeInteger(claimed.generation) || claimed.generation < 1)
    return yield* Effect.die(new AttemptFenceError("Invalid verifier attempt generation"))
  return { ...claim, generation: claimed.generation } satisfies AttemptLease
})

/**
 * Atomically claims an unleased or expired pending verifier receipt. An active,
 * terminal, missing-verifier, or malformed row is never claimed.
 */
export const claimAttempt = Effect.fn("SessionVerificationRecovery.claimAttempt")(function* (
  db: DatabaseService,
  input: ClaimAttemptInput,
) {
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const receipt = yield* db
            .select({
              timeoutMs: VerificationReceiptTable.attempt_timeout_ms,
            })
            .from(VerificationReceiptTable)
            .where(
              and(
                eq(VerificationReceiptTable.id, input.receiptID),
                eq(VerificationReceiptTable.session_id, input.sessionID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (receipt?.timeoutMs !== input.timeoutMs)
            return yield* Effect.die(
              new AttemptFenceError(
                "Verifier attempt timeout does not match the pinned request timeout",
              ),
            )
          const claim = yield* prepareAttemptClaim(db, input)
          return yield* claimPreparedAttemptUnsafe(db, claim)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

/**
 * Commit hook for a live verifier settlement. The exact generation, token and
 * unexpired deadline must still be current; clearing the token revokes all
 * later settlements from that attempt in the same durable event transaction.
 */
export const commitAttemptSettlement = Effect.fn("SessionVerificationRecovery.commitAttemptSettlement")(function* (
  db: DatabaseService,
  lease: AttemptLease,
) {
  // This function is a durable-event commit hook. The Event service invokes it
  // inside the same immediate transaction as projector and event inserts.
  yield* assertAttemptOwner(db, lease)
  const nowMs = yield* Clock.currentTimeMillis
  const fenced = yield* db
    .update(VerificationReceiptTable)
    .set({ attempt_token: null, attempt_lease_expires: null })
    .where(
      and(
        eq(VerificationReceiptTable.id, lease.receiptID),
        eq(VerificationReceiptTable.session_id, lease.sessionID),
        eq(VerificationReceiptTable.attempt_generation, lease.generation),
        eq(VerificationReceiptTable.attempt_timeout_ms, lease.timeoutMs),
        eq(VerificationReceiptTable.attempt_token, lease.token),
        eq(VerificationReceiptTable.attempt_lease_expires, lease.expiresAtMs),
        gt(VerificationReceiptTable.attempt_lease_expires, nowMs),
      ),
    )
    .returning({ generation: VerificationReceiptTable.attempt_generation })
    .get()
    .pipe(Effect.orDie)
  if (!fenced)
    return yield* Effect.die(new AttemptFenceError("Verifier attempt lease was lost or expired before settlement"))
})

/**
 * Reconstruct the exact pending request from durable state and prove that the
 * caller still holds the full persisted attempt/owner fence before contacting
 * an external attestation supervisor. The same fields are CASed again by
 * `commitAttemptSettlement` in the durable settlement transaction.
 */
export const settlementAdmissionBindingLoader = (
  db: DatabaseService,
): VerifierSettlementAdmission.BindingLoader =>
  Effect.fn("SessionVerificationRecovery.settlementAdmissionBindingLoader")(
    function* (attempt) {
      const receipt = yield* db
        .select({
          assistantMessageID:
            VerificationReceiptTable.assistant_message_id,
          locationKey: VerificationReceiptTable.location_key,
          mode: VerificationReceiptTable.mode,
          mutationEpoch: VerificationReceiptTable.mutation_epoch,
          snapshot: VerificationReceiptTable.subject_snapshot,
          verifier: VerificationReceiptTable.verifier,
          verdict: VerificationReceiptTable.verdict,
          attemptGeneration:
            VerificationReceiptTable.attempt_generation,
          attemptTimeoutMs:
            VerificationReceiptTable.attempt_timeout_ms,
          attemptToken: VerificationReceiptTable.attempt_token,
          attemptExpiresAtMs:
            VerificationReceiptTable.attempt_lease_expires,
        })
        .from(VerificationReceiptTable)
        .where(
          and(
            eq(VerificationReceiptTable.id, attempt.receiptID),
            eq(VerificationReceiptTable.session_id, attempt.sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const owner = yield* attemptOwner(db, attempt.sessionID)
      const session = yield* db
        .select({ projectID: SessionTable.project_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, attempt.sessionID))
        .get()
        .pipe(Effect.orDie)
      const nowMs = yield* Clock.currentTimeMillis
      const claimedAtMs =
        attempt.expiresAtMs - attemptLeaseDurationMs(attempt.timeoutMs)
      if (
        !receipt ||
        receipt.verdict !== null ||
        receipt.verifier === null ||
        receipt.snapshot === null ||
        receipt.attemptGeneration !== attempt.generation ||
        receipt.attemptTimeoutMs !== attempt.timeoutMs ||
        receipt.attemptToken !== attempt.token ||
        receipt.attemptExpiresAtMs !== attempt.expiresAtMs ||
        claimedAtMs !== attempt.claimedAtMs ||
        attempt.claimedAtMs > nowMs ||
        attempt.expiresAtMs <= nowMs ||
        !session ||
        !owner.exists ||
        owner.ownerID !== attempt.ownerID ||
        owner.ownerGeneration !== attempt.ownerGeneration
      )
        return yield* Effect.fail(
          new AttemptFenceError(
            "Durable verifier request or attempt changed before attestation admission",
          ),
        )

      const request = VerificationReceipt.Request.make({
        id: attempt.receiptID,
        ...(receipt.assistantMessageID
          ? { assistantMessageID: receipt.assistantMessageID }
          : {}),
        locationKey: receipt.locationKey,
        mode: receipt.mode,
        subject: {
          mutationEpoch: receipt.mutationEpoch,
          ...(receipt.snapshot ? { snapshot: receipt.snapshot } : {}),
        },
        verifier: receipt.verifier,
      })
      return {
        request,
        attempt,
        projectID: session.projectID,
      }
    },
  )

const hasRecoveryAuthority = Effect.fn("SessionVerificationRecovery.hasRecoveryAuthority")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  authority: RecoveryAuthority,
) {
  const ownership = yield* db
    .select({
      ownerID: EventSequenceTable.owner_id,
      ownerGeneration: EventSequenceTable.owner_generation,
    })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return (
    Number.isSafeInteger(authority.ownerGeneration) &&
    authority.ownerGeneration >= 0 &&
    ownership !== undefined &&
    (ownership.ownerID ?? undefined) === authority.ownerID &&
    ownership.ownerGeneration === authority.ownerGeneration
  )
})

const assertRecoveryAuthority = Effect.fn("SessionVerificationRecovery.assertRecoveryAuthority")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  authority: RecoveryAuthority,
) {
  if (!(yield* hasRecoveryAuthority(db, sessionID, authority)))
    return yield* Effect.die("Verification recovery authority changed")
})

export const prepareRequest = Effect.fn("SessionVerificationRecovery.prepareRequest")(function* (
  db: DatabaseService,
  input: PrepareInput,
) {
  const requestedAt = yield* DateTime.now
  const requested = DateTime.toEpochMillis(requestedAt)
  const id = VerificationReceipt.ID.make(`vrc_${crypto.randomUUID()}`)
  const eventID = EventBus.ID.create()

  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const state = yield* tx
            .insert(VerificationLocationStateTable)
            .values({
              location_key: input.locationKey,
              mutation_epoch: 1,
              snapshot: input.snapshot,
              time_created: requested,
              time_updated: requested,
            })
            .onConflictDoUpdate({
              target: VerificationLocationStateTable.location_key,
              set: {
                mutation_epoch: sql`${VerificationLocationStateTable.mutation_epoch} + 1`,
                snapshot: input.snapshot,
                time_updated: requested,
              },
            })
            .returning({ mutationEpoch: VerificationLocationStateTable.mutation_epoch })
            .get()
          if (!state) return yield* Effect.die("Failed to allocate verification epoch")

          const request = VerificationReceipt.Request.make({
            id,
            assistantMessageID: input.assistantMessageID,
            locationKey: input.locationKey,
            mode: "shadow",
            subject: {
              mutationEpoch: state.mutationEpoch,
              snapshot: input.snapshot,
            },
            verifier: input.verifier,
          })
          yield* tx
            .insert(VerificationRequestOutboxTable)
            .values({
              receipt_id: id,
              event_id: eventID,
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              location_key: input.locationKey,
              mode: "shadow",
              mutation_epoch: state.mutationEpoch,
              subject_snapshot: input.snapshot,
              verifier: input.verifier,
              time_requested: requested,
            })
            .run()

          return {
            id,
            eventID,
            requestedAt,
            mutationEpoch: state.mutationEpoch,
            request,
          } satisfies PreparedRequest
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const publishPreparedRequest = Effect.fn("SessionVerificationRecovery.publishPreparedRequest")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  prepared: PreparedRequest,
  sessionID: SessionSchema.ID,
  options?: PublishPreparedRequestOptions,
) {
  return yield* events.publish(
    SessionEvent.VerificationRequested,
    {
      sessionID,
      timestamp: prepared.requestedAt,
      request: prepared.request,
    },
    {
      id: prepared.eventID,
      commit: () =>
        Effect.gen(function* () {
          if (options?.recovery) yield* assertRecoveryAuthority(db, sessionID, options.recovery)
          if (options?.attempt) {
            if (options.attempt.receiptID !== prepared.id || options.attempt.sessionID !== sessionID)
              return yield* Effect.die(new AttemptFenceError("Verifier attempt claim does not match its request"))
            const lease = yield* claimPreparedAttemptUnsafe(
              db,
              options.attempt,
              { allowMissingLocal: true, pinTimeout: true },
            )
            if (!lease || lease.generation !== 1)
              return yield* Effect.die(new AttemptFenceError("Failed to atomically claim the initial verifier attempt"))
          }
          yield* db
            .delete(VerificationRequestOutboxTable)
            .where(
              and(
                eq(VerificationRequestOutboxTable.receipt_id, prepared.id),
                eq(VerificationRequestOutboxTable.event_id, prepared.eventID),
                eq(VerificationRequestOutboxTable.session_id, sessionID),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }),
    },
  )
})

const fromOutbox = (row: typeof VerificationRequestOutboxTable.$inferSelect): PreparedRequest => ({
  id: row.receipt_id,
  eventID: row.event_id,
  requestedAt: DateTime.makeUnsafe(row.time_requested),
  mutationEpoch: row.mutation_epoch,
  request: VerificationReceipt.Request.make({
    id: row.receipt_id,
    ...(row.assistant_message_id ? { assistantMessageID: row.assistant_message_id } : {}),
    locationKey: row.location_key,
    mode: row.mode,
    subject: {
      mutationEpoch: row.mutation_epoch,
      ...(row.subject_snapshot ? { snapshot: row.subject_snapshot } : {}),
    },
    ...(row.verifier ? { verifier: row.verifier } : {}),
  }),
})

const requestMatches = Effect.fn("SessionVerificationRecovery.requestMatches")(function* (
  db: DatabaseService,
  row: typeof VerificationRequestOutboxTable.$inferSelect,
) {
  return yield* preparedRequestWasPublished(db, fromOutbox(row), row.session_id)
})

const clearPublishedIntent = Effect.fn("SessionVerificationRecovery.clearPublishedIntent")(function* (
  db: DatabaseService,
  row: typeof VerificationRequestOutboxTable.$inferSelect,
  authority: RecoveryAuthority,
) {
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* assertRecoveryAuthority(db, row.session_id, authority)
          yield* db
            .delete(VerificationRequestOutboxTable)
            .where(
              and(
                eq(VerificationRequestOutboxTable.receipt_id, row.receipt_id),
                eq(VerificationRequestOutboxTable.event_id, row.event_id),
                eq(VerificationRequestOutboxTable.session_id, row.session_id),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const preparedRequestWasPublished = Effect.fn("SessionVerificationRecovery.preparedRequestWasPublished")(
  function* (db: DatabaseService, prepared: PreparedRequest, sessionID: SessionSchema.ID) {
    const receipt = yield* db
      .select()
      .from(VerificationReceiptTable)
      .where(eq(VerificationReceiptTable.id, prepared.id))
      .get()
      .pipe(Effect.orDie)
    const event = yield* db
      .select({ aggregateID: EventTable.aggregate_id, type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.id, prepared.eventID))
      .get()
      .pipe(Effect.orDie)
    const request = prepared.request
    const eventData = event?.data as
      | {
          readonly sessionID?: unknown
          readonly timestamp?: unknown
          readonly request?: { readonly id?: unknown }
        }
      | undefined
    return (
      receipt !== undefined &&
      event !== undefined &&
      event.aggregateID === sessionID &&
      event.type ===
        EventBus.versionedType(
          SessionEvent.VerificationRequested.type,
          SessionEvent.VerificationRequested.durable!.version,
        ) &&
      eventData?.sessionID === sessionID &&
      eventData.timestamp === DateTime.toEpochMillis(prepared.requestedAt) &&
      eventData.request?.id === prepared.id &&
      receipt.session_id === sessionID &&
      receipt.assistant_message_id === (request.assistantMessageID ?? null) &&
      receipt.location_key === request.locationKey &&
      receipt.mode === request.mode &&
      receipt.mutation_epoch === request.subject.mutationEpoch &&
      receipt.subject_snapshot === (request.subject.snapshot ?? null) &&
      isDeepStrictEqual(receipt.verifier, request.verifier ?? null) &&
      receipt.time_requested === DateTime.toEpochMillis(prepared.requestedAt)
    )
  },
)

const subjectIsCurrent = Effect.fn("SessionVerificationRecovery.subjectIsCurrent")(function* (
  db: DatabaseService,
  input: {
    readonly locationKey: VerificationReceipt.LocationKey
    readonly mutationEpoch: number
    readonly snapshot: string | null
  },
) {
  const state = yield* db
    .select({
      mutationEpoch: VerificationLocationStateTable.mutation_epoch,
      snapshot: VerificationLocationStateTable.snapshot,
    })
    .from(VerificationLocationStateTable)
    .where(eq(VerificationLocationStateTable.location_key, input.locationKey))
    .get()
    .pipe(Effect.orDie)
  return state !== undefined && state.mutationEpoch === input.mutationEpoch && state.snapshot === input.snapshot
})

const terminalVerdict = Effect.fn("SessionVerificationRecovery.terminalVerdict")(function* (
  db: DatabaseService,
  id: VerificationReceipt.ID,
) {
  const receipt = yield* db
    .select({ verdict: VerificationReceiptTable.verdict })
    .from(VerificationReceiptTable)
    .where(eq(VerificationReceiptTable.id, id))
    .get()
    .pipe(Effect.orDie)
  return receipt?.verdict ?? undefined
})

type PendingAttempt = {
  readonly id: VerificationReceipt.ID
  readonly sessionID: SessionSchema.ID
  readonly attemptGeneration: number
  readonly attemptTimeoutMs: number | null
  readonly attemptToken: string | null
  readonly attemptLeaseExpires: number | null
}

type AttemptRecoveryState = "unleased" | "expired" | "active" | "blocked"

const attemptRecoveryState = (row: PendingAttempt, nowMs: number): AttemptRecoveryState => {
  if (!Number.isSafeInteger(row.attemptGeneration) || row.attemptGeneration < 0) return "blocked"
  if (
    (row.attemptGeneration === 0 && row.attemptTimeoutMs !== null) ||
    (row.attemptGeneration > 0 &&
      (row.attemptTimeoutMs === null ||
        !Number.isSafeInteger(row.attemptTimeoutMs) ||
        row.attemptTimeoutMs < 1 ||
        row.attemptTimeoutMs > VerifierRegistry.MAX_TIMEOUT_MS))
  )
    return "blocked"
  if (row.attemptToken === null && row.attemptLeaseExpires === null) return "unleased"
  if (
    row.attemptToken === null ||
    row.attemptToken.length === 0 ||
    row.attemptLeaseExpires === null ||
    !Number.isSafeInteger(row.attemptLeaseExpires)
  )
    return "blocked"
  return row.attemptLeaseExpires <= nowMs ? "expired" : "active"
}

/**
 * Recovery uses the exact attempt state it scanned as a compare-and-swap
 * fence. If another process claims or renews the receipt, this commit fails and
 * the settlement event is rolled back with its projector changes.
 */
const commitRecoveryAttemptFence = Effect.fn("SessionVerificationRecovery.commitRecoveryAttemptFence")(function* (
  db: DatabaseService,
  row: PendingAttempt,
) {
  const nowMs = yield* Clock.currentTimeMillis
  const state = attemptRecoveryState(row, nowMs)
  if (state === "active" || state === "blocked")
    return yield* Effect.die(new AttemptFenceError("Verifier attempt is still leased or has malformed lease state"))
  const exactState =
    row.attemptToken === null
      ? and(isNull(VerificationReceiptTable.attempt_token), isNull(VerificationReceiptTable.attempt_lease_expires))
      : and(
          eq(VerificationReceiptTable.attempt_token, row.attemptToken),
          eq(VerificationReceiptTable.attempt_lease_expires, row.attemptLeaseExpires!),
          lte(VerificationReceiptTable.attempt_lease_expires, nowMs),
        )
  const fenced = yield* db
    .update(VerificationReceiptTable)
    .set({ attempt_token: null, attempt_lease_expires: null })
    .where(
      and(
        eq(VerificationReceiptTable.id, row.id),
        eq(VerificationReceiptTable.session_id, row.sessionID),
        eq(VerificationReceiptTable.attempt_generation, row.attemptGeneration),
        row.attemptTimeoutMs === null
          ? isNull(VerificationReceiptTable.attempt_timeout_ms)
          : eq(
              VerificationReceiptTable.attempt_timeout_ms,
              row.attemptTimeoutMs,
            ),
        exactState,
      ),
    )
    .returning({ generation: VerificationReceiptTable.attempt_generation })
    .get()
    .pipe(Effect.orDie)
  if (!fenced) return yield* Effect.die(new AttemptFenceError("Verifier attempt changed before recovery settlement"))
})

/**
 * Replays abandoned request intents and terminalizes pending receipts without
 * re-executing a verifier. A current pinned request becomes `abandoned`, a
 * current request without a verifier remains `missing`, and an advanced
 * subject becomes `stale`.
 */
export const recoverPendingForSession = Effect.fn("SessionVerificationRecovery.recoverPendingForSession")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: RecoveryInput,
) {
  const settlements = yield* VerificationSettlementPublisher.Service
  const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis)
  const leaseNowMs = yield* Clock.currentTimeMillis
  const minAgeMs = Math.max(0, input.minAgeMs ?? RECOVERY_MIN_AGE_MS)
  const limit = Math.max(1, Math.min(1_000, input.limit ?? RECOVERY_BATCH_SIZE))
  const cutoff = nowMs - minAgeMs
  let requestsRecovered = 0
  let receiptsSettled = 0
  let alreadyTerminal = 0
  let failures = 0
  let interrupted = false

  if (!(yield* hasRecoveryAuthority(db, input.sessionID, input)))
    return {
      authorized: false,
      requestIntentsScanned: 0,
      requestsRecovered: 0,
      receiptsScanned: 0,
      receiptsSettled: 0,
      alreadyTerminal: 0,
      failures: 0,
    } satisfies RecoveryResult

  const intents = yield* db
    .select()
    .from(VerificationRequestOutboxTable)
    .where(eq(VerificationRequestOutboxTable.session_id, input.sessionID))
    .orderBy(asc(VerificationRequestOutboxTable.time_requested))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)

  yield* Effect.forEach(
    intents,
    (row) =>
      Effect.gen(function* () {
        if (interrupted) return
        const current = yield* subjectIsCurrent(db, {
          locationKey: row.location_key,
          mutationEpoch: row.mutation_epoch,
          snapshot: row.subject_snapshot,
        })
        if (current && row.time_requested > cutoff) return
        const published = yield* publishPreparedRequest(db, events, fromOutbox(row), row.session_id, {
          recovery: {
            ownerID: input.ownerID,
            ownerGeneration: input.ownerGeneration,
          },
        }).pipe(Effect.exit)
        if (published._tag === "Success") {
          requestsRecovered++
          return
        }
        interrupted = Cause.hasInterrupts(published.cause)
        if (!(yield* requestMatches(db, row))) {
          failures++
          return
        }
        const cleared = yield* clearPublishedIntent(db, row, input).pipe(Effect.exit)
        if (cleared._tag === "Success") requestsRecovered++
        else failures++
      }),
    { discard: true },
  )
  if (interrupted) return yield* Effect.interrupt

  const pending = yield* db
    .select({
      id: VerificationReceiptTable.id,
      sessionID: VerificationReceiptTable.session_id,
      locationKey: VerificationReceiptTable.location_key,
      mutationEpoch: VerificationReceiptTable.mutation_epoch,
      snapshot: VerificationReceiptTable.subject_snapshot,
      verifier: VerificationReceiptTable.verifier,
      timeRequested: VerificationReceiptTable.time_requested,
      attemptGeneration: VerificationReceiptTable.attempt_generation,
      attemptTimeoutMs: VerificationReceiptTable.attempt_timeout_ms,
      attemptToken: VerificationReceiptTable.attempt_token,
      attemptLeaseExpires: VerificationReceiptTable.attempt_lease_expires,
    })
    .from(VerificationReceiptTable)
    .where(
      and(
        eq(VerificationReceiptTable.session_id, input.sessionID),
        isNull(VerificationReceiptTable.verdict),
        or(
          and(
            eq(VerificationReceiptTable.attempt_generation, 0),
            isNull(VerificationReceiptTable.attempt_timeout_ms),
            isNull(VerificationReceiptTable.attempt_token),
            isNull(VerificationReceiptTable.attempt_lease_expires),
          ),
          and(
            gt(VerificationReceiptTable.attempt_generation, 0),
            gt(VerificationReceiptTable.attempt_timeout_ms, 0),
            lte(
              VerificationReceiptTable.attempt_timeout_ms,
              VerifierRegistry.MAX_TIMEOUT_MS,
            ),
            isNotNull(VerificationReceiptTable.attempt_token),
            ne(VerificationReceiptTable.attempt_token, ""),
            isNotNull(VerificationReceiptTable.attempt_lease_expires),
            lte(
              VerificationReceiptTable.attempt_lease_expires,
              leaseNowMs,
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(VerificationReceiptTable.time_requested))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)

  yield* Effect.forEach(
    pending,
    (row) =>
      Effect.gen(function* () {
        if (interrupted) return
        const attemptState = attemptRecoveryState(row, leaseNowMs)
        if (attemptState === "active" || attemptState === "blocked") return
        const current = yield* subjectIsCurrent(db, {
          locationKey: row.locationKey,
          mutationEpoch: row.mutationEpoch,
          snapshot: row.snapshot,
        })
        if (current && attemptState !== "expired" && row.timeRequested > cutoff) return
        const verdict = current ? (row.verifier ? "abandoned" : "missing") : "stale"
        const settled = yield* settlements
          .settle(
            {
              sessionID: row.sessionID,
              timestamp: DateTime.makeUnsafe(Math.max(nowMs, row.timeRequested)),
              settlement: {
                id: row.id,
                verdict,
                checks: [],
                reason:
                  verdict === "stale"
                    ? "Verification subject advanced before recovery"
                    : verdict === "missing"
                      ? "Recovered a request with no trusted verifier selected"
                      : "Verifier outcome unavailable after process interruption",
              },
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  yield* assertRecoveryAuthority(db, row.sessionID, input)
                  const committedCurrent = yield* subjectIsCurrent(db, {
                    locationKey: row.locationKey,
                    mutationEpoch: row.mutationEpoch,
                    snapshot: row.snapshot,
                  })
                  if (committedCurrent !== (verdict !== "stale"))
                    return yield* Effect.die("Verification subject changed before recovery settlement")
                  yield* commitRecoveryAttemptFence(db, row)
                }),
            },
          )
          .pipe(Effect.exit)
        if (settled._tag === "Success") {
          receiptsSettled++
          return
        }
        interrupted = Cause.hasInterrupts(settled.cause)
        if ((yield* terminalVerdict(db, row.id)) !== undefined) {
          alreadyTerminal++
          return
        }
        failures++
      }),
    { discard: true },
  )
  if (interrupted) return yield* Effect.interrupt

  return {
    authorized: true,
    requestIntentsScanned: intents.length,
    requestsRecovered,
    receiptsScanned: pending.length,
    receiptsSettled,
    alreadyTerminal,
    failures,
  } satisfies RecoveryResult
})
