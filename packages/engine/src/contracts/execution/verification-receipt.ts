export * as VerificationReceipt from "./verification-receipt"

import { DateTime, Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt } from "../schema"
import { SessionID } from "../session/id"
import { SessionMessageID } from "../session/message-id"

export const ID = Schema.String.pipe(Schema.brand("VerificationReceipt.ID"))
export type ID = typeof ID.Type

export const LocationKey = Schema.String.pipe(Schema.brand("VerificationReceipt.LocationKey"))
export type LocationKey = typeof LocationKey.Type

export const Mode = Schema.Literal("shadow")
export type Mode = typeof Mode.Type

export const Verdict = Schema.Literals([
  "passed",
  "failed",
  "error",
  "timeout",
  "missing",
  "stale",
  "abandoned",
])
export type Verdict = typeof Verdict.Type

export const CheckStatus = Schema.Literals(["passed", "failed", "error", "timeout"])
export type CheckStatus = typeof CheckStatus.Type

export const MAX_CHECK_OUTPUT_CHARS = 16_384
export const MAX_CHECK_SUMMARY_CHARS = 4_096
export const MAX_CHECKS = 64
export const MAX_COMMAND_ARGUMENTS = 128
export const MAX_COMMAND_ARGUMENT_CHARS = 4_096
const CheckOutput = Schema.String.check(Schema.isMaxLength(MAX_CHECK_OUTPUT_CHARS))
const CheckSummary = Schema.String.check(Schema.isMaxLength(MAX_CHECK_SUMMARY_CHARS))
const CommandArgument = Schema.String.check(Schema.isMaxLength(MAX_COMMAND_ARGUMENT_CHARS))
const VerifierField = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const CanonicalBase64Url = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256 * 1024),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
)

/**
 * Opaque signed evidence retained with an evidence-bearing settlement. Core's
 * verifier trust boundary must validate its canonical payload and signature;
 * schema decoding alone never makes the envelope trusted.
 */
export const ExecutionAttestation = Schema.Struct({
  schema: Schema.Literal("phins.verifier-execution-attestation-envelope.v1"),
  payload: CanonicalBase64Url,
  signature: CanonicalBase64Url,
}).annotate({
  identifier: "VerificationReceipt.ExecutionAttestation",
  parseOptions: { onExcessProperty: "error" },
})
export type ExecutionAttestation = typeof ExecutionAttestation.Type

export const Provenance = Schema.Struct({
  kind: Schema.Literal("signed-policy"),
  authorityID: VerifierField,
  keyID: Sha256Digest,
  revision: NonNegativeInt,
  policyDigest: Sha256Digest,
}).annotate({
  identifier: "VerificationReceipt.Provenance",
  parseOptions: { onExcessProperty: "error" },
})
export type Provenance = typeof Provenance.Type

export const Verifier = Schema.Struct({
  id: VerifierField,
  version: VerifierField,
  source: Schema.Literals(["task", "policy", "project"]),
  digest: Sha256Digest,
  provenance: Provenance.pipe(Schema.optional),
}).annotate({ identifier: "VerificationReceipt.Verifier" })
export type Verifier = typeof Verifier.Type

const CheckFields = Schema.Struct({
  id: Schema.String,
  command: Schema.Array(CommandArgument).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMAND_ARGUMENTS)),
  status: CheckStatus,
  exitCode: Schema.Int.pipe(Schema.optional),
  durationMs: NonNegativeInt,
  summary: CheckSummary.pipe(Schema.optional),
  stdout: CheckOutput.pipe(Schema.optional),
  stderr: CheckOutput.pipe(Schema.optional),
  outputTruncated: Schema.Boolean.pipe(Schema.optional),
  artifactRef: CommandArgument.pipe(Schema.optional),
})

export const Check = CheckFields.check(
  Schema.makeFilter<typeof CheckFields.Type>((value) => {
    if (value.status === "passed" && value.exitCode !== 0)
      return {
        path: ["exitCode"],
        issue: "passed check exitCode must be 0",
      }
    if (value.status === "failed" && (value.exitCode === undefined || value.exitCode === 0))
      return {
        path: ["exitCode"],
        issue: "failed check exitCode must be non-zero",
      }
    return undefined
  }),
).annotate({ identifier: "VerificationReceipt.Check" })
export type Check = typeof Check.Type

export const Checks = Schema.Array(Check).check(Schema.isMaxLength(MAX_CHECKS))
export type Checks = typeof Checks.Type

export const Subject = Schema.Struct({
  mutationEpoch: NonNegativeInt,
  snapshot: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "VerificationReceipt.Subject" })
export type Subject = typeof Subject.Type

export const Request = Schema.Struct({
  id: ID,
  assistantMessageID: SessionMessageID.ID.pipe(Schema.optional),
  locationKey: LocationKey,
  mode: Mode,
  subject: Subject,
  verifier: Verifier.pipe(Schema.optional),
}).annotate({ identifier: "VerificationReceipt.Request" })
export type Request = typeof Request.Type

