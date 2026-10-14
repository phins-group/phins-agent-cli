export * as VerifierExecutionAttestation from "./execution-attestation"

import { DateTime, Effect, Schema } from "effect"
import { ProjectRegistry } from "../workspace/projects/service"
import { PositiveInt } from "../shared/schema"
import { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { SessionID } from "../contracts/session/id"
import { canonicalBytes, decodeCanonicalBase64Url, sha256, verifyCanonicalEnvelope } from "./canonical-signature"
import { VerifierKeyLifecycle } from "./key-lifecycle"

const PAYLOAD_SCHEMA = "phins.verifier-execution-attestation.v1" as const
const PRINCIPAL_SCHEMA = "phins.verifier-principal-separation-evidence.v1" as const
const MAX_SIGNING_DELAY_MS = 5 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 30_000
const MAX_AUTHORITY_CHARS = 256
const MAX_PRINCIPAL_CHARS = 1_024
const strictOptions = { errors: "all", onExcessProperty: "error" } as const

const Field = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_PRINCIPAL_CHARS))
const AuthorityField = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_AUTHORITY_CHARS))
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SafeMillis = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "must be a non-negative safe integer",
  ),
)
const Nonce = Schema.String.check(Schema.isMinLength(22), Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9_-]+$/))

const Subject = Schema.Struct({
  mutationEpoch: SafeMillis,
  snapshot: Schema.String.pipe(Schema.optional),
  projectID: ProjectRegistry.ID,
  locationKey: VerificationReceipt.LocationKey,
})

const PrincipalSeparationFields = Schema.Struct({
  schema: Schema.Literal(PRINCIPAL_SCHEMA),
  agentPrincipal: Field,
  verifierPrincipal: Field,
  supervisorPrincipal: Field,
  isolation: Schema.Literal("separate-os-principals"),
  snapshotControl: Schema.Literal("verifier-supervisor"),
  settlementControl: Schema.Literal("verifier-supervisor"),
  observedAtMs: SafeMillis,
})

export const PrincipalEvidence = PrincipalSeparationFields.check(
  Schema.makeFilter<typeof PrincipalSeparationFields.Type>((value) => {
    const principals = new Set([value.agentPrincipal, value.verifierPrincipal, value.supervisorPrincipal])
    return principals.size === 3 ? undefined : "agent, verifier and supervisor principals must be distinct"
  }),
).annotate({
  identifier: "VerifierExecutionAttestation.PrincipalEvidence",
  parseOptions: { onExcessProperty: "error" },
})
export type PrincipalEvidence = typeof PrincipalEvidence.Type

export const Payload = Schema.Struct({
  schema: Schema.Literal(PAYLOAD_SCHEMA),
  authorityID: AuthorityField,
  keyID: Digest,
  ledgerRevision: SafeMillis,
  ledgerDigest: Digest,
  auditHeadDigest: Digest,
  issuedAtMs: SafeMillis,
  nonce: Nonce,
  execution: Schema.Struct({
    receiptID: VerificationReceipt.ID,
    sessionID: SessionID,
    attemptGeneration: PositiveInt,
    attemptTokenDigest: Digest,
    subject: Subject,
    verifierDigest: Digest,
    executorDigest: Digest,
    containmentProfile: Schema.Literal("linux-oci-v1"),
    startedAtMs: SafeMillis,
    completedAtMs: SafeMillis,
    settlementDigest: Digest,
  }),
  principals: PrincipalEvidence,
}).annotate({
  identifier: "VerifierExecutionAttestation.Payload",
  parseOptions: { onExcessProperty: "error" },
})
export type Payload = typeof Payload.Type

export type ErrorReason = "schema" | "signature" | "ledger" | "binding" | "principal-separation" | "time"

export class AttestationError extends globalThis.Error {
  override readonly name = "VerifierExecutionAttestationError"

  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message)
  }
}

export interface Expected {
  readonly sessionID: SessionID
  readonly completedAtMs: number
  readonly settlement: VerificationReceipt.Settlement
  readonly request: VerificationReceipt.Request
  readonly attemptGeneration: number
  readonly attemptToken: string
  readonly projectID: ProjectRegistry.ID
  readonly executorDigest: string
  readonly containmentProfile: "linux-oci-v1"
  readonly agentPrincipal: string
  readonly nowMs?: number
}

