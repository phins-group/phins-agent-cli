export * as VerifierSettlementAdmission from "./settlement-admission"

import { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { EventBus } from "../runtime/events/bus"
import { ProjectRegistry } from "../workspace/projects/service"
import { SessionEvent } from "../contracts/events/session"
import { VerificationSettlementPublisher } from "../runtime/events/verification-publisher"
import { VerifierEnforcement } from "./enforcement"
import { VerifierExecutionAttestation } from "./execution-attestation"
import { VerifierRegistry } from "./registry"

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/

type SettlementData = EventBus.Data<
  typeof SessionEvent.VerificationSettled
>
type SettlementPayload = EventBus.Payload<
  typeof SessionEvent.VerificationSettled
>

export interface AttemptBinding {
  readonly receiptID: VerificationReceipt.ID
  readonly sessionID: SettlementData["sessionID"]
  readonly ownerID: string | undefined
  readonly ownerGeneration: number
  readonly timeoutMs: number
  readonly generation: number
  readonly token: string
  readonly claimedAtMs: number
  readonly expiresAtMs: number
}

export interface Input {
  readonly data: SettlementData
  readonly attempt: AttemptBinding
  readonly selection: VerifierRegistry.Selection
}

export interface DurableBinding {
  readonly request: VerificationReceipt.Request
  readonly attempt: AttemptBinding
  readonly projectID: ProjectRegistry.ID
}

/** Loads the request and full live attempt from an authoritative state store. */
export type BindingLoader = (
  attempt: AttemptBinding,
) => Effect.Effect<DurableBinding, unknown>

export type PublishOptions = Omit<EventBus.PublishOptions, "commit"> & {
  /**
   * Atomically consumes the exact attempt fence with the durable event. The
   * callback receives the same authoritative binding loaded before provider
   * verification, so its transaction can re-CAS that exact lease and subject.
   */
  readonly commit: (
    binding: DurableBinding,
    seq: number,
  ) => Effect.Effect<void>
}

export type ErrorReason = "binding" | "attestation"

export class Error extends Schema.TaggedErrorClass<Error>()(
  "VerifierSettlementAdmission.Error",
  {
    reason: Schema.Literals(["binding", "attestation"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface Interface {
  /**
   * Verify one evidence-bearing settlement against its exact durable request
   * and live attempt fence before the settlement publisher can commit it.
   */
  readonly settleEvidence: (
    input: Input,
    options: PublishOptions,
  ) => Effect.Effect<SettlementPayload, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/VerifierSettlementAdmission",
) {}

const bindingError = (message: string) =>
  new Error({
    reason: "binding",
    message,
  })

const validate = (input: Input, durable: DurableBinding) => {
  const { data } = input
  const { request, attempt, projectID } = durable
  if (!Schema.is(VerificationReceipt.Request)(request))
    throw bindingError("settlement request binding is invalid")
  if (!isDeepStrictEqual(attempt, input.attempt))
    throw bindingError("durable verifier attempt binding changed")
  if (!Schema.is(VerificationReceipt.Settlement)(data.settlement))
    throw bindingError("settlement evidence is invalid")
  const provenance = input.selection.verifier.provenance
  if (
    input.selection.plan.source !== "policy" ||
    provenance?.kind !== "signed-policy" ||
    !input.selection.projectRootIdentity
  )
    throw bindingError(
      "external attestation admission requires a root-bound signed-policy selection",
    )
  const selection = VerifierRegistry.pin(
    input.selection.plan,
    {
      projectID,
      projectRoot: input.selection.projectRoot,
      projectRootIdentity: input.selection.projectRootIdentity,
    },
    provenance,
  )
  if (
    !isDeepStrictEqual(selection, input.selection) ||
    !isDeepStrictEqual(selection.verifier, request.verifier)
  )
    throw bindingError(
      "durable request does not match the canonical verifier selection",
    )
  if (
    data.settlement.id !== request.id ||
    attempt.receiptID !== request.id ||
    attempt.sessionID !== data.sessionID
  )
    throw bindingError(
      "settlement, request and attempt identities do not match",
    )
  if (
    request.verifier === undefined ||
    (attempt.ownerID !== undefined && attempt.ownerID.length === 0) ||
    !Number.isSafeInteger(attempt.ownerGeneration) ||
    attempt.ownerGeneration < 0 ||
    !Number.isSafeInteger(attempt.timeoutMs) ||
    attempt.timeoutMs < 1 ||
    !Number.isSafeInteger(attempt.generation) ||
    attempt.generation < 1 ||
    attempt.token.length === 0 ||
    !Number.isSafeInteger(attempt.claimedAtMs) ||
    attempt.claimedAtMs < 0 ||
    !Number.isSafeInteger(attempt.expiresAtMs) ||
    attempt.expiresAtMs <= attempt.claimedAtMs ||
    !Schema.is(ProjectRegistry.ID)(projectID) ||
    !SHA256_DIGEST.test(selection.plan.executor.bundleDigest) ||
    selection.plan.containment.profile !== "linux-oci-v1"
  )
    throw bindingError("settlement execution binding is invalid")

  const completedAtMs = DateTime.toEpochMillis(data.timestamp)
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0)
    throw bindingError("settlement completion time is invalid")

  return {
    sessionID: data.sessionID,
    completedAtMs,
    settlement: data.settlement,
    request,
    attemptGeneration: attempt.generation,
    attemptToken: attempt.token,
    projectID,
    executorDigest: selection.plan.executor.bundleDigest,
    containmentProfile: selection.plan.containment.profile,
  }
}

const verifiedMatchesProvider = (
  verified: VerifierExecutionAttestation.Verified,
  providers: VerifierEnforcement.Providers,
) => {
  const attestation = providers.attestation.descriptor
  const separation = providers.privilegeSeparation.descriptor
  return (
    verified !== null &&
    typeof verified === "object" &&
    Number.isSafeInteger(verified.issuedAtMs) &&
    verified.issuedAtMs >= 0 &&
    Schema.is(VerifierExecutionAttestation.PrincipalEvidence)(
      verified.principals,
    ) &&
    verified.schema === attestation.settlementSchema &&
    verified.authorityID === attestation.authorityID &&
    verified.keyID === attestation.keyID &&
    verified.ledgerRevision === attestation.ledgerRevision &&
    verified.ledgerDigest === attestation.ledgerDigest &&
    verified.auditHeadDigest === attestation.auditHeadDigest &&
    SHA256_DIGEST.test(verified.attestationDigest) &&
    verified.principals.agentPrincipal === separation.agentPrincipal &&
    verified.principals.verifierPrincipal ===
      attestation.verifierPrincipal &&
    verified.principals.supervisorPrincipal ===
      attestation.supervisorPrincipal
  )
}

/**
 * Build the admission boundary only from explicit code-level providers. The
 * provider probes run before the service becomes available; environment values
 * cannot construct this service.
 */
export const build = Effect.fn("VerifierSettlementAdmission.build")(
  function* (
    providers: VerifierEnforcement.Providers,
    loadBinding: BindingLoader,
  ) {
    yield* VerifierEnforcement.probeProviders(providers)
    const publisher = yield* VerificationSettlementPublisher.Service

    return Service.of(
      Object.freeze({
        settleEvidence: (input: Input, options: PublishOptions) =>
          Effect.gen(function* () {
            const durable = yield* loadBinding(input.attempt).pipe(
              Effect.mapError(
                (cause) =>
                  new Error({
                    reason: "binding",
                    message:
                      "durable settlement request or attempt is unavailable",
                    cause,
                  }),
              ),
            )
            const binding = yield* Effect.try({
              try: () => validate(input, durable),
              catch: (cause) =>
                cause instanceof Error
                  ? cause
                  : bindingError("settlement admission binding is invalid"),
            })
            const separation = providers.privilegeSeparation.descriptor
            const expected = {
              ...binding,
              agentPrincipal: separation.agentPrincipal,
            }
            const envelope = input.data.settlement.attestation
              ? input.data.settlement.attestation
              : yield* providers.attestation.attest(expected).pipe(
                  Effect.mapError(
                    (cause) =>
                      new Error({
                        reason: "attestation",
                        message:
                          "external supervisor did not issue execution attestation",
                        cause,
                      }),
                  ),
                )
            const settlement = yield* Effect.try({
              try: () => {
                if (
                  !Schema.is(VerificationReceipt.ExecutionAttestation)(
                    envelope,
                  )
                )
                  throw new TypeError("invalid execution attestation envelope")
                const candidate = {
                  ...input.data.settlement,
                  attestation: envelope,
                }
                if (!Schema.is(VerificationReceipt.Settlement)(candidate))
                  throw new TypeError("invalid attested settlement")
                return candidate
              },
              catch: (cause) =>
                new Error({
                  reason: "attestation",
                  message:
                    "external supervisor returned an invalid execution attestation",
                  cause,
                }),
            })
            const admittedData = {
              ...input.data,
              settlement,
            }
            const verified = yield* providers.attestation
              .verify({
                ...expected,
                settlement,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new Error({
                      reason: "attestation",
                      message: "external execution attestation was rejected",
                      cause,
                    }),
                ),
              )
            if (!verifiedMatchesProvider(verified, providers))
              return yield* new Error({
                reason: "attestation",
                message:
                  "verified execution attestation does not match the admitted provider",
              })

            const { commit, ...publishOptions } = options
            return yield* publisher.settle(admittedData, {
              ...publishOptions,
              commit: (seq) => commit(durable, seq),
            })
          }),
      }),
    )
  },
)

/** No default layer exists: production remains shadow-only and fail closed. */
export const layer = (
  providers: VerifierEnforcement.Providers,
  loadBinding: BindingLoader,
) => Layer.effect(Service, build(providers, loadBinding))
