export * as SessionVerification from "./service"
export { RECOVERY_BATCH_SIZE, RECOVERY_MIN_AGE_MS, recoverPendingForSession } from "./recovery"

import { VerificationReceipt } from "../../contracts/execution/verification-receipt"
import { eq } from "drizzle-orm"
import { Cause, Clock, DateTime, Effect, Option, Schema } from "effect"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "../../storage/database"
import type { EventBus } from "../../runtime/events/bus"
import type { Location } from "../../workspace/location"
import type { Snapshot } from "../../workspace/repository/snapshot"
import { Hash } from "../../shared/hash"
import { VerifierContainment } from "../../verification/containment"
import { VerifierRegistry } from "../../verification/registry"
import { VerifierSettlementAdmission } from "../../verification/settlement-admission"
import { VerificationSettlementPublisher } from "../../runtime/events/verification-publisher"
import { SessionMessage } from "../messages/service"
import { Session as SessionSchema } from "../../contracts/session/info"
import { VerificationLocationStateTable, VerificationReceiptTable } from "../../storage/tables/sessions"
import { SessionVerificationRecovery } from "./recovery"

type DatabaseService = Database.Interface["db"]

export type MissingReason =
  | "Trusted verifier registry selection failed"
  | "Trusted verifier registry returned a non-canonical selection"
  | "Trusted verifier authorization was not valid at verification admission"
  | "Trusted verifier selection was invalid for this location"
  | "Unable to capture complete verifier subject"

export type RecordMissingInput = {
  readonly sessionID: SessionSchema.ID
  readonly location: Location.Interface
  readonly snapshot: Snapshot.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly reason?: MissingReason
}

export type RecordInput = RecordMissingInput & {
  readonly selection?: VerifierRegistry.Selection
  readonly containment: VerifierContainment.Interface
  readonly captureSnapshot: () => Effect.Effect<Snapshot.ID | undefined>
  /** Explicit provider-backed boundary; absent keeps the receipt shadow-only. */
  readonly settlementAdmission?: VerifierSettlementAdmission.Interface
}

export type Recorded = {
  readonly id: VerificationReceipt.ID
  readonly locationKey: VerificationReceipt.LocationKey
  readonly mutationEpoch: number
  readonly verdict: VerificationReceipt.Verdict
}

/** Stable opaque identity for a Location without persisting its path in receipts. */
export const locationKey = (location: Location.Interface) => {
  const relative = path.relative(location.project.directory, location.directory).replaceAll("\\", "/") || "."
  return VerificationReceipt.LocationKey.make(
    `loc_${Hash.sha256(JSON.stringify([location.project.id, relative, location.workspaceID ?? null]))}`,
  )
}

/**
 * Canonical authorization root for verifier policy selection. VCS projects
 * share their discovered repository root; non-VCS locations must remain
 * isolated instead of collapsing to the filesystem root of Project.ID.global.
 */
export const selectionRoot = (location: Location.Interface) =>
  location.vcs?.type === "git" ? location.project.directory : location.directory

const current = Effect.fn("SessionVerification.current")(function* (
  db: DatabaseService,
  key: VerificationReceipt.LocationKey,
) {
  return yield* db
    .select({
      mutationEpoch: VerificationLocationStateTable.mutation_epoch,
      snapshot: VerificationLocationStateTable.snapshot,
    })
    .from(VerificationLocationStateTable)
    .where(eq(VerificationLocationStateTable.location_key, key))
    .get()
    .pipe(Effect.orDie)
})

const settledVerdict = Effect.fn("SessionVerification.settledVerdict")(function* (
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

const matches = (state: Effect.Success<ReturnType<typeof current>>, mutationEpoch: number, snapshot: Snapshot.ID) =>
  state !== undefined && state.mutationEpoch === mutationEpoch && state.snapshot === snapshot

const nowAtOrAfter = Effect.fnUntraced(function* (floor: DateTime.Utc) {
  const now = yield* DateTime.now
  return DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(floor), DateTime.toEpochMillis(now)))
})

