import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionProjector } from "../src/sessions/projector"
import { SessionTable, VerificationLocationStateTable, VerificationReceiptTable } from "../src/storage/tables/sessions"
import { VerificationSettlementPublisher } from "../src/runtime/events/verification-publisher"
import { testEffect } from "./lib/effect"

const settlementPublisherLayer = VerificationSettlementPublisher.layer.pipe(Layer.provide(EventBus.defaultLayer))
const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer, SessionProjector.defaultLayer, settlementPublisherLayer),
)
const sessionID = SessionManager.ID.make("ses_verification_projector")
const locationKey = VerificationReceipt.LocationKey.make("location_project")

const insertSession = (db: Database.Interface["db"], id: SessionManager.ID) =>
  db
    .insert(SessionTable)
    .values({
      id,
      project_id: ProjectRegistry.ID.global,
      slug: `test-${id}`,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)

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
  yield* insertSession(db, sessionID)
  return db
})

const request = (id: VerificationReceipt.ID, mutationEpoch: number, snapshot?: string) => ({
  id,
  locationKey,
  mode: "shadow" as const,
  subject: { mutationEpoch, ...(snapshot ? { snapshot } : {}) },
})

const settle = (...args: Parameters<VerificationSettlementPublisher.Interface["settle"]>) =>
  VerificationSettlementPublisher.Service.pipe(Effect.flatMap((publisher) => publisher.settle(...args)))