export interface Verified {
  readonly schema: typeof PAYLOAD_SCHEMA
  readonly authorityID: string
  readonly keyID: string
  readonly ledgerRevision: number
  readonly ledgerDigest: string
  readonly auditHeadDigest: string
  readonly attestationDigest: string
  readonly issuedAtMs: number
  readonly principals: PrincipalEvidence
}

export type Envelope = VerificationReceipt.ExecutionAttestation

export interface Interface {
  readonly verify: (input: Expected) => Effect.Effect<Verified, AttestationError>
  readonly probe: Effect.Effect<void, AttestationError>
}

export interface Options {
  readonly now?: () => number
}

const decodePayload = (input: unknown) => Schema.decodeUnknownSync(Payload)(input, strictOptions)

const settlementCommitment = (
  sessionID: SessionID,
  completedAtMs: number,
  settlement: VerificationReceipt.Settlement,
) => ({
  schema: "phins.verification-settlement-commitment.v1",
  sessionID,
  completedAtMs,
  settlement: {
    id: settlement.id,
    verdict: settlement.verdict,
    ...(settlement.verifier ? { verifier: settlement.verifier } : {}),
    checks: settlement.checks,
    ...(settlement.reason !== undefined ? { reason: settlement.reason } : {}),
    ...(settlement.startedAt ? { startedAtMs: DateTime.toEpochMillis(settlement.startedAt) } : {}),
  },
})

/** Stable digest signed by an external verifier; the envelope itself is omitted. */
export const settlementDigest = (
  sessionID: SessionID,
  completedAtMs: number,
  settlement: VerificationReceipt.Settlement,
) => sha256(canonicalBytes(settlementCommitment(sessionID, completedAtMs, settlement)))

const parseUntrustedPayload = (envelope: VerificationReceipt.ExecutionAttestation) => {
  try {
    const bytes = decodeCanonicalBase64Url(envelope.payload, "execution attestation payload")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return decodePayload(JSON.parse(text))
  } catch {
    throw new AttestationError("schema", "execution attestation payload is invalid")
  }
}

const equalSubject = (actual: Payload["execution"]["subject"], expected: Expected) =>
  actual.mutationEpoch === expected.request.subject.mutationEpoch &&
  actual.snapshot === expected.request.subject.snapshot &&
  actual.projectID === expected.projectID &&
  actual.locationKey === expected.request.locationKey