const recordMissingUnsafe = Effect.fn("SessionVerification.recordMissingUnsafe")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: RecordMissingInput,
) {
  const settlements = yield* VerificationSettlementPublisher.Service
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const key = locationKey(input.location)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        locationKey: key,
        snapshot: input.snapshot,
      })
      const { id, requestedAt } = prepared
      const state = { mutationEpoch: prepared.mutationEpoch, snapshot: input.snapshot }
      const request = yield* SessionVerificationRecovery.publishPreparedRequest(
        db,
        events,
        prepared,
        input.sessionID,
      ).pipe(Effect.exit)
      if (
        request._tag === "Failure" &&
        !(yield* SessionVerificationRecovery.preparedRequestWasPublished(db, prepared, input.sessionID))
      )
        return yield* Effect.failCause(request.cause)
      let interrupted = request._tag === "Failure" && Cause.hasInterrupts(request.cause)
      if (request._tag === "Failure" && !interrupted)
        yield* Effect.logWarning("Verification request committed with a notification failure", {
          sessionID: input.sessionID,
        })

      const latest = yield* current(db, key)
      const stale = !matches(latest, state.mutationEpoch, input.snapshot)
      const settle = Effect.fnUntraced(function* (verdict: "missing" | "stale") {
        return yield* settlements.settle(
          {
            sessionID: input.sessionID,
            timestamp: yield* nowAtOrAfter(requestedAt),
            settlement: {
              id,
              verdict,
              checks: [],
              reason:
                verdict === "stale"
                  ? "Location advanced before shadow verification settled"
                  : (input.reason ?? "No trusted verifier selected in shadow mode"),
            },
          },
          verdict === "missing"
            ? {
                commit: () =>
                  Effect.gen(function* () {
                    const committed = yield* current(db, key)
                    if (!matches(committed, state.mutationEpoch, input.snapshot))
                      return yield* Effect.die("Verification subject advanced before settlement commit")
                  }),
              }
            : undefined,
        )
      })
      const verdict = stale ? "stale" : "missing"
      const settled = yield* settle(verdict).pipe(Effect.exit)
      if (settled._tag === "Failure") {
        interrupted ||= Cause.hasInterrupts(settled.cause)
        const persisted = yield* settledVerdict(db, id)
        if (persisted === "missing" || persisted === "stale") {
          if (!Cause.hasInterrupts(settled.cause))
            yield* Effect.logWarning("Verification settlement committed with a notification failure", {
              sessionID: input.sessionID,
            })
          if (interrupted) return yield* Effect.interrupt
          return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict: persisted }
        }
      }
      if (settled._tag === "Failure" && verdict === "missing") {
        const afterFailure = yield* current(db, key)
        if (!matches(afterFailure, state.mutationEpoch, input.snapshot)) {
          const staleSettlement = yield* settle("stale").pipe(Effect.exit)
          if (staleSettlement._tag === "Failure") {
            interrupted ||= Cause.hasInterrupts(staleSettlement.cause)
            const persisted = yield* settledVerdict(db, id)
            if (persisted === "missing" || persisted === "stale") {
              if (!Cause.hasInterrupts(staleSettlement.cause))
                yield* Effect.logWarning("Stale verification settlement committed with a notification failure", {
                  sessionID: input.sessionID,
                })
              if (interrupted) return yield* Effect.interrupt
              return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict: persisted }
            }
            if (!interrupted) return yield* Effect.failCause(staleSettlement.cause)
          }
          if (interrupted) return yield* Effect.interrupt
          return {
            id,
            locationKey: key,
            mutationEpoch: state.mutationEpoch,
            verdict: "stale" as const,
          }
        }
      }
      if (settled._tag === "Failure") {
        if (interrupted) return yield* Effect.interrupt
        return yield* Effect.failCause(settled.cause)
      }
      if (interrupted) return yield* Effect.interrupt
      return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict }
    }),
  )
})

