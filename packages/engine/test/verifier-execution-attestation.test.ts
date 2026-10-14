import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { DateTime, Effect } from "effect"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { VerifierExecutionAttestation } from "../src/verification/execution-attestation"
import { VerifierKeyLifecycle } from "../src/verification/key-lifecycle"
import { canonicalBytes, sha256 } from "../src/verification/canonical-signature"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { SessionID } from "../src/contracts/session/id"

const root = generateKeyPairSync("ed25519")
const signer = generateKeyPairSync("ed25519")
const spki = (key: typeof root.publicKey) => Buffer.from(key.export({ format: "der", type: "spki" }))
const encodedSpki = (key: typeof root.publicKey) => spki(key).toString("base64url")
const keyID = (key: typeof root.publicKey) => sha256(spki(key))
const receiptID = VerificationReceipt.ID.make("vrc_external_attestation")
const sessionID = SessionID.make("ses_external_attestation")
const projectID = ProjectRegistry.ID.make("project_external_attestation")
const locationKey = VerificationReceipt.LocationKey.make("vloc_external_attestation")
const verifierDigest = `sha256:${"a".repeat(64)}`
const executorDigest = `sha256:${"b".repeat(64)}`
const attemptToken = "vat_00000000-0000-4000-8000-000000000001"
const completedAtMs = 3_000
const nowMs = 5_000

const makeLedger = () => {
  const eventWithoutDigest = {
    schema: "phins.verifier-key-event.v1" as const,
    sequence: 0,
    previousEventDigest: VerifierKeyLifecycle.GENESIS_DIGEST,
    occurredAtMs: 1_000,
    type: "distributed" as const,
    keyID: keyID(signer.publicKey),
    publicKeySpki: encodedSpki(signer.publicKey),
    purpose: "execution-attestation" as const,
    state: "active" as const,
    verifierPrincipal: "uid:2001",
    supervisorPrincipal: "uid:2002",
    notBeforeMs: 500,
    expiresAtMs: 20_000,
  }
  const event = {
    ...eventWithoutDigest,
    eventDigest: VerifierKeyLifecycle.eventDigest(eventWithoutDigest),
  }
  const payload = {
    schema: "phins.verifier-key-ledger.v1" as const,
    authorityID: "phins-attestation-root",
    rootKeyID: keyID(root.publicKey),
    revision: 0,
    notBeforeMs: 100,
    expiresAtMs: 30_000,
    issuedAtMs: 2_000,
    events: [event],
    headEventDigest: event.eventDigest,
  }
  const bytes = canonicalBytes(payload)
  return VerifierKeyLifecycle.make({
    bundle: JSON.stringify({
      payload: bytes.toString("base64url"),
      signature: sign(null, bytes, root.privateKey).toString("base64url"),
    }),
    expectedAuthorityID: payload.authorityID,
    expectedRevision: payload.revision,
    expectedLedgerDigest: sha256(bytes),
    rootSpki: encodedSpki(root.publicKey),
    nowMs,
  })
}

const verifier = {
  id: "external-verifier",
  version: "1",
  source: "policy" as const,
  digest: verifierDigest,
}
const request: VerificationReceipt.Request = {
  id: receiptID,
  locationKey,
  mode: "shadow",
  subject: { mutationEpoch: 7, snapshot: "tree_attested" },
  verifier,
}
const check: VerificationReceipt.Check = {
  id: "unit",
  command: ["pnpm", "test"],
  status: "passed",
  exitCode: 0,
  durationMs: 900,
  summary: "passed externally",
}
const unsignedSettlement: VerificationReceipt.Settlement = {
  id: receiptID,
  verdict: "passed",
  verifier,
  checks: [check],
  startedAt: DateTime.makeUnsafe(2_000),
}

const signedSettlement = (
  ledger: VerifierKeyLifecycle.Interface,
  overrides: Record<string, unknown> = {},
): VerificationReceipt.Settlement => {
  const payload = {
    schema: "phins.verifier-execution-attestation.v1",
    authorityID: ledger.authorityID,
    keyID: keyID(signer.publicKey),
    ledgerRevision: ledger.revision,
    ledgerDigest: ledger.ledgerDigest,
    auditHeadDigest: ledger.auditHeadDigest,
    issuedAtMs: 3_100,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    execution: {
      receiptID,
      sessionID,
      attemptGeneration: 1,
      attemptTokenDigest: sha256(attemptToken),
      subject: {
        mutationEpoch: request.subject.mutationEpoch,
        snapshot: request.subject.snapshot,
        projectID,
        locationKey,
      },
      verifierDigest,
      executorDigest,
      containmentProfile: "linux-oci-v1",
      startedAtMs: 2_000,
      completedAtMs,
      settlementDigest: VerifierExecutionAttestation.settlementDigest(sessionID, completedAtMs, unsignedSettlement),
    },
    principals: {
      schema: "phins.verifier-principal-separation-evidence.v1",
      agentPrincipal: "uid:1001",
      verifierPrincipal: "uid:2001",
      supervisorPrincipal: "uid:2002",
      isolation: "separate-os-principals",
      snapshotControl: "verifier-supervisor",
      settlementControl: "verifier-supervisor",
      observedAtMs: 2_500,
    },
    ...overrides,
  }
  const bytes = canonicalBytes(payload)
  return {
    ...unsignedSettlement,
    attestation: {
      schema: "phins.verifier-execution-attestation-envelope.v1",
      payload: bytes.toString("base64url"),
      signature: sign(null, bytes, signer.privateKey).toString("base64url"),
    },
  }
}