type EvidenceShape = {
  readonly verdict: Verdict
  readonly verifier?: Verifier | undefined
  readonly checks: readonly Check[]
  readonly attestation?: ExecutionAttestation | undefined
}

const evidenceVerdicts = new Set<Verdict>(["passed", "failed", "error", "timeout"])

/** Canonical aggregate precedence: error > timeout > failed > passed. */
export const aggregateCheckVerdict = (checks: readonly Check[]): CheckStatus | undefined => {
  if (checks.some((check) => check.status === "error")) return "error"
  if (checks.some((check) => check.status === "timeout")) return "timeout"
  if (checks.some((check) => check.status === "failed")) return "failed"
  return checks.length > 0 ? "passed" : undefined
}

const evidenceIssues = (
  value: EvidenceShape,
  started: boolean,
  startedPath: readonly PropertyKey[],
  allowPinnedNonEvidenceVerifier: boolean,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (evidenceVerdicts.has(value.verdict)) {
    if (value.verifier === undefined)
      issues.push({
        path: ["verifier"],
        issue: `${value.verdict} requires a trusted verifier`,
      })
    const aggregate = aggregateCheckVerdict(value.checks)
    if (aggregate === undefined) {
      issues.push({
        path: ["checks"],
        issue: `${value.verdict} requires at least one verification check`,
      })
    } else if (aggregate !== value.verdict) {
      issues.push({
        path: ["checks"],
        issue: `check statuses aggregate to ${aggregate}, not ${value.verdict}`,
      })
    }
    if (!started)
      issues.push({
        path: [...startedPath],
        issue: `${value.verdict} requires verifier start time`,
      })
    return issues
  }

  if (
    value.verifier !== undefined &&
    !(allowPinnedNonEvidenceVerifier && (value.verdict === "stale" || value.verdict === "abandoned"))
  )
    issues.push({
      path: ["verifier"],
      issue: `${value.verdict} must not contain verifier evidence`,
    })
  if (value.checks.length > 0)
    issues.push({
      path: ["checks"],
      issue: `${value.verdict} must not contain verification checks`,
    })
  if (value.attestation !== undefined)
    issues.push({
      path: ["attestation"],
      issue: `${value.verdict} must not contain execution attestation evidence`,
    })
  if (started)
    issues.push({
      path: [...startedPath],
      issue: `${value.verdict} must not contain verifier start time`,
    })
  return issues
}

const SettlementFields = Schema.Struct({
  id: ID,
  verdict: Verdict,
  verifier: Verifier.pipe(Schema.optional),
  checks: Checks,
  reason: CheckSummary.pipe(Schema.optional),
  startedAt: DateTimeUtcFromMillis.pipe(Schema.optional),
  attestation: ExecutionAttestation.pipe(Schema.optional),
})

export const Settlement = SettlementFields.check(
  Schema.makeFilter<typeof SettlementFields.Type>((value) =>
    evidenceIssues(value, value.startedAt !== undefined, ["startedAt"], false),
  ),
).annotate({ identifier: "VerificationReceipt.Settlement" })
export type Settlement = typeof Settlement.Type

const ReceiptFields = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  assistantMessageID: SessionMessageID.ID.pipe(Schema.optional),
  locationKey: LocationKey,
  mode: Mode,
  subject: Subject,
  verifier: Verifier.pipe(Schema.optional),
  verdict: Verdict,
  checks: Checks,
  reason: CheckSummary.pipe(Schema.optional),
  attestation: ExecutionAttestation.pipe(Schema.optional),
  time: Schema.Struct({
    requested: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(Schema.optional),
    completed: DateTimeUtcFromMillis,
  }),
})

export const Receipt = ReceiptFields.check(
  Schema.makeFilter<typeof ReceiptFields.Type>((value) => {
    const issues = [...evidenceIssues(value, value.time.started !== undefined, ["time", "started"], true)]
    const requested = DateTime.toEpochMillis(value.time.requested)
    const completed = DateTime.toEpochMillis(value.time.completed)
    if (completed < requested)
      issues.push({
        path: ["time", "completed"],
        issue: "completion time must not precede request time",
      })
    if (value.time.started !== undefined) {
      const started = DateTime.toEpochMillis(value.time.started)
      if (started < requested || started > completed)
        issues.push({
          path: ["time", "started"],
          issue: "start time must be between request and completion time",
        })
    }
    return issues
  }),
).annotate({ identifier: "VerificationReceipt" })
export type Receipt = typeof Receipt.Type

/** Historical display data only; never an enforcement or freshness claim. */
export const HistoryItem = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  mode: Mode,
  verdict: Schema.Union([Verdict, Schema.Literal("pending")]),
  freshness: Schema.Literal("unverified"),
  time: Schema.Struct({
    requested: NonNegativeInt,
    completed: Schema.optionalKey(NonNegativeInt),
  }),
}).annotate({ identifier: "VerificationHistoryItem" })
export type HistoryItem = typeof HistoryItem.Type
export const HISTORY_LIMIT = 50
export const History = Schema.Array(HistoryItem).check(Schema.isMaxLength(HISTORY_LIMIT))