/**
 * Records a verifier-missing shadow receipt. Failures are observable but never
 * escape into the user-facing Session drain.
 */
export const recordMissing = Effect.fn("SessionVerification.recordMissing")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: RecordMissingInput,
) {
  return yield* recordMissingUnsafe(db, events, input).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("Failed to record shadow verification receipt", {
          cause,
          sessionID: input.sessionID,
        }).pipe(Effect.as(undefined)),
    ),
  )
})

type Evidence = {
  readonly verdict: VerificationReceipt.CheckStatus
  readonly check: VerificationReceipt.Check
  readonly reason?: string
}

const decodeCheck = Schema.decodeUnknownSync(VerificationReceipt.Check)

const receiptCommand = (selection: VerifierRegistry.Selection) => ["<trusted-verifier>", selection.plan.check.id]

const errorEvidence = (selection: VerifierRegistry.Selection, durationMs: number, reason: string): Evidence => ({
  verdict: "error",
  reason,
  check: decodeCheck({
    id: selection.plan.check.id,
    command: receiptCommand(selection),
    status: "error",
    durationMs,
    summary: reason,
  }),
})

const timeoutEvidence = (selection: VerifierRegistry.Selection, durationMs: number, reason: string): Evidence => ({
  verdict: "timeout",
  reason,
  check: decodeCheck({
    id: selection.plan.check.id,
    command: receiptCommand(selection),
    status: "timeout",
    durationMs,
    summary: reason,
  }),
})

const containmentFailureEvidence = (
  selection: VerifierRegistry.Selection,
  durationMs: number,
  cause: Cause.Cause<unknown>,
) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (!(error instanceof VerifierContainment.Error))
    return errorEvidence(selection, durationMs, "Verifier containment execution failed")
  switch (error.reason) {
    case "unavailable":
      return errorEvidence(selection, durationMs, "Verifier containment is unavailable")
    case "descriptor-mismatch":
      return errorEvidence(selection, durationMs, "Verifier containment executor descriptor did not match")
    case "subject-mismatch":
      return errorEvidence(selection, durationMs, "Verifier containment subject did not match the selection")
    case "invalid-result":
      return errorEvidence(selection, durationMs, "Verifier containment returned an invalid result")
    case "output-limit":
      return errorEvidence(selection, durationMs, "Verifier containment returned output beyond the pinned limit")
    case "timeout":
      return timeoutEvidence(selection, durationMs, "Verifier containment exceeded the pinned timeout")
    case "materialization":
      return errorEvidence(selection, durationMs, "Verifier subject materialization failed")
    case "launch":
      return errorEvidence(selection, durationMs, "Verifier containment launch failed")
    case "cleanup":
      return errorEvidence(selection, durationMs, "Verifier containment cleanup failed")
  }
}

const evidenceFromResult = (
  selection: VerifierRegistry.Selection,
  subject: VerifierContainment.Subject,
  result: VerifierContainment.Result,
  durationMs: number,
): Evidence => {
  if (!isDeepStrictEqual(result.subject, subject))
    return errorEvidence(selection, durationMs, "Verifier containment subject did not match the selection")
  if (!isDeepStrictEqual(result.executor, selection.plan.executor))
    return errorEvidence(selection, durationMs, "Verifier containment executor descriptor did not match")

  const outputBytes = Buffer.byteLength(result.stdout ?? "", "utf8") + Buffer.byteLength(result.stderr ?? "", "utf8")
  if (outputBytes > selection.plan.check.maxOutputBytes)
    return errorEvidence(selection, durationMs, "Verifier containment returned output beyond the pinned limit")
  if (durationMs > selection.plan.check.timeoutMs || result.durationMs > selection.plan.check.timeoutMs)
    return timeoutEvidence(selection, durationMs, "Verifier containment exceeded the pinned timeout")

  const summary =
    result.status === "passed"
      ? "Verifier check passed"
      : result.status === "failed"
        ? "Verifier check failed"
        : result.status === "timeout"
          ? "Verifier check timed out"
          : "Verifier check returned an infrastructure error"
  const evidenceWithheld =
    result.outputTruncated || result.summary !== undefined || result.stdout !== undefined || result.stderr !== undefined

  return {
    verdict: result.status,
    ...(result.status === "error" || result.status === "timeout" ? { reason: summary } : {}),
    check: decodeCheck({
      id: selection.plan.check.id,
      command: receiptCommand(selection),
      status: result.status,
      exitCode: result.exitCode,
      durationMs,
      summary,
      outputTruncated: evidenceWithheld,
    }),
  }
}