describe("verification receipt projection", () => {
  it.effect("persists and immutably settles a requested receipt", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_projected")
      const verifier = {
        id: "task-tests",
        version: "1",
        source: "task" as const,
        digest: `sha256:${"a".repeat(64)}`,
      }

      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: { ...request(receiptID, 4, "tree_before"), verifier },
      })

      expect(
        yield* db
          .select()
          .from(VerificationLocationStateTable)
          .where(eq(VerificationLocationStateTable.location_key, locationKey))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        mutation_epoch: 4,
        snapshot: "tree_before",
        time_updated: 10,
      })
      expect(
        yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        session_id: sessionID,
        location_key: locationKey,
        mode: "shadow",
        mutation_epoch: 4,
        subject_snapshot: "tree_before",
        verifier,
        verdict: null,
        checks: [],
        time_requested: 10,
      })

      yield* settle({
        sessionID,
        timestamp: DateTime.makeUnsafe(25),
        settlement: {
          id: receiptID,
          verdict: "passed",
          verifier,
          checks: [
            {
              id: "unit",
              command: ["pnpm", "test"],
              status: "passed",
              exitCode: 0,
              durationMs: 14,
            },
          ],
          attestation: {
            schema: "phins.verifier-execution-attestation-envelope.v1",
            payload: "ZXh0ZXJuYWwtc2lnbmVkLXBheWxvYWQ",
            signature: "ZXh0ZXJuYWwtc2lnbmF0dXJl",
          },
          startedAt: DateTime.makeUnsafe(11),
        },
      })

      expect(
        yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        verdict: "passed",
        attestation: {
          schema: "phins.verifier-execution-attestation-envelope.v1",
          payload: "ZXh0ZXJuYWwtc2lnbmVkLXBheWxvYWQ",
          signature: "ZXh0ZXJuYWwtc2lnbmF0dXJl",
        },
        time_started: 11,
        time_completed: 25,
      })

      const duplicate = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(30),
          settlement: {
            id: receiptID,
            verdict: "failed",
            verifier,
            checks: [
              {
                id: "unit",
                command: ["pnpm", "test"],
                status: "failed",
                exitCode: 1,
                durationMs: 1,
              },
            ],
            reason: "must not overwrite",
            startedAt: DateTime.makeUnsafe(26),
          },
        })
        .pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      expect(
        (yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie))?.verdict,
      ).toBe("passed")
    }),
  )

  it.effect("rejects a settlement that changes the requested verifier", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_verifier_mismatch")
      const requestedVerifier = {
        id: "task-tests",
        version: "1",
        source: "task" as const,
        digest: `sha256:${"a".repeat(64)}`,
      }
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: {
          ...request(receiptID, 1, "tree"),
          verifier: requestedVerifier,
        },
      })

      const mismatched = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(20),
          settlement: {
            id: receiptID,
            verdict: "passed",
            verifier: { ...requestedVerifier, digest: `sha256:${"b".repeat(64)}` },
            checks: [
              {
                id: "unit",
                command: ["pnpm", "test"],
                status: "passed",
                exitCode: 0,
                durationMs: 1,
              },
            ],
            startedAt: DateTime.makeUnsafe(11),
          },
        })
        .pipe(Effect.exit)

      expect(mismatched._tag).toBe("Failure")
      expect(
        yield* db
          .select({ verdict: VerificationReceiptTable.verdict })
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ verdict: null })
    }),
  )

  it.effect("requires an evidence verifier to be fixed by the request", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_verifier_not_requested")
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: request(receiptID, 1, "tree"),
      })

      const settlement = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(20),
          settlement: {
            id: receiptID,
            verdict: "passed",
            verifier: {
              id: "task-tests",
              version: "1",
              source: "task",
              digest: `sha256:${"a".repeat(64)}`,
            },
            checks: [
              {
                id: "unit",
                command: ["pnpm", "test"],
                status: "passed",
                exitCode: 0,
                durationMs: 1,
              },
            ],
            startedAt: DateTime.makeUnsafe(11),
          },
        })
        .pipe(Effect.exit)

      expect(settlement._tag).toBe("Failure")
      expect(
        yield* db
          .select({ verdict: VerificationReceiptTable.verdict })
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ verdict: null })
    }),
  )

  it.effect("preserves the pinned verifier identity on stale and abandoned receipts", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const verifier = {
        id: "task-tests",
        version: "1",
        source: "task" as const,
        digest: `sha256:${"a".repeat(64)}`,
      }
      for (const verdict of ["stale", "abandoned"] as const) {
        const receiptID = VerificationReceipt.ID.make(`vrc_${verdict}_without_evidence`)
        yield* events.publish(SessionEvent.VerificationRequested, {
          sessionID,
          timestamp: DateTime.makeUnsafe(10),
          request: {
            ...request(receiptID, 1, "tree"),
            verifier,
          },
        })
        yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(20),
          settlement: { id: receiptID, verdict, checks: [] },
        })

        expect(
          yield* db
            .select({
              verdict: VerificationReceiptTable.verdict,
              verifier: VerificationReceiptTable.verifier,
              checks: VerificationReceiptTable.checks,
            })
            .from(VerificationReceiptTable)
            .where(eq(VerificationReceiptTable.id, receiptID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ verdict, verifier, checks: [] })
      }
    }),
  )

  it.effect("does not erase a requested verifier with a missing verdict", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_missing_with_verifier")
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: {
          ...request(receiptID, 1, "tree"),
          verifier: {
            id: "task-tests",
            version: "1",
            source: "task",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
      })

      const result = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(20),
          settlement: { id: receiptID, verdict: "missing", checks: [] },
        })
        .pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(
        yield* db
          .select({ verdict: VerificationReceiptTable.verdict })
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ verdict: null })
    }),
  )

  it.effect("rejects verifier timestamps outside the request and settlement", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_invalid_time")
      const verifier = {
        id: "task-tests",
        version: "1",
        source: "task" as const,
        digest: `sha256:${"a".repeat(64)}`,
      }
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: { ...request(receiptID, 1, "tree"), verifier },
      })

      const result = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(20),
          settlement: {
            id: receiptID,
            verdict: "passed",
            verifier,
            checks: [
              {
                id: "unit",
                command: ["pnpm", "test"],
                status: "passed",
                exitCode: 0,
                durationMs: 1,
              },
            ],
            startedAt: DateTime.makeUnsafe(21),
          },
        })
        .pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(
        yield* db
          .select({ verdict: VerificationReceiptTable.verdict })
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ verdict: null })
    }),
  )

  it.effect("rejects non-evidence settlements before their request", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const receiptID = VerificationReceipt.ID.make("vrc_missing_invalid_time")
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: request(receiptID, 1, "tree"),
      })

      const result = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(9),
          settlement: { id: receiptID, verdict: "missing", checks: [] },
        })
        .pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(
        yield* db
          .select({ verdict: VerificationReceiptTable.verdict })
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, receiptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ verdict: null })
    }),
  )

  it.effect("does not regress shared location state from an older request", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: request(VerificationReceipt.ID.make("vrc_newer"), 5, "tree_newer"),
      })
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(20),
        request: request(VerificationReceipt.ID.make("vrc_older"), 3, "tree_older"),
      })

      expect(
        yield* db
          .select()
          .from(VerificationLocationStateTable)
          .where(eq(VerificationLocationStateTable.location_key, locationKey))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        mutation_epoch: 5,
        snapshot: "tree_newer",
        time_updated: 10,
      })
    }),
  )

  it.effect("converges shared location state when session aggregates replay in reverse order", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const sessions = [
        sessionID,
        SessionManager.ID.make("ses_verification_replay_b"),
        SessionManager.ID.make("ses_verification_replay_c"),
        SessionManager.ID.make("ses_verification_replay_d"),
      ] as const
      yield* Effect.forEach(sessions.slice(1), (id) => insertSession(db, id), { discard: true })

      const requestedVersion = SessionEvent.VerificationRequested.durable?.version
      if (requestedVersion === undefined) return yield* Effect.die("VerificationRequested must remain durable")
      const requestedType = EventBus.versionedType(SessionEvent.VerificationRequested.type, requestedVersion)
      const serialized = [
        {
          id: EventBus.ID.create(),
          type: requestedType,
          seq: 0,
          aggregateID: sessions[0],
          data: {
            sessionID: sessions[0],
            timestamp: 5,
            request: request(VerificationReceipt.ID.make("vrc_replay_a"), 6, "tree_old"),
          },
        },
        {
          id: EventBus.ID.create(),
          type: requestedType,
          seq: 0,
          aggregateID: sessions[1],
          data: {
            sessionID: sessions[1],
            timestamp: 90,
            request: request(VerificationReceipt.ID.make("vrc_replay_b"), 7, "tree_alpha"),
          },
        },
        {
          id: EventBus.ID.create(),
          type: requestedType,
          seq: 0,
          aggregateID: sessions[2],
          data: {
            sessionID: sessions[2],
            timestamp: 20,
            request: request(VerificationReceipt.ID.make("vrc_replay_c"), 7, "tree_zulu"),
          },
        },
        {
          id: EventBus.ID.create(),
          type: requestedType,
          seq: 0,
          aggregateID: sessions[3],
          data: {
            sessionID: sessions[3],
            timestamp: 70,
            request: request(VerificationReceipt.ID.make("vrc_replay_d"), 7, "tree_zulu"),
          },
        },
      ] satisfies EventBus.SerializedEvent[]
      const replay = (ordered: readonly EventBus.SerializedEvent[]) =>
        Effect.forEach(ordered, (event) => events.replayAll([event]), {
          discard: true,
        })
      const readState = db
        .select()
        .from(VerificationLocationStateTable)
        .where(eq(VerificationLocationStateTable.location_key, locationKey))
        .get()
        .pipe(Effect.orDie)

      yield* replay(serialized)
      const forward = yield* readState

      yield* db
        .delete(VerificationReceiptTable)
        .where(eq(VerificationReceiptTable.location_key, locationKey))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(VerificationLocationStateTable)
        .where(eq(VerificationLocationStateTable.location_key, locationKey))
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(sessions, (id) => events.remove(id), {
        discard: true,
      })

      yield* replay([...serialized].reverse())
      const reverse = yield* readState

      expect(reverse).toEqual(forward)
      expect(reverse).toEqual({
        location_key: locationKey,
        mutation_epoch: 7,
        snapshot: "tree_zulu",
        time_created: 5,
        time_updated: 70,
      })
    }),
  )

  it.effect("rejects settlement without a matching request", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* settle({
          sessionID,
          timestamp: DateTime.makeUnsafe(10),
          settlement: {
            id: VerificationReceipt.ID.make("vrc_missing"),
            verdict: "missing",
            checks: [],
            reason: "No authorized verifier",
          },
        })
        .pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
    }),
  )

  it.effect("persists a historical settlement after location state advances", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventBus.Service
      const older = VerificationReceipt.ID.make("vrc_stale")
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        request: request(older, 1, "tree_old"),
      })
      yield* events.publish(SessionEvent.VerificationRequested, {
        sessionID,
        timestamp: DateTime.makeUnsafe(20),
        request: request(VerificationReceipt.ID.make("vrc_current"), 2, "tree_current"),
      })

      yield* settle({
        sessionID,
        timestamp: DateTime.makeUnsafe(30),
        settlement: { id: older, verdict: "missing", checks: [] },
      })
      expect(
        (yield* db
          .select()
          .from(VerificationReceiptTable)
          .where(eq(VerificationReceiptTable.id, older))
          .get()
          .pipe(Effect.orDie))?.verdict,
      ).toBe("missing")
    }),
  )
})
