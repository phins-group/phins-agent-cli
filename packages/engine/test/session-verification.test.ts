import { describe, expect, test } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "node:path"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventSequenceTable, EventTable } from "../src/storage/tables/events"
import { Location } from "../src/workspace/location"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionProjector } from "../src/sessions/projector"
import {
  SessionTable,
  VerificationLocationStateTable,
  VerificationReceiptTable,
  VerificationRequestOutboxTable,
} from "../src/storage/tables/sessions"
import { SessionVerification } from "../src/sessions/verification/service"
import { SessionVerificationRecovery } from "../src/sessions/verification/recovery"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { VerifierContainment } from "../src/verification/containment"
import { VerifierEnforcement } from "../src/verification/enforcement"
import { VerifierExecutionAttestation } from "../src/verification/execution-attestation"
import { VerifierRegistry } from "../src/verification/registry"
import { VerifierSettlementAdmission } from "../src/verification/settlement-admission"
import { VerificationSettlementPublisher } from "../src/runtime/events/verification-publisher"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const settlementPublisherLayer = VerificationSettlementPublisher.layer.pipe(Layer.provide(EventBus.defaultLayer))
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    EventBus.defaultLayer,
    SessionProjector.defaultLayer,
    settlementPublisherLayer,
    VerifierContainment.unavailableLayer,
  ),
)
const sessionID = SessionManager.ID.make("ses_verification_shadow")
const requestedEventType = EventBus.versionedType(
  SessionEvent.VerificationRequested.type,
  SessionEvent.VerificationRequested.durable!.version,
)
const settledEventType = EventBus.versionedType(
  SessionEvent.VerificationSettled.type,
  SessionEvent.VerificationSettled.durable!.version,
)
const location = Location.Info.make({
  directory: AbsolutePath.make("/project/worktree"),
  project: {
    id: ProjectRegistry.ID.global,
    directory: AbsolutePath.make("/project"),
  },
})
const selectedVerifier = (
  maxOutputBytes = 16_384,
  selectedProjectID = ProjectRegistry.ID.global,
  argv: readonly string[] = ["pnpm", "--filter", "@phins/core", "test"],
  timeoutMs = 120_000,
  selectedProjectRoot = SessionVerification.selectionRoot(location),
) =>
  VerifierRegistry.pin(
    {
      id: "core-tests",
      version: "1",
      source: "policy",
      check: {
        id: "unit",
        argv,
        cwd: ".",
        timeoutMs,
        maxOutputBytes,
      },
      executor: {
        id: "sandbox-test-double",
        version: "1",
        bundleDigest: `sha256:${"a".repeat(64)}`,
      },
      containment: {
        subject: "snapshot-copy",
        filesystem: "read-only",
        network: "network-deny",
        environment: "sanitized-env",
      },
    },
    {
      projectID: selectedProjectID,
      projectRoot: selectedProjectRoot,
    },
  )

const containedResult = (
  selection: VerifierRegistry.Selection,
  subject: VerifierContainment.Subject,
  status: VerifierContainment.Status = "passed",
): VerifierContainment.Result => ({
  executor: selection.plan.executor,
  subject,
  status,
  ...(status === "passed" ? { exitCode: 0 } : status === "failed" ? { exitCode: 1 } : {}),
  durationMs: 12,
  stdout: status === "passed" ? "ok" : "",
  stderr: status === "failed" ? "failed" : "",
  summary: `verifier ${status}`,
  outputTruncated: false,
})

const attestationDigest = (character: string) =>
  `sha256:${character.repeat(64)}`
const externalEnvelope: VerificationReceipt.ExecutionAttestation = {
  schema: "phins.verifier-execution-attestation-envelope.v1",
  payload: "AA",
  signature: "AA",
}
const verifiedAttestation: VerifierExecutionAttestation.Verified = {
  schema: "phins.verifier-execution-attestation.v1",
  authorityID: "phins-session-attestation-root",
  keyID: attestationDigest("b"),
  ledgerRevision: 4,
  ledgerDigest: attestationDigest("c"),
  auditHeadDigest: attestationDigest("d"),
  attestationDigest: attestationDigest("e"),
  issuedAtMs: 1,
  principals: {
    schema: "phins.verifier-principal-separation-evidence.v1",
    agentPrincipal: "uid:1001",
    verifierPrincipal: "uid:2001",
    supervisorPrincipal: "uid:2002",
    isolation: "separate-os-principals",
    snapshotControl: "verifier-supervisor",
    settlementControl: "verifier-supervisor",
    observedAtMs: 1,
  },
}

const attestedProviders = (input: {
  readonly attest: VerifierEnforcement.ExternalAttestationProvider["attest"]
  readonly verify: VerifierEnforcement.ExternalAttestationProvider["verify"]
}): VerifierEnforcement.Providers => ({
  attestation: {
    descriptor: {
      schema: "phins.verifier-external-attestation-capability.v1",
      settlementSchema: "phins.verifier-execution-attestation.v1",
      envelopeSchema:
        "phins.verifier-execution-attestation-envelope.v1",
      authorityID: verifiedAttestation.authorityID,
      keyID: verifiedAttestation.keyID,
      ledgerRevision: verifiedAttestation.ledgerRevision,
      ledgerDigest: verifiedAttestation.ledgerDigest,
      auditHeadDigest: verifiedAttestation.auditHeadDigest,
      verifierPrincipal:
        verifiedAttestation.principals.verifierPrincipal,
      supervisorPrincipal:
        verifiedAttestation.principals.supervisorPrincipal,
      transport: "external-supervisor",
    },
    probe: () => Effect.void,
    attest: input.attest,
    verify: input.verify,
  },
  privilegeSeparation: {
    descriptor: {
      schema: "phins.verifier-privilege-separation-capability.v1",
      agentPrincipal: verifiedAttestation.principals.agentPrincipal,
      verifierPrincipal:
        verifiedAttestation.principals.verifierPrincipal,
      supervisorPrincipal:
        verifiedAttestation.principals.supervisorPrincipal,
      isolation: "separate-os-principals",
      snapshotControl: "verifier-supervisor",
      settlementControl: "verifier-supervisor",
    },
    probe: () => Effect.void,
  },
})

const selectedAttestedVerifier = () => {
  const selected = selectedVerifier()
  return VerifierRegistry.pin(
    {
      ...selected.plan,
      containment: {
        ...selected.plan.containment,
        profile: "linux-oci-v1",
      },
    },
    {
      projectID: selected.projectID,
      projectRoot: selected.projectRoot,
      projectRootIdentity: {
        schema: "phins.verifier-project-root-identity.v1",
        canonicalPath: selected.projectRoot,
        device: "7",
        inode: "11",
      },
    },
    {
      kind: "signed-policy",
      authorityID: "phins-session-policy-root",
      keyID: attestationDigest("f"),
      revision: 1,
      policyDigest: attestationDigest("9"),
    },
  )
}

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectRegistry.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      slug: "verification",
      directory: "/project",
      title: "verification",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return db
})