const expected = (
  settlement: VerificationReceipt.Settlement,
  overrides: Partial<VerifierExecutionAttestation.Expected> = {},
): VerifierExecutionAttestation.Expected => ({
  sessionID,
  completedAtMs,
  settlement,
  request,
  attemptGeneration: 1,
  attemptToken,
  projectID,
  executorDigest,
  containmentProfile: "linux-oci-v1",
  agentPrincipal: "uid:1001",
  nowMs,
  ...overrides,
})

describe("VerifierExecutionAttestation", () => {
  test("verifies a signed settlement, execution and three-principal binding", async () => {
    const ledger = makeLedger()
    const settlement = signedSettlement(ledger)
    const verified = await Effect.runPromise(VerifierExecutionAttestation.make(ledger).verify(expected(settlement)))

    expect(verified).toMatchObject({
      schema: "phins.verifier-execution-attestation.v1",
      authorityID: ledger.authorityID,
      keyID: keyID(signer.publicKey),
      ledgerRevision: 0,
      ledgerDigest: ledger.ledgerDigest,
      auditHeadDigest: ledger.auditHeadDigest,
      issuedAtMs: 3_100,
      principals: {
        agentPrincipal: "uid:1001",
        verifierPrincipal: "uid:2001",
        supervisorPrincipal: "uid:2002",
      },
    })
  })

  test("rejects settlement mutation after the external signature", async () => {
    const ledger = makeLedger()
    const settlement = signedSettlement(ledger)
    const mutated = {
      ...settlement,
      checks: [{ ...check, summary: "mutated after signing" }],
    }

    await expect(
      Effect.runPromise(VerifierExecutionAttestation.make(ledger).verify(expected(mutated))),
    ).rejects.toThrow("does not match")
  })

  test("commits differently to an omitted and explicitly empty reason", () => {
    expect(VerifierExecutionAttestation.settlementDigest(sessionID, completedAtMs, unsignedSettlement)).not.toBe(
      VerifierExecutionAttestation.settlementDigest(sessionID, completedAtMs, {
        ...unsignedSettlement,
        reason: "",
      }),
    )
  })

  test("rechecks ledger expiry during probe and verification", async () => {
    const ledger = makeLedger()
    const settlement = signedSettlement(ledger)
    const expiredAt = 30_000
    const attestationVerifier = VerifierExecutionAttestation.make(ledger, {
      now: () => expiredAt,
    })

    await expect(Effect.runPromise(attestationVerifier.probe)).rejects.toThrow("not active")
    await expect(
      Effect.runPromise(attestationVerifier.verify(expected(settlement, { nowMs: expiredAt }))),
    ).rejects.toThrow("not active")
  })

  test("rejects authority identifiers exceeding the shared bound", async () => {
    const ledger = makeLedger()
    const settlement = signedSettlement(ledger, {
      authorityID: "a".repeat(257),
    })

    await expect(
      Effect.runPromise(VerifierExecutionAttestation.make(ledger).verify(expected(settlement))),
    ).rejects.toThrow("payload is invalid")
  })

  test("rejects a signed principal claim outside trusted key distribution", async () => {
    const ledger = makeLedger()
    const settlement = signedSettlement(ledger, {
      principals: {
        schema: "phins.verifier-principal-separation-evidence.v1",
        agentPrincipal: "uid:1001",
        verifierPrincipal: "uid:9991",
        supervisorPrincipal: "uid:9992",
        isolation: "separate-os-principals",
        snapshotControl: "verifier-supervisor",
        settlementControl: "verifier-supervisor",
        observedAtMs: 2_500,
      },
    })

    await expect(
      Effect.runPromise(VerifierExecutionAttestation.make(ledger).verify(expected(settlement))),
    ).rejects.toThrow("principals")
  })

  test("fails closed when evidence has no signed envelope", async () => {
    const ledger = makeLedger()
    await expect(
      Effect.runPromise(VerifierExecutionAttestation.make(ledger).verify(expected(unsignedSettlement))),
    ).rejects.toThrow("missing")
  })
})