const recordSelectedUnsafe = Effect.fn("SessionVerification.recordSelectedUnsafe")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: RecordInput & { readonly selection: VerifierRegistry.Selection },
) {
  const settlements = yield* VerificationSettlementPublisher.Service
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const key = locationKey(input.location)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        locationKey: key,
        snapshot: input.snapshot,
        verifier: input.selection.verifier,
      })
      const { id, requestedAt } = prepared
      const attemptClaim = yield* SessionVerificationRecovery.prepareAttemptClaim(
        db,
        {
          receiptID: id,
          sessionID: input.sessionID,
          timeoutMs: input.selection.plan.check.timeoutMs,
        },
      )
      const attemptLease = SessionVerificationRecovery.initialAttemptLease(attemptClaim)
      const state = { mutationEpoch: prepared.mutationEpoch, snapshot: input.snapshot }
      const subject = {
        executionID: id,
        snapshot: input.snapshot,
        projectID: input.location.project.id,
        locationKey: key,
      } satisfies VerifierContainment.Subject
      const request = yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, input.sessionID, {
        attempt: attemptClaim,
      }).pipe(Effect.exit)
      if (
        request._tag === "Failure" &&
        !(yield* SessionVerificationRecovery.preparedRequestWasPublished(db, prepared, input.sessionID))
      )
        return yield* Effect.failCause(request.cause)
      const requestInterrupted = request._tag === "Failure" && Cause.hasInterrupts(request.cause)
      if (request._tag === "Failure" && !requestInterrupted)
        yield* Effect.logWarning("Verification request committed with a notification failure", {
          sessionID: input.sessionID,
        })

      const startedAt = yield* nowAtOrAfter(requestedAt)
      const startedNanos = yield* Clock.currentTimeNanos
      const execution = requestInterrupted
        ? undefined
        : yield* restore(
            Effect.suspend(() =>
              input.containment.execute({
                selection: input.selection,
                subject,
              }),
            ).pipe(
              Effect.timeoutOrElse({
                duration: input.selection.plan.check.timeoutMs,
                orElse: () =>
                  Effect.fail(
                    new VerifierContainment.Error({
                      reason: "timeout",
                      message: "Verifier containment exceeded the pinned timeout",
                    }),
                  ),
              }),
            ),
          ).pipe(Effect.exit)
      const completedNanos = yield* Clock.currentTimeNanos
      const durationMs = Number((completedNanos >= startedNanos ? completedNanos - startedNanos : 0n) / 1_000_000n)
      let interrupted = requestInterrupted || (execution?._tag === "Failure" && Cause.hasInterrupts(execution.cause))

      let evidence: Evidence
      if (requestInterrupted) {
        evidence = errorEvidence(input.selection, durationMs, "Verification request notification was interrupted")
      } else if (execution?._tag === "Failure") {
        evidence = interrupted
          ? errorEvidence(input.selection, durationMs, "Verifier containment execution was interrupted")
          : containmentFailureEvidence(input.selection, durationMs, execution.cause)
      } else {
        const decoded = yield* VerifierContainment.decodeResult(execution!.value).pipe(Effect.exit)
        evidence =
          decoded._tag === "Success"
            ? evidenceFromResult(input.selection, subject, decoded.value, durationMs)
            : errorEvidence(input.selection, durationMs, "Verifier containment returned an invalid result")
      }

      const recapture = yield* Effect.suspend(input.captureSnapshot).pipe(Effect.exit)
      const recaptured = recapture._tag === "Success" ? recapture.value : undefined
      const latest = yield* current(db, key)
      const stale =
        !matches(latest, state.mutationEpoch, input.snapshot) ||
        (recaptured !== undefined && recaptured !== input.snapshot)

      const settleStale = (reason: string) =>
        Effect.gen(function* () {
          return yield* settlements.settle(
            {
              sessionID: input.sessionID,
              timestamp: yield* nowAtOrAfter(requestedAt),
              settlement: {
                id,
                verdict: "stale",
                checks: [],
                reason,
              },
            },
            { commit: () => SessionVerificationRecovery.commitAttemptSettlement(db, attemptLease) },
          )
        })

      if (stale) {
        const staleSettlement = yield* settleStale(
          "Verification subject advanced before contained evidence could settle",
        ).pipe(Effect.exit)
        if (staleSettlement._tag === "Failure") {
          interrupted ||= Cause.hasInterrupts(staleSettlement.cause)
          const persisted = yield* settledVerdict(db, id)
          if (persisted !== undefined) {
            if (!Cause.hasInterrupts(staleSettlement.cause))
              yield* Effect.logWarning("Stale verification settlement committed with a notification failure", {
                sessionID: input.sessionID,
              })
            if (interrupted) return yield* Effect.interrupt
            return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict: persisted }
          }
          if (!interrupted) return yield* Effect.failCause(staleSettlement.cause)
          yield* Effect.logError("Failed to settle interrupted verifier as stale", {
            sessionID: input.sessionID,
          })
        }
        if (interrupted) return yield* Effect.interrupt
        return {
          id,
          locationKey: key,
          mutationEpoch: state.mutationEpoch,
          verdict: "stale" as const,
        }
      }

      if (recaptured === undefined)
        evidence = errorEvidence(input.selection, durationMs, "Unable to confirm verifier subject freshness")

      const settleEvidence = () =>
        Effect.gen(function* () {
          const data = {
            sessionID: input.sessionID,
            timestamp: yield* nowAtOrAfter(startedAt),
            settlement: {
              id,
              verdict: evidence.verdict,
              verifier: input.selection.verifier,
              checks: [evidence.check],
              reason: evidence.reason,
              startedAt,
            },
          }
          const commitShadow = () =>
            Effect.gen(function* () {
              const committed = yield* current(db, key)
              if (!matches(committed, state.mutationEpoch, input.snapshot))
                return yield* Effect.die("Verification subject advanced before settlement commit")
              yield* SessionVerificationRecovery.commitAttemptSettlement(db, attemptLease)
            })
          if (!input.settlementAdmission)
            return yield* settlements.settle(data, {
              commit: commitShadow,
            })

          const containmentProfile =
            input.selection.plan.containment.profile
          if (containmentProfile !== "linux-oci-v1")
            return yield* Effect.die(
              new VerifierSettlementAdmission.Error({
                reason: "binding",
                message:
                  "External attestation admission requires linux-oci-v1 containment",
              }),
            )
          return yield* input.settlementAdmission.settleEvidence(
            {
              data,
              attempt: attemptLease,
              selection: input.selection,
            },
            {
              commit: (durable) =>
                Effect.gen(function* () {
                  const subject = durable.request.subject
                  const snapshot = subject.snapshot
                  const committed = yield* current(
                    db,
                    durable.request.locationKey,
                  )
                  if (
                    snapshot === undefined ||
                    committed === undefined ||
                    committed.mutationEpoch !== subject.mutationEpoch ||
                    committed.snapshot !== snapshot
                  )
                    return yield* Effect.die(
                      "Verification subject advanced before attested settlement commit",
                    )
                  yield* SessionVerificationRecovery.commitAttemptSettlement(
                    db,
                    durable.attempt,
                  )
                }),
            },
          ).pipe(Effect.orDie)
        })

      const settled = yield* settleEvidence().pipe(Effect.exit)
      if (settled._tag === "Failure") {
        interrupted ||= Cause.hasInterrupts(settled.cause)
        const persisted = yield* settledVerdict(db, id)
        if (persisted !== undefined) {
          if (!Cause.hasInterrupts(settled.cause))
            yield* Effect.logWarning("Verification settlement committed with a notification failure", {
              sessionID: input.sessionID,
            })
          if (interrupted) return yield* Effect.interrupt
          return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict: persisted }
        }
        const afterFailure = yield* current(db, key)
        if (!matches(afterFailure, state.mutationEpoch, input.snapshot)) {
          const staleSettlement = yield* settleStale("Verification subject advanced during evidence settlement").pipe(
            Effect.exit,
          )
          if (staleSettlement._tag === "Failure") {
            interrupted ||= Cause.hasInterrupts(staleSettlement.cause)
            const persisted = yield* settledVerdict(db, id)
            if (persisted !== undefined) {
              if (!Cause.hasInterrupts(staleSettlement.cause))
                yield* Effect.logWarning("Stale verification settlement committed with a notification failure", {
                  sessionID: input.sessionID,
                })
              if (interrupted) return yield* Effect.interrupt
              return { id, locationKey: key, mutationEpoch: state.mutationEpoch, verdict: persisted }
            }
            if (!interrupted) return yield* Effect.failCause(staleSettlement.cause)
            yield* Effect.logError("Failed to settle interrupted verifier after an evidence race", {
              sessionID: input.sessionID,
            })
          }
          if (interrupted) return yield* Effect.interrupt
          return {
            id,
            locationKey: key,
            mutationEpoch: state.mutationEpoch,
            verdict: "stale" as const,
          }
        }
        if (interrupted) {
          yield* Effect.logError("Failed to persist interrupted verifier settlement", {
            sessionID: input.sessionID,
          })
          return yield* Effect.interrupt
        }
        return yield* Effect.failCause(settled.cause)
      }

      if (interrupted) return yield* Effect.interrupt
      return {
        id,
        locationKey: key,
        mutationEpoch: state.mutationEpoch,
        verdict: evidence.verdict,
      }
    }),
  )
})