const seedRecoveryAuthority = (db: Database.Interface["db"], ownerID?: string) =>
  db
    .insert(EventSequenceTable)
    .values({ aggregate_id: sessionID, seq: 0, owner_id: ownerID ?? null })
    .run()
    .pipe(Effect.orDie)

const localRecoveryAuthority = {
  ownerID: undefined,
  ownerGeneration: 0,
} as const

const afterRecoveryAge = (requestedAt: DateTime.Utc) =>
  DateTime.toEpochMillis(requestedAt) + SessionVerification.RECOVERY_MIN_AGE_MS + 1

const publishLeasedRequest = (
  db: Database.Interface["db"],
  events: EventBus.Interface,
  selection: VerifierRegistry.Selection,
  snapshot: Snapshot.ID,
) =>
  Effect.gen(function* () {
    const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
      sessionID,
      locationKey: SessionVerification.locationKey(location),
      snapshot,
      verifier: selection.verifier,
    })
    const claim = yield* SessionVerificationRecovery.prepareAttemptClaim(db, {
      receiptID: prepared.id,
      sessionID,
      timeoutMs: selection.plan.check.timeoutMs,
    })
    yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID, { attempt: claim })
    return {
      prepared,
      claim,
      lease: SessionVerificationRecovery.initialAttemptLease(claim),
    }
  })

const handoffDuringLiveAttempt = (
  initialOwnerID?: string,
  returnToInitialOwner = false,
) =>
  Effect.gen(function* () {
    const db = yield* setup
    const events = yield* EventBus.Service
    const selection = selectedVerifier()
    const snapshot = Snapshot.ID.make(
      initialOwnerID
        ? "tree_workspace_owner_handoff"
        : "tree_local_owner_handoff",
    )
    if (initialOwnerID) yield* seedRecoveryAuthority(db, initialOwnerID)

    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const containment = VerifierContainment.make((input) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(containedResult(selection, input.subject)),
      ),
    )
    const fiber = yield* SessionVerification.record(db, events, {
      sessionID,
      location,
      snapshot,
      selection,
      containment,
      captureSnapshot: () => Effect.succeed(snapshot),
    }).pipe(Effect.forkChild)

    yield* Deferred.await(started)
    const active = yield* db
      .select({
        token: VerificationReceiptTable.attempt_token,
        generation: VerificationReceiptTable.attempt_generation,
      })
      .from(VerificationReceiptTable)
      .get()
      .pipe(Effect.orDie)
    expect(active).toMatchObject({ generation: 1 })
    expect(active?.token).toBeString()

    yield* events.claim(sessionID, "owner-b")
    if (returnToInitialOwner && initialOwnerID)
      yield* events.claim(sessionID, initialOwnerID)
    yield* Deferred.succeed(release, undefined)

    expect(yield* Fiber.join(fiber)).toBeUndefined()
    expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
      verdict: null,
      attempt_generation: 1,
      attempt_token: active?.token,
    })
    expect(
      yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, settledEventType))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(0)
  })

