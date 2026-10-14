import { describe, expect } from "bun:test"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { VerifierContainment } from "../src/verification/containment"
import { VerifierRegistry } from "../src/verification/registry"
import { testEffect } from "./lib/effect"

const it = testEffect(VerifierContainment.unavailableLayer)
const projectID = ProjectRegistry.ID.make("project_containment_test")
const snapshot = Snapshot.ID.make("snapshot_containment_test")
const locationKey = VerificationReceipt.LocationKey.make("location_containment_test")
const executionID = VerificationReceipt.ID.make("verification_containment_test")
const subject = { executionID, snapshot, projectID, locationKey } as const

const selection = (timeoutMs = 120_000, maxOutputBytes = 16_384) =>
  VerifierRegistry.pin(
    {
      id: "project-tests",
      version: "1",
      source: "policy",
      check: {
        id: "unit",
        argv: ["pnpm", "run", "test"],
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
      projectID,
      projectRoot: AbsolutePath.make("/project"),
    },
  )

const validResult = (selected: VerifierRegistry.Selection): VerifierContainment.Result => ({
  executor: selected.plan.executor,
  subject,
  status: "passed",
  exitCode: 0,
  durationMs: 17,
  stdout: "all checks passed",
  stderr: "",
  summary: "unit verifier passed",
  outputTruncated: false,
})

describe("VerifierContainment", () => {
  it.effect("fails closed as unavailable without an installed executor", () =>
    Effect.gen(function* () {
      const selected = selection()
      const service = yield* VerifierContainment.Service
      const error = yield* Effect.flip(
        service.execute({
          selection: selected,
          subject,
        }),
      )

      expect(error).toBeInstanceOf(VerifierContainment.Error)
      expect(error.reason).toBe("unavailable")
    }),
  )

  it.effect("decodes bounded results with the returned executor descriptor", () =>
    Effect.gen(function* () {
      const selected = selection()
      const expected = validResult(selected)
      const decoded = yield* VerifierContainment.decodeResult(expected)

      expect(decoded).toEqual(expected)
      expect(decoded.executor).toEqual(selected.plan.executor)
    }),
  )

  it.effect("rejects oversized evidence, invalid duration, and incoherent statuses", () =>
    Effect.gen(function* () {
      const selected = selection()
      const valid = validResult(selected)
      const invalid = [
        {
          ...valid,
          stdout: "x".repeat(VerifierContainment.MAX_OUTPUT_CHARS + 1),
        },
        {
          ...valid,
          stderr: "x".repeat(VerifierContainment.MAX_OUTPUT_CHARS + 1),
        },
        {
          ...valid,
          summary: "x".repeat(VerifierContainment.MAX_SUMMARY_CHARS + 1),
        },
        { ...valid, durationMs: -1 },
        { ...valid, status: "passed", exitCode: 1 },
        { ...valid, status: "failed", exitCode: 0 },
        { ...valid, status: "failed", exitCode: undefined },
        { ...valid, status: "unknown" },
        { ...valid, outputTruncated: undefined },
      ]

      for (const value of invalid) {
        const exit = yield* VerifierContainment.decodeResult(value).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }

      const { exitCode: _, ...withoutExitCode } = valid
      expect(
        (yield* VerifierContainment.decodeResult({
          ...withoutExitCode,
          status: "error",
        })).status,
      ).toBe("error")
      expect(
        (yield* VerifierContainment.decodeResult({
          ...withoutExitCode,
          status: "timeout",
        })).status,
      ).toBe("timeout")
      expect(
        (yield* VerifierContainment.decodeResult({
          ...valid,
          status: "failed",
          exitCode: 2,
        })).status,
      ).toBe("failed")
    }),
  )

  it.effect("passes the exact pinned selection and subject to an injected implementation", () =>
    Effect.gen(function* () {
      const selected = selection()
      const expected = validResult(selected)
      let received: VerifierContainment.ExecuteInput | undefined
      const fake = VerifierContainment.make((input) =>
        Effect.sync(() => {
          received = input
          return expected
        }),
      )

      const actual = yield* Effect.gen(function* () {
        const service = yield* VerifierContainment.Service
        return yield* service.execute({ selection: selected, subject })
      }).pipe(Effect.provideService(VerifierContainment.Service, fake))

      expect(actual).toEqual(expected)
      expect(Object.isFrozen(actual)).toBe(true)
      expect(received?.selection).toBe(selected)
      expect(received?.selection.projectRoot).toBe(AbsolutePath.make("/project"))
      expect(received?.subject).toBe(subject)
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received?.subject)).toBe(true)
      expect(received?.subject.executionID).toBe(executionID)
      expect(received?.subject.snapshot).toBe(snapshot)
      expect(received?.subject.projectID).toBe(projectID)
      expect(received?.subject.locationKey).toBe(locationKey)
    }),
  )

  it.effect("rejects subject confusion and invalid adapter evidence before returning a result", () =>
    Effect.gen(function* () {
      const selected = selection()
      let executions = 0
      const subjectMismatch = VerifierContainment.make(() =>
        Effect.sync(() => {
          executions++
          return validResult(selected)
        }),
      )
      const mismatch = yield* Effect.flip(
        subjectMismatch.execute({
          selection: selected,
          subject: { ...subject, projectID: ProjectRegistry.ID.make("another_project") },
        }),
      )
      expect(mismatch.reason).toBe("subject-mismatch")
      expect(executions).toBe(0)

      const wrongSubject = VerifierContainment.make(() =>
        Effect.succeed({
          ...validResult(selected),
          subject: {
            ...subject,
            snapshot: Snapshot.ID.make("another_snapshot"),
          },
        }),
      )
      expect((yield* Effect.flip(wrongSubject.execute({ selection: selected, subject }))).reason).toBe(
        "subject-mismatch",
      )

      const invalid = VerifierContainment.make(() =>
        Effect.succeed({
          ...validResult(selected),
          exitCode: 7,
        }),
      )
      expect(
        (yield* Effect.flip(invalid.execute({ selection: selected, subject }))).reason,
      ).toBe("invalid-result")

      const outputSelection = selection(120_000, 4)
      const excessive = VerifierContainment.make(() =>
        Effect.succeed({
          ...validResult(outputSelection),
          stdout: "12345",
        }),
      )
      expect(
        (yield* Effect.flip(
          excessive.execute({ selection: outputSelection, subject }),
        )).reason,
      ).toBe("output-limit")

      const unicodeExcessive = VerifierContainment.make(() =>
        Effect.succeed({
          ...validResult(outputSelection),
          stdout: "ééé",
        }),
      )
      expect(
        (yield* Effect.flip(
          unicodeExcessive.execute({ selection: outputSelection, subject }),
        )).reason,
      ).toBe("output-limit")

      const durationSelection = selection(10)
      const excessiveDuration = VerifierContainment.make(() =>
        Effect.succeed({
          ...validResult(durationSelection),
          durationMs: 11,
        }),
      )
      expect(
        (yield* Effect.flip(
          excessiveDuration.execute({ selection: durationSelection, subject }),
        )).reason,
      ).toBe("timeout")
    }),
  )

  it.effect("enforces the pinned deadline and interrupts adapter cleanup", () =>
    Effect.gen(function* () {
      const selected = selection(10)
      let cleanups = 0
      const service = VerifierContainment.make(() =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              cleanups++
            }),
          ),
        ),
      )
      const fiber = yield* service
        .execute({ selection: selected, subject })
        .pipe(Effect.forkChild)

      yield* TestClock.adjust("11 millis")
      const error = yield* Effect.flip(Fiber.join(fiber))

      expect(error.reason).toBe("timeout")
      expect(cleanups).toBe(1)
    }),
  )
})
