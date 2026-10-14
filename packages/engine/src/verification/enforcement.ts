export * as VerifierEnforcement from "./enforcement"

import { Context, Effect, Layer, Schema } from "effect"
import { ServiceGraph } from "../runtime/effect/service-graph"
import type { VerifierExecutionAttestation } from "./execution-attestation"

const MAX_FIELD_CHARS = 256
const MAX_PRINCIPAL_CHARS = 1_024
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/

export const ENV = Object.freeze({
  mode: "PHINS_VERIFICATION_MODE",
})

export const Mode = Schema.Literals(["shadow", "enforce"])
export type Mode = typeof Mode.Type

const Field = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FIELD_CHARS),
)
const Principal = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PRINCIPAL_CHARS),
)
const Sha256Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST))
const Revision = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0
      ? undefined
      : "ledger revision must be a non-negative safe integer",
  ),
)

/**
 * Versioned contract exposed by an injected external attestation verifier.
 * Environment variables cannot construct this capability.
 */
export const ExternalAttestationCapability = Schema.Struct({
  schema: Schema.Literal("phins.verifier-external-attestation-capability.v1"),
  settlementSchema: Schema.Literal("phins.verifier-execution-attestation.v1"),
  envelopeSchema: Schema.Literal(
    "phins.verifier-execution-attestation-envelope.v1",
  ),
  authorityID: Field,
  keyID: Sha256Digest,
  ledgerRevision: Revision,
  ledgerDigest: Sha256Digest,
  auditHeadDigest: Sha256Digest,
  verifierPrincipal: Principal,
  supervisorPrincipal: Principal,
  transport: Schema.Literal("external-supervisor"),
}).annotate({
  identifier: "VerifierEnforcement.ExternalAttestationCapability",
  parseOptions: { onExcessProperty: "error" },
})
export type ExternalAttestationCapability =
  typeof ExternalAttestationCapability.Type

const PrivilegeSeparationFields = Schema.Struct({
  schema: Schema.Literal("phins.verifier-privilege-separation-capability.v1"),
  agentPrincipal: Principal,
  verifierPrincipal: Principal,
  supervisorPrincipal: Principal,
  isolation: Schema.Literal("separate-os-principals"),
  snapshotControl: Schema.Literal("verifier-supervisor"),
  settlementControl: Schema.Literal("verifier-supervisor"),
})

/**
 * Versioned deployment boundary required before enforcement can be eligible.
 */
export const PrivilegeSeparationCapability = PrivilegeSeparationFields.check(
  Schema.makeFilter<typeof PrivilegeSeparationFields.Type>((value) => {
    const principals = new Set([
      value.agentPrincipal,
      value.verifierPrincipal,
      value.supervisorPrincipal,
    ])
    return principals.size === 3
      ? undefined
      : {
          path: ["supervisorPrincipal"],
          issue: "agent, verifier and supervisor principals must be distinct",
        }
  }),
).annotate({
  identifier: "VerifierEnforcement.PrivilegeSeparationCapability",
  parseOptions: { onExcessProperty: "error" },
})
export type PrivilegeSeparationCapability =
  typeof PrivilegeSeparationCapability.Type

export const ErrorReason = Schema.Literals([
  "configuration",
  "external-attestation",
  "privilege-separation",
])
export type ErrorReason = typeof ErrorReason.Type

