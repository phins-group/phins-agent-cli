import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { VerificationReceipt } from "../../src/contracts/execution/verification-receipt"

describe("VerificationReceipt", () => {
  test("round-trips a settled shadow receipt", () => {
    const encoded = {
      id: "vrc_test",
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      locationKey: "location_test",
      mode: "shadow",
      subject: { mutationEpoch: 3, snapshot: "tree_test" },
      verifier: {
        id: "tests",
        version: "1",
        source: "task",
        digest: `sha256:${"a".repeat(64)}`,
        provenance: {
          kind: "signed-policy",
          authorityID: "workspace-policy",
          keyID: `sha256:${"b".repeat(64)}`,
          revision: 3,
          policyDigest: `sha256:${"c".repeat(64)}`,
        },
      },
      verdict: "passed",
      checks: [
        {
          id: "unit",
          command: ["pnpm", "test"],
          status: "passed",
          exitCode: 0,
          durationMs: 1200,
          summary: "All tests passed",
        },
      ],
      attestation: {
        schema: "phins.verifier-execution-attestation-envelope.v1",
        payload: "ZXh0ZXJuYWwtc2lnbmVkLXBheWxvYWQ",
        signature: "ZXh0ZXJuYWwtc2lnbmF0dXJl",
      },
      time: { requested: 1, started: 2, completed: 1202 },
    } as const

    const receipt = Schema.decodeUnknownSync(VerificationReceipt.Receipt)(encoded)

    expect(receipt.time.requested).toEqual(DateTime.makeUnsafe(1))
    expect(receipt.subject).toEqual({
      mutationEpoch: 3,
      snapshot: "tree_test",
    })
    expect(Schema.encodeSync(VerificationReceipt.Receipt)(receipt)).toEqual(encoded)
  })

  test("rejects a negative mutation epoch", () => {
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Request)({
        id: "vrc_test",
        locationKey: "location_test",
        mode: "shadow",
        subject: { mutationEpoch: -1 },
      }),
    ).toThrow()
  })

  test("validates strict signed-policy provenance", () => {
    const provenance = {
      kind: "signed-policy" as const,
      authorityID: "workspace-policy",
      keyID: `sha256:${"a".repeat(64)}`,
      revision: 7,
      policyDigest: `sha256:${"b".repeat(64)}`,
    }

    expect(() => Schema.decodeUnknownSync(VerificationReceipt.Provenance)(provenance)).not.toThrow()
    for (const invalid of [
      { ...provenance, kind: "local-policy" },
      { ...provenance, authorityID: "" },
      { ...provenance, authorityID: "x".repeat(257) },
      { ...provenance, keyID: "sha256:invalid" },
      { ...provenance, revision: -1 },
      { ...provenance, revision: 1.5 },
      { ...provenance, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...provenance, policyDigest: `sha256:${"A".repeat(64)}` },
      { ...provenance, signature: "not-part-of-the-contract" },
    ]) {
      expect(() => Schema.decodeUnknownSync(VerificationReceipt.Provenance)(invalid)).toThrow()
    }
  })

  test("bounds inline check output", () => {
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Check)({
        id: "unit",
        command: ["pnpm", "test"],
        status: "passed",
        exitCode: 0,
        durationMs: 1,
        stdout: "x".repeat(VerificationReceipt.MAX_CHECK_OUTPUT_CHARS + 1),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Check)({
        id: "unit",
        command: ["pnpm", "test"],
        status: "passed",
        exitCode: 1,
        durationMs: 1,
      }),
    ).toThrow("passed check exitCode must be 0")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Check)({
        id: "unit",
        command: ["pnpm", "test"],
        status: "failed",
        exitCode: 0,
        durationMs: 1,
      }),
    ).toThrow("failed check exitCode must be non-zero")
  })

  test("requires trusted, internally consistent evidence verdicts", () => {
    const verifier = {
      id: "tests",
      version: "1",
      source: "task" as const,
      digest: `sha256:${"b".repeat(64)}`,
    }
    const check = {
      id: "unit",
      command: ["pnpm", "test"],
      status: "passed" as const,
      exitCode: 0,
      durationMs: 1,
    }
    const settlement = {
      id: "vrc_test",
      verdict: "passed" as const,
      verifier,
      checks: [check],
      startedAt: 1,
    }

    expect(() => Schema.decodeUnknownSync(VerificationReceipt.Settlement)(settlement)).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...settlement,
        verifier: undefined,
      }),
    ).toThrow("requires a trusted verifier")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...settlement,
        checks: [],
      }),
    ).toThrow("requires at least one verification check")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...settlement,
        verdict: "failed",
      }),
    ).toThrow("aggregate to passed, not failed")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...settlement,
        verifier: { ...verifier, digest: "sha256:test" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...settlement,
        verdict: "error",
        checks: [check, { ...check, id: "timeout", status: "timeout" }, { ...check, id: "error", status: "error" }],
      }),
    ).not.toThrow()
  })

  test("forbids fake evidence on non-evidence verdicts", () => {
    const base = { id: "vrc_test", verdict: "missing" as const, checks: [] }

    expect(() => Schema.decodeUnknownSync(VerificationReceipt.Settlement)(base)).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({ ...base, verdict: "stale" }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({ ...base, verdict: "abandoned" }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...base,
        verifier: {
          id: "tests",
          version: "1",
          source: "task",
          digest: `sha256:${"c".repeat(64)}`,
        },
      }),
    ).toThrow("must not contain verifier evidence")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...base,
        checks: [
          {
            id: "unit",
            command: ["pnpm", "test"],
            status: "passed",
            exitCode: 0,
            durationMs: 1,
          },
        ],
      }),
    ).toThrow("must not contain verification checks")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...base,
        attestation: {
          schema: "phins.verifier-execution-attestation-envelope.v1",
          payload: "cGF5bG9hZA",
          signature: "c2lnbmF0dXJl",
        },
      }),
    ).toThrow("must not contain execution attestation evidence")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Settlement)({
        ...base,
        startedAt: 1,
      }),
    ).toThrow("must not contain verifier start time")
  })

  test("applies the same evidence invariants to materialized receipts", () => {
    const missing = {
      id: "vrc_test",
      sessionID: "ses_test",
      locationKey: "location_test",
      mode: "shadow" as const,
      subject: { mutationEpoch: 1 },
      verdict: "missing" as const,
      checks: [],
      time: { requested: 1, completed: 2 },
    }

    expect(() => Schema.decodeUnknownSync(VerificationReceipt.Receipt)(missing)).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
        ...missing,
        verifier: {
          id: "tests",
          version: "1",
          source: "task",
          digest: `sha256:${"d".repeat(64)}`,
        },
      }),
    ).toThrow("must not contain verifier evidence")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
        ...missing,
        verdict: "stale",
        verifier: {
          id: "tests",
          version: "1",
          source: "task",
          digest: `sha256:${"d".repeat(64)}`,
        },
      }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
        ...missing,
        verdict: "abandoned",
        verifier: {
          id: "tests",
          version: "1",
          source: "task",
          digest: `sha256:${"d".repeat(64)}`,
        },
      }),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
        ...missing,
        verdict: "passed",
      }),
    ).toThrow("requires a trusted verifier")
    expect(() =>
      Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
        ...missing,
        time: { requested: 2, completed: 1 },
      }),
    ).toThrow("completion time must not precede request time")
  })
})