describe("SessionVerification", () => {
  test("bounds verifier attempt leases by the pinned timeout policy", () => {
    expect(SessionVerificationRecovery.attemptLeaseDurationMs(1)).toBe(
      SessionVerificationRecovery.ATTEMPT_LEASE_GRACE_MS + 1,
    )
    expect(SessionVerificationRecovery.attemptLeaseDurationMs(VerifierRegistry.MAX_TIMEOUT_MS)).toBe(
      SessionVerificationRecovery.ATTEMPT_LEASE_MAX_MS,
    )
    expect(() => SessionVerificationRecovery.attemptLeaseDurationMs(0)).toThrow()
    expect(() => SessionVerificationRecovery.attemptLeaseDurationMs(VerifierRegistry.MAX_TIMEOUT_MS + 1)).toThrow()
    expect(() => SessionVerificationRecovery.attemptLeaseDurationMs(Number.NaN)).toThrow()
  })

  test("derives stable opaque Location keys", () => {
    const key = SessionVerification.locationKey(location)
    expect(key).toBe(SessionVerification.locationKey(location))
    expect(key).toMatch(/^loc_[0-9a-f]{64}$/)
    expect(key).not.toContain("/project")
    expect(
      SessionVerification.locationKey(
        Location.Info.make({
          directory: AbsolutePath.make("/project/other"),
          project: {
            id: ProjectRegistry.ID.global,
            directory: AbsolutePath.make("/project"),
          },
        }),
      ),
    ).not.toBe(key)
  })

  test("uses repository roots for VCS projects and distinct location roots outside VCS", () => {
    expect(SessionVerification.selectionRoot(location)).toBe(location.directory)
    const otherNonVcs = Location.Info.make({
      directory: AbsolutePath.make("/project/other"),
      project: {
        id: ProjectRegistry.ID.global,
        directory: AbsolutePath.make("/"),
      },
    })
    expect(SessionVerification.selectionRoot(otherNonVcs)).toBe(otherNonVcs.directory)
    expect(SessionVerification.selectionRoot(otherNonVcs)).not.toBe(SessionVerification.selectionRoot(location))

    const repository: Location.Interface = {
      directory: AbsolutePath.make("/repo/packages/engine"),
      project: {
        id: ProjectRegistry.ID.make("repository_project"),
        directory: AbsolutePath.make("/repo"),
      },
      vcs: {
        type: "git",
        store: AbsolutePath.make("/repo/.git"),
      },
    }
    expect(SessionVerification.selectionRoot(repository)).toBe(repository.project.directory)

    const unbornRepository: Location.Interface = {
      ...repository,
      project: {
        ...repository.project,
        id: ProjectRegistry.ID.global,
      },
    }
    expect(SessionVerification.selectionRoot(unbornRepository)).toBe(unbornRepository.project.directory)
  })

  it.effect("atomically allocates distinct epochs for concurrent receipts", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const attempts = 8
      yield* Effect.all(
        Array.from({ length: attempts }, (_, index) =>
          SessionVerification.recordMissing(db, events, {
            sessionID,
            location,
            snapshot: Snapshot.ID.make(`tree_${index}`),
          }),
        ),
        { concurrency: "unbounded" },
      )

      const receipts = yield* db
        .select()
        .from(VerificationReceiptTable)
        .orderBy(asc(VerificationReceiptTable.mutation_epoch))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(attempts)
      expect(receipts.map((receipt) => receipt.mutation_epoch)).toEqual(
        Array.from({ length: attempts }, (_, index) => index + 1),
      )
      expect(receipts.every((receipt) => receipt.verdict === "missing" || receipt.verdict === "stale")).toBe(true)

      const requested = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, requestedEventType))
        .all()
        .pipe(Effect.orDie)
      const settled = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, settledEventType))
        .all()
        .pipe(Effect.orDie)
      expect(requested).toHaveLength(attempts)
      expect(settled).toHaveLength(attempts)
    }),
  )

  it.effect("atomically grants one verifier retry generation to concurrent claimers", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 1_000)
      const { prepared, lease } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_claim_race"),
      )
      yield* TestClock.setTime(lease.expiresAtMs + 1)

      const claims = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          SessionVerificationRecovery.claimAttempt(db, {
            receiptID: prepared.id,
            sessionID,
            timeoutMs: selection.plan.check.timeoutMs,
          }),
        ),
        { concurrency: "unbounded" },
      )
      const winners = claims.filter((claim) => claim !== undefined)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(winners).toHaveLength(1)
      expect(winners[0]).toMatchObject({
        generation: 2,
        receiptID: prepared.id,
        sessionID,
        ownerID: undefined,
        ownerGeneration: 0,
        timeoutMs: selection.plan.check.timeoutMs,
      })
      expect(receipt).toMatchObject({
        attempt_generation: 2,
        attempt_timeout_ms: selection.plan.check.timeoutMs,
        attempt_token: winners[0]?.token,
        attempt_lease_expires: winners[0]?.expiresAtMs,
        verdict: null,
      })
    }),
  )

  it.effect("rejects a retry timeout that differs from the durable request profile", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 1_000)
      const { prepared, lease } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_timeout_mismatch"),
      )
      yield* TestClock.setTime(lease.expiresAtMs + 1)

      const mismatched = yield* SessionVerificationRecovery.claimAttempt(db, {
        receiptID: prepared.id,
        sessionID,
        timeoutMs: selection.plan.check.timeoutMs - 1,
      }).pipe(Effect.exit)

      expect(Exit.isFailure(mismatched)).toBe(true)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        attempt_generation: 1,
        attempt_timeout_ms: selection.plan.check.timeoutMs,
        attempt_token: lease.token,
        attempt_lease_expires: lease.expiresAtMs,
      })
    }),
  )

  it.effect("rolls back an initial attempt claim when ownership changes before request commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_attempt_owner_admission_race")
      let executions = 0
      yield* seedRecoveryAuthority(db, "owner-a")
      const changing = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) => {
          if (definition.type !== "session.next.verification.requested")
            return events.publish(definition, data, options)
          return events
            .claim(sessionID, "owner-b")
            .pipe(Effect.andThen(events.publish(definition, data, options)))
        }) as EventBus.Interface["publish"],
      })

      const recorded = yield* SessionVerification.record(db, changing, {
        sessionID,
        location,
        snapshot,
        selection,
        containment: VerifierContainment.make((input) =>
          Effect.sync(() => {
            executions++
            return containedResult(selection, input.subject)
          }),
        ),
        captureSnapshot: () => Effect.succeed(snapshot),
      })

      expect(recorded).toBeUndefined()
      expect(executions).toBe(0)
      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, requestedEventType))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(yield* db.select().from(VerificationRequestOutboxTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.live("uses one SQLite CAS winner across independent database connections", () =>
    Effect.gen(function* () {
      const temporary = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const filename = path.join(temporary.path, "verification-attempt.sqlite")
      const firstContext = yield* Layer.build(Database.layerFromPath(filename))
      const secondContext = yield* Layer.build(Database.layerFromPath(filename))
      const first = Context.get(firstContext, Database.Service).db
      const second = Context.get(secondContext, Database.Service).db
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 1_000)

      yield* first
        .insert(ProjectTable)
        .values({
          id: ProjectRegistry.ID.global,
          worktree: AbsolutePath.make("/project"),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* first
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectRegistry.ID.global,
          slug: "verification",
          directory: "/project",
          title: "verification",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(first, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_attempt_two_connections"),
        verifier: selection.verifier,
      })
      yield* first
        .insert(VerificationReceiptTable)
        .values({
          id: prepared.id,
          session_id: sessionID,
          location_key: prepared.request.locationKey,
          mode: prepared.request.mode,
          mutation_epoch: prepared.mutationEpoch,
          subject_snapshot: prepared.request.subject.snapshot,
          verifier: selection.verifier,
          attempt_timeout_ms: selection.plan.check.timeoutMs,
          checks: [],
          time_requested: DateTime.toEpochMillis(prepared.requestedAt),
        })
        .run()
        .pipe(Effect.orDie)
      yield* first
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0, owner_id: null })
        .run()
        .pipe(Effect.orDie)
      yield* first
        .delete(VerificationRequestOutboxTable)
        .where(eq(VerificationRequestOutboxTable.receipt_id, prepared.id))
        .run()
        .pipe(Effect.orDie)

      const claims = yield* Effect.all(
        [first, second].map((db) =>
          SessionVerificationRecovery.claimAttempt(db, {
            receiptID: prepared.id,
            sessionID,
            timeoutMs: selection.plan.check.timeoutMs,
          }),
        ),
        { concurrency: "unbounded" },
      )

      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect(yield* second.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        attempt_generation: 1,
        verdict: null,
      })
    }),
  )

  it.effect("does not recover a receipt while its verifier attempt lease is active", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 1_000)
      const { prepared, lease } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_active"),
      )
      yield* db
        .update(VerificationLocationStateTable)
        .set({ mutation_epoch: prepared.mutationEpoch + 1, snapshot: "tree_attempt_advanced" })
        .where(eq(VerificationLocationStateTable.location_key, prepared.request.locationKey))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        // Receipt age is test-injected, but lease authority always uses the live clock.
        nowMs: afterRecoveryAge(prepared.requestedAt),
      })
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(recovered).toMatchObject({ receiptsScanned: 0, receiptsSettled: 0, failures: 0 })
      expect(receipt).toMatchObject({
        verdict: null,
        attempt_generation: lease.generation,
        attempt_token: lease.token,
        attempt_lease_expires: lease.expiresAtMs,
      })
    }),
  )

  it.effect("filters active leases before applying the bounded recovery limit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 1_000)
      const active = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_recovery_active_starvation"),
      )
      yield* TestClock.adjust("1 millis")
      const malformed = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_recovery_malformed_starvation"),
      )
      yield* db
        .update(VerificationReceiptTable)
        .set({ attempt_token: "", attempt_lease_expires: 0 })
        .where(eq(VerificationReceiptTable.id, malformed.prepared.id))
        .run()
        .pipe(Effect.orDie)
      yield* TestClock.adjust("1 millis")
      const actionable = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_recovery_actionable_after_active"),
        verifier: selection.verifier,
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(
        db,
        events,
        actionable,
        sessionID,
      )

      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(actionable.requestedAt),
        limit: 1,
      })
      const receipts = yield* db
        .select()
        .from(VerificationReceiptTable)
        .orderBy(asc(VerificationReceiptTable.time_requested))
        .all()
        .pipe(Effect.orDie)

      expect(recovered).toMatchObject({
        receiptsScanned: 1,
        receiptsSettled: 1,
        failures: 0,
      })
      expect(receipts.find((row) => row.id === active.prepared.id)).toMatchObject({
        verdict: null,
        attempt_token: active.lease.token,
      })
      expect(receipts.find((row) => row.id === malformed.prepared.id)).toMatchObject({
        verdict: null,
        attempt_token: "",
      })
      expect(receipts.find((row) => row.id === actionable.id)).toMatchObject({
        verdict: "abandoned",
      })
    }),
  )

  it.effect("recovers a verifier abandoned by a hard crash after its bounded lease expires", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 250)
      const { prepared, claim } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_crash"),
      )
      expect(claim.expiresAtMs - claim.claimedAtMs).toBe(
        selection.plan.check.timeoutMs + SessionVerificationRecovery.ATTEMPT_LEASE_GRACE_MS,
      )

      yield* TestClock.setTime(claim.expiresAtMs + 1)
      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: claim.expiresAtMs + 1,
      })
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(DateTime.toEpochMillis(prepared.requestedAt) + SessionVerification.RECOVERY_MIN_AGE_MS).toBeGreaterThan(
        claim.expiresAtMs,
      )
      expect(recovered).toMatchObject({ receiptsScanned: 1, receiptsSettled: 1, failures: 0 })
      expect(receipt).toMatchObject({
        verdict: "abandoned",
        attempt_generation: 1,
        attempt_token: null,
        attempt_lease_expires: null,
      })
    }),
  )

  it.effect("rolls back evidence from a verifier that settles after losing its fence", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 100)
      const { prepared, lease } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_late"),
      )
      yield* TestClock.setTime(lease.expiresAtMs + 1)

      const late = yield* settlements
        .settle(
          {
            sessionID,
            timestamp: DateTime.makeUnsafe(lease.expiresAtMs + 1),
            settlement: {
              id: prepared.id,
              verdict: "passed",
              verifier: selection.verifier,
              checks: [
                {
                  id: selection.plan.check.id,
                  command: ["<trusted-verifier>", selection.plan.check.id],
                  status: "passed",
                  exitCode: 0,
                  durationMs: selection.plan.check.timeoutMs,
                  summary: "Late verifier result",
                },
              ],
              startedAt: prepared.requestedAt,
            },
          },
          { commit: () => SessionVerificationRecovery.commitAttemptSettlement(db, lease) },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(late)).toBe(true)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: null,
        attempt_token: lease.token,
      })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.type, settledEventType)).all().pipe(Effect.orDie),
      ).toHaveLength(0)

      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: lease.expiresAtMs + 1,
      })
      expect(recovered).toMatchObject({ receiptsSettled: 1, failures: 0 })
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBe("abandoned")
    }),
  )

  it.effect(
    "rolls back a local verifier settlement after workspace ownership handoff",
    () => handoffDuringLiveAttempt(),
  )

  it.effect(
    "rolls back an owned verifier settlement after owner identity changes",
    () => handoffDuringLiveAttempt("owner-a"),
  )

  it.effect(
    "rolls back settlement after an owner A to B to A ABA handoff",
    () => handoffDuringLiveAttempt("owner-a", true),
  )

  it.effect("settles evidence while the bound workspace owner is unchanged", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_workspace_owner_unchanged")
      yield* seedRecoveryAuthority(db, "owner-a")

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment: VerifierContainment.make((input) =>
          Effect.succeed(containedResult(selection, input.subject)),
        ),
        captureSnapshot: () => Effect.succeed(snapshot),
      })

      expect(recorded?.verdict).toBe("passed")
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "passed",
        attempt_generation: 1,
        attempt_token: null,
      })
      expect(
        yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, settledEventType))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rolls back recovery when another process claims the expired generation", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 100)
      const { lease } = yield* publishLeasedRequest(
        db,
        events,
        selection,
        Snapshot.ID.make("tree_attempt_recovery_race"),
      )
      yield* TestClock.setTime(lease.expiresAtMs + 1)
      let replacement: SessionVerificationRecovery.AttemptLease | undefined
      const racingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) =>
          SessionVerificationRecovery.claimAttempt(db, {
            receiptID: data.settlement.id,
            sessionID: data.sessionID,
            timeoutMs: selection.plan.check.timeoutMs,
          }).pipe(
            Effect.tap((claimed) =>
              Effect.sync(() => {
                replacement = claimed
              }),
            ),
            Effect.andThen(settlements.settle(data, options)),
          ),
      })

      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: lease.expiresAtMs + 1,
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, racingSettlements))
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(replacement).toMatchObject({ generation: 2 })
      expect(recovered).toMatchObject({ receiptsScanned: 1, receiptsSettled: 0, failures: 1 })
      expect(receipt).toMatchObject({
        verdict: null,
        attempt_generation: 2,
        attempt_token: replacement?.token,
        attempt_lease_expires: replacement?.expiresAtMs,
      })
    }),
  )

  it.effect("recovers an orphan selected request as abandoned without re-executing its verifier", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_orphan_selected")
      let executions = 0
      yield* seedRecoveryAuthority(db)
      const failing = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) =>
          definition.type === "session.next.verification.requested"
            ? Effect.die("simulated crash before request commit")
            : events.publish(definition, data, options)) as EventBus.Interface["publish"],
      })

      const recorded = yield* SessionVerification.record(db, failing, {
        sessionID,
        location,
        snapshot,
        selection,
        containment: VerifierContainment.make((input) =>
          Effect.sync(() => {
            executions++
            return containedResult(selection, input.subject)
          }),
        ),
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const intent = yield* db.select().from(VerificationRequestOutboxTable).get().pipe(Effect.orDie)

      expect(recorded).toBeUndefined()
      expect(executions).toBe(0)
      expect(intent).toMatchObject({
        session_id: sessionID,
        verifier: selection.verifier,
        mutation_epoch: 1,
      })
      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)

      const result = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: (intent?.time_requested ?? 0) + SessionVerification.RECOVERY_MIN_AGE_MS + 1,
      })
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)
      const stored = yield* db.select().from(EventTable).all().pipe(Effect.orDie)

      expect(result).toMatchObject({
        authorized: true,
        requestIntentsScanned: 1,
        requestsRecovered: 1,
        receiptsScanned: 1,
        receiptsSettled: 1,
        failures: 0,
      })
      expect(executions).toBe(0)
      expect(receipt).toMatchObject({
        verdict: "abandoned",
        verifier: selection.verifier,
        checks: [],
        time_started: null,
      })
      expect(yield* db.select().from(VerificationRequestOutboxTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(stored.filter((event) => event.type === requestedEventType)).toHaveLength(1)
      expect(stored.filter((event) => event.type === settledEventType)).toHaveLength(1)
    }),
  )

  it.effect("keeps a current young receipt pending and recovers it as missing after expiry", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_pending_missing"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)

      const young = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: DateTime.toEpochMillis(prepared.requestedAt),
      })
      expect(young).toMatchObject({ receiptsScanned: 1, receiptsSettled: 0, failures: 0 })
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBeNull()

      const expired = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      })
      expect(expired).toMatchObject({ receiptsScanned: 1, receiptsSettled: 1, failures: 0 })
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "missing",
        verifier: null,
        checks: [],
      })
    }),
  )

  it.effect("recovers an advanced young receipt as stale immediately", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const key = SessionVerification.locationKey(location)
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: key,
        snapshot: Snapshot.ID.make("tree_pending_advanced"),
        verifier: selection.verifier,
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      yield* db
        .update(VerificationLocationStateTable)
        .set({ mutation_epoch: prepared.mutationEpoch + 1, snapshot: "tree_newer" })
        .where(eq(VerificationLocationStateTable.location_key, key))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: DateTime.toEpochMillis(prepared.requestedAt),
      })

      expect(recovered).toMatchObject({ receiptsScanned: 1, receiptsSettled: 1, failures: 0 })
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "stale",
        verifier: selection.verifier,
        checks: [],
      })
    }),
  )

  it.effect("concurrent and repeated recovery converges to one terminal event", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_concurrent_recovery"),
        verifier: selection.verifier,
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      const recover = SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      })

      yield* Effect.all([recover, recover], { concurrency: "unbounded" })
      const repeated = yield* recover
      const stored = yield* db.select().from(EventTable).all().pipe(Effect.orDie)

      expect(repeated).toMatchObject({ receiptsScanned: 0, receiptsSettled: 0, failures: 0 })
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "abandoned",
        checks: [],
      })
      expect(stored.filter((event) => event.type === settledEventType)).toHaveLength(1)
    }),
  )

  it.effect("fences missing, mismatched, stale-generation, and ABA recovery ownership", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_owned_recovery"),
        verifier: selection.verifier,
      })
      const oldEnough = afterRecoveryAge(prepared.requestedAt)

      const missingSequence = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: oldEnough,
      })
      expect(missingSequence.authorized).toBe(false)
      yield* seedRecoveryAuthority(db, "remote-owner")
      const mismatched = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: oldEnough,
      })
      expect(mismatched.authorized).toBe(false)

      yield* events.claim(sessionID, "temporary-owner")
      yield* events.claim(sessionID, "remote-owner")
      const staleGeneration = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ownerID: "remote-owner",
        ownerGeneration: 0,
        nowMs: oldEnough,
      })
      expect(staleGeneration.authorized).toBe(false)

      const changing = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) => {
          if (definition.type !== "session.next.verification.requested")
            return events.publish(definition, data, options)
          return events
            .claim(sessionID, "temporary-owner")
            .pipe(
              Effect.andThen(events.claim(sessionID, "remote-owner")),
              Effect.andThen(events.publish(definition, data, options)),
            )
        }) as EventBus.Interface["publish"],
      })
      const raced = yield* SessionVerification.recoverPendingForSession(db, changing, {
        sessionID,
        ownerID: "remote-owner",
        ownerGeneration: 2,
        nowMs: oldEnough,
      })

      expect(raced).toMatchObject({ authorized: true, requestsRecovered: 0, failures: 1 })
      expect(yield* db.select().from(VerificationRequestOutboxTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(
        yield* db
          .select({
            ownerID: EventSequenceTable.owner_id,
            ownerGeneration: EventSequenceTable.owner_generation,
          })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ ownerID: "remote-owner", ownerGeneration: 4 })

      const authorized = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ownerID: "remote-owner",
        ownerGeneration: 4,
        nowMs: oldEnough,
      })
      expect(authorized).toMatchObject({
        authorized: true,
        requestsRecovered: 1,
        receiptsSettled: 1,
        failures: 0,
      })
    }),
  )

  it.effect("retries a recovery freshness race with a stale settlement", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const key = SessionVerification.locationKey(location)
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: key,
        snapshot: Snapshot.ID.make("tree_recovery_freshness"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      const racingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => {
          if (data.settlement.verdict !== "missing") return settlements.settle(data, options)
          return db
            .update(VerificationLocationStateTable)
            .set({ mutation_epoch: prepared.mutationEpoch + 1, snapshot: "tree_recovery_freshness_advanced" })
            .where(eq(VerificationLocationStateTable.location_key, key))
            .run()
            .pipe(Effect.orDie, Effect.andThen(settlements.settle(data, options)))
        },
      })

      const raced = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, racingSettlements))
      expect(raced).toMatchObject({ receiptsScanned: 1, receiptsSettled: 0, failures: 1 })
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBeNull()

      const retried = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      })
      expect(retried).toMatchObject({ receiptsSettled: 1, failures: 0 })
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBe("stale")
    }),
  )

  it.effect("preserves interruption after reconciling a recovered request commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_recovered_request_interrupt"),
      })
      const interrupting = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) =>
          events
            .publish(definition, data, options)
            .pipe(
              Effect.flatMap((published) =>
                definition.type === "session.next.verification.requested"
                  ? Effect.interrupt
                  : Effect.succeed(published),
              ),
            )) as EventBus.Interface["publish"],
      })

      const exit = yield* SessionVerification.recoverPendingForSession(db, interrupting, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* db.select().from(VerificationRequestOutboxTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: null,
        checks: [],
      })

      yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      })
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBe("missing")
    }),
  )

  it.effect("preserves interruption after reconciling a recovery settlement commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      yield* seedRecoveryAuthority(db)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: SessionVerification.locationKey(location),
        snapshot: Snapshot.ID.make("tree_recovery_interrupt"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      const interruptingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => settlements.settle(data, options).pipe(Effect.andThen(Effect.interrupt)),
      })

      const exit = yield* SessionVerification.recoverPendingForSession(db, events, {
        sessionID,
        ...localRecoveryAuthority,
        nowMs: afterRecoveryAge(prepared.requestedAt),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, interruptingSettlements), Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "missing",
        checks: [],
      })
    }),
  )

  it.effect("retries a live missing settlement as stale after an epoch race", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const key = SessionVerification.locationKey(location)
      const racingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => {
          if (data.settlement.verdict !== "missing") return settlements.settle(data, options)
          return db
            .update(VerificationLocationStateTable)
            .set({
              mutation_epoch: sql`${VerificationLocationStateTable.mutation_epoch} + 1`,
              snapshot: "tree_advanced",
            })
            .where(eq(VerificationLocationStateTable.location_key, key))
            .run()
            .pipe(Effect.orDie, Effect.andThen(settlements.settle(data, options)))
        },
      })

      const recorded = yield* SessionVerification.recordMissing(db, events, {
        sessionID,
        location,
        snapshot: Snapshot.ID.make("tree_requested"),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, racingSettlements))

      expect(recorded?.verdict).toBe("stale")
      expect((yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie))?.verdict).toBe("stale")
    }),
  )

  it.effect("absorbs persistence failure without failing the caller", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const result = yield* SessionVerification.recordMissing(db, events, {
        sessionID: SessionManager.ID.make("ses_missing"),
        location,
        snapshot: Snapshot.ID.make("tree_missing_session"),
      })

      expect(result).toBeUndefined()
      expect(yield* db.select().from(VerificationLocationStateTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(VerificationRequestOutboxTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("persists each verdict returned by the atomic containment boundary", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_contained")

      for (const verdict of ["passed", "failed", "error", "timeout"] as const) {
        let executions = 0
        const containment = VerifierContainment.make((input) =>
          Effect.sync(() => {
            executions++
            expect(input.selection).toEqual(selection)
            expect(input.subject.snapshot).toBe(snapshot)
            expect(input.subject.projectID).toBe(ProjectRegistry.ID.global)
            expect(input.subject.locationKey).toBe(SessionVerification.locationKey(location))
            return containedResult(selection, input.subject, verdict)
          }),
        )
        const recorded = yield* SessionVerification.record(db, events, {
          sessionID,
          location,
          snapshot,
          selection,
          containment,
          captureSnapshot: () => Effect.succeed(snapshot),
        })

        expect(executions).toBe(1)
        expect(recorded?.verdict).toBe(verdict)
        const receipt = yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, recorded?.id as never))
          .get()
          .pipe(Effect.orDie)
        expect(receipt).toMatchObject({
          verdict,
          verifier: selection.verifier,
          checks: [
            {
              id: "unit",
              command: ["<trusted-verifier>", "unit"],
              status: verdict,
            },
          ],
        })
        expect(receipt?.time_started).toBeNumber()
        expect(receipt?.time_completed).toBeNumber()
      }
    }),
  )

  it.effect("fails closed to an error receipt when no containment backend is installed", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const containment = yield* VerifierContainment.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_unavailable")

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(recorded?.verdict).toBe("error")
      expect(receipt).toMatchObject({
        verdict: "error",
        reason: "Verifier containment is unavailable",
        verifier: selection.verifier,
        checks: [{ status: "error", summary: "Verifier containment is unavailable" }],
      })
    }),
  )

  it.effect("rejects a verifier pinned for another project without invoking containment", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.make("another_project"))
      const snapshot = Snapshot.ID.make("tree_wrong_project")
      let executions = 0
      const containment = VerifierContainment.make((input) =>
        Effect.sync(() => {
          executions++
          return containedResult(selection, input.subject)
        }),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(executions).toBe(0)
      expect(receipt).toMatchObject({
        verdict: "missing",
        verifier: null,
        checks: [],
        reason: "Trusted verifier selection was invalid for this location",
      })
    }),
  )

  it.effect("rejects a verifier transplanted from another project root without invoking containment", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(
        16_384,
        ProjectRegistry.ID.global,
        ["pnpm", "--filter", "@phins/core", "test"],
        120_000,
        AbsolutePath.make("/another-project"),
      )
      const snapshot = Snapshot.ID.make("tree_wrong_project_root")
      let executions = 0
      const containment = VerifierContainment.make((input) =>
        Effect.sync(() => {
          executions++
          return containedResult(selection, input.subject)
        }),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(executions).toBe(0)
      expect(receipt).toMatchObject({
        verdict: "missing",
        verifier: null,
        checks: [],
        reason: "Trusted verifier selection was invalid for this location",
      })
    }),
  )

  it.effect("rejects a mismatched executor descriptor as error evidence", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_descriptor")
      const containment = VerifierContainment.make((input) =>
        Effect.succeed({
          ...containedResult(selection, input.subject),
          executor: {
            ...selection.plan.executor,
            bundleDigest: `sha256:${"b".repeat(64)}`,
          },
        }),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(receipt).toMatchObject({
        verdict: "error",
        reason: "Verifier containment executor descriptor did not match",
        checks: [{ status: "error" }],
      })
    }),
  )

  it.effect("rechecks subject binding at the receipt boundary", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_subject_binding")
      const containment: VerifierContainment.Interface = {
        execute: (input) =>
          Effect.succeed({
            ...containedResult(selection, input.subject),
            subject: {
              ...input.subject,
              snapshot: Snapshot.ID.make("tree_from_wrong_execution"),
            },
          }),
      }

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(receipt).toMatchObject({
        subject_snapshot: snapshot,
        verdict: "error",
        reason: "Verifier containment subject did not match the selection",
        checks: [{ status: "error" }],
      })
    }),
  )

  it.effect("sanitizes containment defects and rejects malformed adapter results", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_invalid_adapter")
      const cases = [
        {
          containment: VerifierContainment.make(() => {
            throw new globalThis.Error("SECRET_CONTAINMENT_DEFECT")
          }),
          reason: "Verifier containment execution failed",
        },
        {
          containment: VerifierContainment.make((input) =>
            Effect.succeed({
              ...containedResult(selection, input.subject),
              exitCode: 7,
            } as unknown as VerifierContainment.Result),
          ),
          reason: "Verifier containment returned an invalid result",
        },
      ]

      for (const item of cases) {
        const recorded = yield* SessionVerification.record(db, events, {
          sessionID,
          location,
          snapshot,
          selection,
          containment: item.containment,
          captureSnapshot: () => Effect.succeed(snapshot),
        })
        const receipt = yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, recorded?.id as never))
          .get()
          .pipe(Effect.orDie)

        expect(receipt).toMatchObject({
          verdict: "error",
          reason: item.reason,
          checks: [{ status: "error", summary: item.reason }],
        })
        expect(JSON.stringify(receipt)).not.toContain("SECRET_CONTAINMENT_DEFECT")
      }
    }),
  )

  it.effect("rejects output beyond the pinned byte cap and unavailable freshness", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(4)
      const snapshot = Snapshot.ID.make("tree_output_limit")
      const containment = VerifierContainment.make((input) =>
        Effect.succeed({
          ...containedResult(selection, input.subject),
          stdout: "12345",
        }),
      )
      const overLimit = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const overLimitReceipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, overLimit?.id as never))
        .get()
        .pipe(Effect.orDie)
      expect(overLimitReceipt).toMatchObject({
        verdict: "error",
        reason: "Verifier containment returned output beyond the pinned limit",
      })
      expect(overLimitReceipt?.checks[0]).not.toHaveProperty("stdout")

      const freshness = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment: VerifierContainment.make((input) => Effect.succeed(containedResult(selection, input.subject))),
        captureSnapshot: () => {
          throw new globalThis.Error("SECRET_SNAPSHOT_DEFECT")
        },
      })
      const freshnessReceipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, freshness?.id as never))
        .get()
        .pipe(Effect.orDie)
      expect(freshnessReceipt).toMatchObject({
        verdict: "error",
        reason: "Unable to confirm verifier subject freshness",
      })
      expect(JSON.stringify(freshnessReceipt)).not.toContain("SECRET_SNAPSHOT_DEFECT")
    }),
  )

  it.effect("withholds raw verifier output and command arguments from durable evidence", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const canary = "SECRET_VERIFIER_CANARY"
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier", canary])
      const snapshot = Snapshot.ID.make("tree_redacted")
      const containment = VerifierContainment.make((input) =>
        Effect.succeed({
          ...containedResult(selection, input.subject),
          stdout: `stdout:${canary}`,
          stderr: `stderr:${canary}`,
          summary: `summary:${canary}`,
        }),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)
      const storedEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)

      expect(JSON.stringify(receipt)).not.toContain(canary)
      expect(JSON.stringify(storedEvents)).not.toContain(canary)
      expect(receipt).toMatchObject({
        verdict: "passed",
        checks: [
          {
            command: ["<trusted-verifier>", "unit"],
            summary: "Verifier check passed",
            outputTruncated: true,
          },
        ],
      })
      expect(receipt?.checks[0]).not.toHaveProperty("stdout")
      expect(receipt?.checks[0]).not.toHaveProperty("stderr")
    }),
  )

  it.effect("enforces the pinned verifier timeout and records one cleanup", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier(16_384, ProjectRegistry.ID.global, ["verifier"], 10)
      const snapshot = Snapshot.ID.make("tree_timeout")
      let cleanups = 0
      const containment = VerifierContainment.make(() =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              cleanups++
            }),
          ),
        ),
      )
      const fiber = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      yield* TestClock.adjust("11 millis")
      const recorded = yield* Fiber.join(fiber)
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(cleanups).toBe(1)
      expect(recorded?.verdict).toBe("timeout")
      expect(receipt).toMatchObject({
        verdict: "timeout",
        reason: "Verifier containment exceeded the pinned timeout",
        checks: [{ status: "timeout" }],
      })
    }),
  )

  it.effect("clamps receipt timestamps when the wall clock moves backward", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_clock_regression")
      yield* TestClock.setTime(100)
      const containment = VerifierContainment.make((input) =>
        TestClock.setTime(50).pipe(Effect.as(containedResult(selection, input.subject))),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(receipt).toMatchObject({
        verdict: "passed",
        time_requested: 100,
        time_started: 100,
        time_completed: 100,
      })
    }),
  )

  it.effect("discards verifier evidence when the filesystem snapshot advances", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_subject")
      const containment = VerifierContainment.make((input) => Effect.succeed(containedResult(selection, input.subject)))

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(Snapshot.ID.make("tree_advanced")),
      })
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(recorded?.verdict).toBe("stale")
      expect(receipt).toMatchObject({
        verdict: "stale",
        verifier: selection.verifier,
        checks: [],
        time_started: null,
      })
    }),
  )

  it.effect("settles an interrupted verifier before propagating interruption", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_interrupted")
      const containment = VerifierContainment.make(() => Effect.interrupt)

      const exit = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.exit)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(receipt).toMatchObject({
        verdict: "error",
        reason: "Verifier containment execution was interrupted",
        checks: [{ status: "error" }],
      })
    }),
  )

  it.effect("settles a selected receipt when request notification interrupts after commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_request_notification_interrupt")
      let executions = 0
      const containment = VerifierContainment.make((input) =>
        Effect.sync(() => {
          executions++
          return containedResult(selection, input.subject)
        }),
      )
      const interrupting = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) =>
          events
            .publish(definition, data, options)
            .pipe(
              Effect.flatMap((published) =>
                definition.type === "session.next.verification.requested"
                  ? Effect.interrupt
                  : Effect.succeed(published),
              ),
            )) as EventBus.Interface["publish"],
      })

      const exit = yield* SessionVerification.record(db, interrupting, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.exit)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(executions).toBe(0)
      expect(receipt).toMatchObject({
        verdict: "error",
        reason: "Verification request notification was interrupted",
        checks: [{ status: "error" }],
      })
      expect(receipt?.time_completed).toBeNumber()
    }),
  )

  it.effect("settles a missing receipt when request notification interrupts after commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const interrupting = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) =>
          events
            .publish(definition, data, options)
            .pipe(
              Effect.flatMap((published) =>
                definition.type === "session.next.verification.requested"
                  ? Effect.interrupt
                  : Effect.succeed(published),
              ),
            )) as EventBus.Interface["publish"],
      })

      const exit = yield* SessionVerification.recordMissing(db, interrupting, {
        sessionID,
        location,
        snapshot: Snapshot.ID.make("tree_missing_request_notification_interrupt"),
      }).pipe(Effect.exit)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(receipt).toMatchObject({
        verdict: "missing",
        checks: [],
      })
      expect(receipt?.time_completed).toBeNumber()
    }),
  )

  it.effect("finishes a missing receipt before honoring an external interruption", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const requested = yield* Deferred.make<void>()
      const observing = EventBus.Service.of({
        ...events,
        publish: ((definition, data, options) =>
          events.publish(definition, data, options).pipe(
            Effect.tap(() =>
              definition.type === "session.next.verification.requested"
                ? Deferred.succeed(requested, undefined)
                : Effect.void,
            ),
            Effect.andThen(Effect.yieldNow),
          )) as EventBus.Interface["publish"],
      })
      const fiber = yield* SessionVerification.recordMissing(db, observing, {
        sessionID,
        location,
        snapshot: Snapshot.ID.make("tree_missing_interrupt"),
      }).pipe(Effect.forkChild)

      yield* Deferred.await(requested)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(receipt?.verdict === "missing" || receipt?.verdict === "stale").toBe(true)
      expect(receipt?.time_completed).toBeNumber()
    }),
  )

  it.effect("retries contained evidence as stale after a settlement epoch race", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_racing")
      const key = SessionVerification.locationKey(location)
      const containment = VerifierContainment.make((input) => Effect.succeed(containedResult(selection, input.subject)))
      const racingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => {
          if (data.settlement.verdict !== "passed") return settlements.settle(data, options)
          return db
            .update(VerificationLocationStateTable)
            .set({
              mutation_epoch: sql`${VerificationLocationStateTable.mutation_epoch} + 1`,
              snapshot: "tree_advanced",
            })
            .where(eq(VerificationLocationStateTable.location_key, key))
            .run()
            .pipe(Effect.orDie, Effect.andThen(settlements.settle(data, options)))
        },
      })

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, racingSettlements))
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.id, recorded?.id as never))
        .get()
        .pipe(Effect.orDie)

      expect(recorded?.verdict).toBe("stale")
      expect(receipt).toMatchObject({ verdict: "stale", checks: [] })
    }),
  )

  it.effect("preserves settlement interruption while retrying an epoch race as stale", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_interrupting_race")
      const key = SessionVerification.locationKey(location)
      const containment = VerifierContainment.make((input) => Effect.succeed(containedResult(selection, input.subject)))
      const interruptingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => {
          if (data.settlement.verdict !== "passed") return settlements.settle(data, options)
          return db
            .update(VerificationLocationStateTable)
            .set({
              mutation_epoch: sql`${VerificationLocationStateTable.mutation_epoch} + 1`,
              snapshot: "tree_advanced",
            })
            .where(eq(VerificationLocationStateTable.location_key, key))
            .run()
            .pipe(Effect.orDie, Effect.andThen(Effect.interrupt))
        },
      })

      const exit = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, interruptingSettlements), Effect.exit)
      const receipt = yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(receipt).toMatchObject({ verdict: "stale", checks: [] })
    }),
  )

  it.effect("does not replace a committed settlement after its notification is interrupted", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedVerifier()
      const snapshot = Snapshot.ID.make("tree_committed_settlement_interrupt")
      const key = SessionVerification.locationKey(location)
      const containment = VerifierContainment.make((input) => Effect.succeed(containedResult(selection, input.subject)))
      const interruptingSettlements = VerificationSettlementPublisher.Service.of({
        settle: (data, options) => {
          if (data.settlement.verdict !== "passed") return settlements.settle(data, options)
          return settlements.settle(data, options).pipe(
            Effect.tap(() =>
              db
                .update(VerificationLocationStateTable)
                .set({
                  mutation_epoch: sql`${VerificationLocationStateTable.mutation_epoch} + 1`,
                  snapshot: "tree_advanced",
                })
                .where(eq(VerificationLocationStateTable.location_key, key))
                .run()
                .pipe(Effect.orDie),
            ),
            Effect.andThen(Effect.interrupt),
          )
        },
      })

      const exit = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, interruptingSettlements), Effect.exit)
      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ verdict: "passed", checks: [{ status: "passed" }] })
    }),
  )

  it.effect("admits external evidence through the durable request and attempt CAS", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedAttestedVerifier()
      const snapshot = Snapshot.ID.make("tree_attested_admission")
      let requested: VerifierExecutionAttestation.Expected | undefined
      let verified: VerifierExecutionAttestation.Expected | undefined
      const admission = yield* VerifierSettlementAdmission.build(
        attestedProviders({
          attest: (expected) =>
            Effect.sync(() => {
              requested = expected
              return externalEnvelope
            }),
          verify: (expected) =>
            Effect.sync(() => {
              verified = expected
              return verifiedAttestation
            }),
        }),
        SessionVerificationRecovery.settlementAdmissionBindingLoader(db),
      ).pipe(
        Effect.provideService(
          VerificationSettlementPublisher.Service,
          settlements,
        ),
      )
      const containment = VerifierContainment.make((input) =>
        Effect.succeed(containedResult(selection, input.subject)),
      )

      const recorded = yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot,
        selection,
        containment,
        captureSnapshot: () => Effect.succeed(snapshot),
        settlementAdmission: admission,
      }).pipe(
        Effect.provideService(
          VerificationSettlementPublisher.Service,
          settlements,
        ),
      )
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .get()
        .pipe(Effect.orDie)

      expect(recorded).toMatchObject({ verdict: "passed" })
      expect(requested?.request.subject).toEqual({
        mutationEpoch: 1,
        snapshot,
      })
      expect(requested?.settlement.attestation).toBeUndefined()
      expect(requested?.attemptGeneration).toBe(1)
      expect(requested?.attemptToken).toStartWith("vat_")
      expect(verified?.settlement.attestation).toEqual(externalEnvelope)
      expect(receipt).toMatchObject({
        verdict: "passed",
        attestation: externalEnvelope,
        attempt_generation: 1,
        attempt_token: null,
        attempt_lease_expires: null,
      })
    }),
  )

  it.effect("does not commit or consume the lease when external verification fails", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      const selection = selectedAttestedVerifier()
      const snapshot = Snapshot.ID.make("tree_attestation_rejected")
      const admission = yield* VerifierSettlementAdmission.build(
        attestedProviders({
          attest: () => Effect.succeed(externalEnvelope),
          verify: () =>
            Effect.fail(
              new VerifierExecutionAttestation.AttestationError(
                "signature",
                "external signature rejected",
              ),
            ),
        }),
        SessionVerificationRecovery.settlementAdmissionBindingLoader(db),
      ).pipe(
        Effect.provideService(
          VerificationSettlementPublisher.Service,
          settlements,
        ),
      )
      const containment = VerifierContainment.make((input) =>
        Effect.succeed(containedResult(selection, input.subject)),
      )

      expect(
        yield* SessionVerification.record(db, events, {
          sessionID,
          location,
          snapshot,
          selection,
          containment,
          captureSnapshot: () => Effect.succeed(snapshot),
          settlementAdmission: admission,
        }).pipe(
          Effect.provideService(
            VerificationSettlementPublisher.Service,
            settlements,
          ),
        ),
      ).toBeUndefined()
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .get()
        .pipe(Effect.orDie)
      const settled = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, settledEventType))
        .all()
        .pipe(Effect.orDie)

      expect(receipt).toMatchObject({
        verdict: null,
        attestation: null,
        attempt_generation: 1,
      })
      expect(receipt?.attempt_token).toStartWith("vat_")
      expect(receipt?.attempt_lease_expires).toBeNumber()
      expect(settled).toHaveLength(0)
    }),
  )

  it.effect("rolls back attested evidence across an A to B to A owner race", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const settlements = yield* VerificationSettlementPublisher.Service
      yield* seedRecoveryAuthority(db, "owner-a")
      const selection = selectedAttestedVerifier()
      const snapshot = Snapshot.ID.make("tree_attestation_owner_aba")
      let verifyCalls = 0
      const admission = yield* VerifierSettlementAdmission.build(
        attestedProviders({
          attest: () => Effect.succeed(externalEnvelope),
          verify: () =>
            events.claim(sessionID, "owner-b").pipe(
              Effect.andThen(events.claim(sessionID, "owner-a")),
              Effect.tap(() =>
                Effect.sync(() => {
                  verifyCalls++
                }),
              ),
              Effect.as(verifiedAttestation),
            ),
        }),
        SessionVerificationRecovery.settlementAdmissionBindingLoader(db),
      ).pipe(
        Effect.provideService(
          VerificationSettlementPublisher.Service,
          settlements,
        ),
      )
      const containment = VerifierContainment.make((input) =>
        Effect.succeed(containedResult(selection, input.subject)),
      )

      expect(
        yield* SessionVerification.record(db, events, {
          sessionID,
          location,
          snapshot,
          selection,
          containment,
          captureSnapshot: () => Effect.succeed(snapshot),
          settlementAdmission: admission,
        }).pipe(
          Effect.provideService(
            VerificationSettlementPublisher.Service,
            settlements,
          ),
        ),
      ).toBeUndefined()
      const receipt = yield* db
        .select()
        .from(VerificationReceiptTable)
        .get()
        .pipe(Effect.orDie)
      const ownership = yield* db
        .select({
          ownerID: EventSequenceTable.owner_id,
          ownerGeneration: EventSequenceTable.owner_generation,
        })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const settled = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, settledEventType))
        .all()
        .pipe(Effect.orDie)

      expect(verifyCalls).toBe(1)
      expect(ownership).toEqual({
        ownerID: "owner-a",
        ownerGeneration: 2,
      })
      expect(receipt).toMatchObject({
        verdict: null,
        attestation: null,
        attempt_generation: 1,
      })
      expect(receipt?.attempt_token).toStartWith("vat_")
      expect(settled).toHaveLength(0)
    }),
  )
})