export class Error extends Schema.TaggedErrorClass<Error>()(
  "VerifierEnforcement.Error",
  {
    reason: ErrorReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * These providers are code-level TCB adapters, not environment declarations.
 * Their readiness probes must actively validate the external service/boundary.
 */
export interface ExternalAttestationProvider {
  readonly descriptor: ExternalAttestationCapability
  readonly probe: () => Effect.Effect<void, unknown>
  /**
   * Ask the external supervisor for signed evidence over the exact candidate
   * settlement. The returned envelope is still untrusted until `verify` passes.
   */
  readonly attest: (
    input: VerifierExecutionAttestation.Expected,
  ) => Effect.Effect<VerifierExecutionAttestation.Envelope, unknown>
  /** Verify the actual signed settlement envelope at the admission boundary. */
  readonly verify: VerifierExecutionAttestation.Interface["verify"]
}

export interface PrivilegeSeparationProvider {
  readonly descriptor: PrivilegeSeparationCapability
  readonly probe: () => Effect.Effect<void, unknown>
}

export interface Providers {
  readonly attestation: ExternalAttestationProvider
  readonly privilegeSeparation: PrivilegeSeparationProvider
}

export interface Options {
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface Interface {
  /** Durable verification receipts only support shadow in this release. */
  readonly mode: "shadow"
  /** Runtime guard for the future completion/release enforcement path. */
  readonly assertEnforcementEligible: Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/VerifierEnforcement",
) {}

const unavailable = (message: string) =>
  new Error({
    reason: "configuration",
    message,
  })

const shadow = Service.of(
  Object.freeze({
    mode: "shadow" as const,
    assertEnforcementEligible: Effect.fail(
      unavailable("verification enforcement is unavailable in shadow mode"),
    ),
  }),
)

/**
 * Validate and actively probe code-level provider adapters. Passing this probe
 * is necessary but deliberately does not enable `enforce`: the durable receipt
 * mode and production dependency graph remain shadow-only in this release.
 */
export const probeProviders = Effect.fn("VerifierEnforcement.probeProviders")(
  function* (providers: Providers) {
    if (
      !Schema.is(ExternalAttestationCapability)(
        providers.attestation.descriptor,
      )
    )
      return yield* new Error({
        reason: "external-attestation",
        message: "external attestation provider descriptor is invalid",
      })
    if (
      !Schema.is(PrivilegeSeparationCapability)(
        providers.privilegeSeparation.descriptor,
      )
    )
      return yield* new Error({
        reason: "privilege-separation",
        message: "privilege separation provider descriptor is invalid",
      })

    const attestation = providers.attestation.descriptor
    const separation = providers.privilegeSeparation.descriptor
    if (
      attestation.verifierPrincipal !== separation.verifierPrincipal ||
      attestation.supervisorPrincipal !== separation.supervisorPrincipal
    )
      return yield* new Error({
        reason: "privilege-separation",
        message:
          "attestation key distribution and privilege separation principals do not match",
      })

    yield* providers.attestation.probe().pipe(
      Effect.mapError(
        (cause) =>
          new Error({
            reason: "external-attestation",
            message: "external attestation provider probe failed",
            cause,
          }),
      ),
    )
    yield* providers.privilegeSeparation.probe().pipe(
      Effect.mapError(
        (cause) =>
          new Error({
            reason: "privilege-separation",
            message: "privilege separation provider probe failed",
            cause,
          }),
      ),
    )
  },
)

/**
 * Resolve the requested verification mode. `enforce` is reserved but cannot
 * be activated while durable receipts remain shadow-only and the production
 * graph has no qualified external capability providers.
 */
export const loadFromEnvironment = Effect.fn(
  "VerifierEnforcement.loadFromEnvironment",
)(function* (options: Options = {}) {
  const value = (options.env ?? process.env)[ENV.mode]
  if (value === undefined || value === "shadow") return shadow
  if (value !== "enforce")
    return yield* unavailable(`${ENV.mode} must be unset, shadow, or enforce`)
  return yield* unavailable(
    "verification enforcement requires qualified external attestation and privilege separation providers; neither is wired in this release",
  )
})

export const layer = (options: Options = {}) =>
  Layer.effect(Service, loadFromEnvironment(options))

/** Production wiring has no enforcement capability provider in this release. */
export const defaultLayer = Layer.effect(
  Service,
  loadFromEnvironment().pipe(Effect.orDie),
)

export const node = ServiceGraph.node(defaultLayer, [])