export const make = (ledger: VerifierKeyLifecycle.Interface, options: Options = {}): Interface => {
  const now = options.now ?? Date.now
  const verify = Effect.fn("VerifierExecutionAttestation.verify")((expected: Expected) =>
    Effect.try({
      try: () => {
        if (!Schema.is(VerificationReceipt.Settlement)(expected.settlement))
          throw new AttestationError("schema", "execution settlement is not a valid decoded settlement")
        const settlement = expected.settlement
        const envelope = settlement.attestation
        if (!envelope) throw new AttestationError("schema", "evidence settlement is missing an external attestation")
        if (
          settlement.verdict !== "passed" &&
          settlement.verdict !== "failed" &&
          settlement.verdict !== "error" &&
          settlement.verdict !== "timeout"
        )
          throw new AttestationError("schema", "only evidence settlements may carry execution attestation")

        const nowMs = expected.nowMs ?? now()
        if (!Number.isSafeInteger(nowMs) || nowMs < 0)
          throw new AttestationError("time", "execution attestation verification time is invalid")
        try {
          ledger.assertActiveAt(nowMs)
        } catch (error) {
          throw new AttestationError(
            "ledger",
            error instanceof globalThis.Error ? error.message : "trusted key ledger is not active",
          )
        }

        const untrusted = parseUntrustedPayload(envelope)
        let signingKey: VerifierKeyLifecycle.AttestationKey
        try {
          signingKey = ledger.keyForAttestation(untrusted.keyID, untrusted.issuedAtMs)
        } catch (error) {
          throw new AttestationError(
            "ledger",
            error instanceof globalThis.Error ? error.message : "attestation key is not trusted",
          )
        }
        let verified
        try {
          verified = verifyCanonicalEnvelope({
            envelope,
            publicKeySpki: signingKey.publicKeySpki,
            decode: decodePayload,
            label: "execution attestation",
          })
        } catch (error) {
          throw new AttestationError(
            "signature",
            error instanceof globalThis.Error ? error.message : "execution attestation signature is invalid",
          )
        }
        const payload = verified.value
        if (
          payload.authorityID !== ledger.authorityID ||
          payload.keyID !== signingKey.keyID ||
          payload.ledgerRevision !== ledger.revision ||
          payload.ledgerDigest !== ledger.ledgerDigest ||
          payload.auditHeadDigest !== ledger.auditHeadDigest
        )
          throw new AttestationError("ledger", "execution attestation is not bound to the trusted ledger head")

        const principals = payload.principals
        if (
          principals.agentPrincipal !== expected.agentPrincipal ||
          principals.verifierPrincipal !== signingKey.verifierPrincipal ||
          principals.supervisorPrincipal !== signingKey.supervisorPrincipal
        )
          throw new AttestationError(
            "principal-separation",
            "execution attestation principals do not match trusted distribution evidence",
          )

        const startedAtMs = settlement.startedAt ? DateTime.toEpochMillis(settlement.startedAt) : undefined
        if (startedAtMs === undefined)
          throw new AttestationError("binding", "evidence settlement has no verifier start time")
        if (
          !Number.isSafeInteger(expected.completedAtMs) ||
          expected.completedAtMs < 0 ||
          payload.execution.startedAtMs !== startedAtMs ||
          payload.execution.completedAtMs !== expected.completedAtMs ||
          payload.principals.observedAtMs < startedAtMs ||
          payload.principals.observedAtMs > expected.completedAtMs ||
          payload.issuedAtMs < expected.completedAtMs ||
          payload.issuedAtMs > expected.completedAtMs + MAX_SIGNING_DELAY_MS ||
          payload.issuedAtMs > nowMs + MAX_CLOCK_SKEW_MS
        )
          throw new AttestationError("time", "execution attestation timing evidence is invalid")

        const verifierDigest = expected.request.verifier?.digest
        if (
          settlement.id !== expected.request.id ||
          payload.execution.receiptID !== expected.request.id ||
          payload.execution.sessionID !== expected.sessionID ||
          payload.execution.attemptGeneration !== expected.attemptGeneration ||
          payload.execution.attemptTokenDigest !== sha256(expected.attemptToken) ||
          !equalSubject(payload.execution.subject, expected) ||
          verifierDigest === undefined ||
          payload.execution.verifierDigest !== verifierDigest ||
          settlement.verifier?.digest !== verifierDigest ||
          payload.execution.executorDigest !== expected.executorDigest ||
          payload.execution.containmentProfile !== expected.containmentProfile ||
          payload.execution.settlementDigest !==
            settlementDigest(expected.sessionID, expected.completedAtMs, settlement)
        )
          throw new AttestationError("binding", "execution attestation does not match the requested settlement")

        return Object.freeze({
          schema: PAYLOAD_SCHEMA,
          authorityID: payload.authorityID,
          keyID: payload.keyID,
          ledgerRevision: payload.ledgerRevision,
          ledgerDigest: payload.ledgerDigest,
          auditHeadDigest: payload.auditHeadDigest,
          attestationDigest: verified.payloadDigest,
          issuedAtMs: payload.issuedAtMs,
          principals,
        }) satisfies Verified
      },
      catch: (error) =>
        error instanceof AttestationError
          ? error
          : new AttestationError("schema", "execution attestation verification failed"),
    }),
  )

  const probe = Effect.try({
    try: () => ledger.assertActiveAt(now()),
    catch: (error) =>
      new AttestationError(
        "ledger",
        error instanceof globalThis.Error ? error.message : "trusted key ledger is not active",
      ),
  })

  return Object.freeze({
    verify,
    probe,
  })
}