/**
 * Records one shadow verification observation. A selected verifier is executed
 * only through the injected atomic containment boundary; no selection keeps
 * the existing verifier-missing behavior.
 */
export const record = Effect.fn("SessionVerification.record")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: RecordInput,
) {
  if (!input.selection) return yield* recordMissing(db, events, input)
  const canonical = yield* Effect.sync(() =>
    VerifierRegistry.pin(
      input.selection?.plan,
      {
        projectID: input.location.project.id,
        projectRoot:
          input.selection?.projectRootIdentity?.canonicalPath ??
          selectionRoot(input.location),
        ...(input.selection?.projectRootIdentity
          ? {
              projectRootIdentity:
                input.selection.projectRootIdentity,
            }
          : {}),
      },
      input.selection?.verifier.provenance,
    ),
  ).pipe(Effect.exit)
  if (canonical._tag === "Failure" || !isDeepStrictEqual(canonical.value, input.selection))
    return yield* recordMissing(db, events, {
      ...input,
      reason: "Trusted verifier selection was invalid for this location",
    })
  return yield* recordSelectedUnsafe(db, events, {
    ...input,
    selection: canonical.value,
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("Failed to record contained shadow verification receipt", {
          cause,
          sessionID: input.sessionID,
          verifier: input.selection?.verifier,
        }).pipe(Effect.as(undefined)),
    ),
  )
})
