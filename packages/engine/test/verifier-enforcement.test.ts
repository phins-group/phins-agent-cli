import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { VerifierEnforcement } from "../src/verification/enforcement"
import { it } from "./lib/effect"

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe("VerifierEnforcement", () => {
  it.effect(
    "defaults to shadow and keeps the runtime enforcement guard closed",
    () =>
      Effect.gen(function* () {
        const policy = yield* VerifierEnforcement.loadFromEnvironment({
          env: {},
        })
        expect(policy.mode).toBe("shadow")

        const error = yield* Effect.flip(policy.assertEnforcementEligible)
        expect(error).toBeInstanceOf(VerifierEnforcement.Error)
        expect(error.reason).toBe("configuration")
      }),
  )

  it.effect("rejects unsupported mode configuration", () =>
    Effect.gen(function* () {
      for (const mode of ["", "off", "ENFORCE", "enforced"]) {
        const error = yield* Effect.flip(
          VerifierEnforcement.loadFromEnvironment({
            env: { [VerifierEnforcement.ENV.mode]: mode },
          }),
        )
        expect(error).toBeInstanceOf(VerifierEnforcement.Error)
        expect(error.reason).toBe("configuration")
      }
    }),
  )

  it.effect("rejects enforce because no qualified providers are wired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        VerifierEnforcement.loadFromEnvironment({
          env: {
            [VerifierEnforcement.ENV.mode]: "enforce",
            // Declarations in the environment must not create capabilities.
            PHINS_VERIFIER_EXTERNAL_ATTESTATION: "1",
            PHINS_VERIFIER_PRIVILEGE_SEPARATION: "1",
          },
        }),
      )
      expect(error).toBeInstanceOf(VerifierEnforcement.Error)
      expect(error.reason).toBe("configuration")
      expect(error.message).toContain("neither is wired")
    }),
  )

  it.effect(
    "defines strict versioned prerequisite descriptors without enabling them",
    () =>
      Effect.gen(function* () {
        const attestation = yield* Schema.decodeUnknownEffect(
          VerifierEnforcement.ExternalAttestationCapability,
        )({
          schema: "phins.verifier-external-attestation-capability.v1",
          settlementSchema: "phins.verifier-execution-attestation.v1",
          envelopeSchema:
            "phins.verifier-execution-attestation-envelope.v1",
          authorityID: "verifier-supervisor",
          keyID: digest("a"),
          ledgerRevision: 4,
          ledgerDigest: digest("b"),
          auditHeadDigest: digest("c"),
          verifierPrincipal: "uid:2001",
          supervisorPrincipal: "uid:2002",
          transport: "external-supervisor",
        })
        expect(attestation.settlementSchema).toBe(
          "phins.verifier-execution-attestation.v1",
        )

        const samePrincipal = yield* Effect.exit(
          Schema.decodeUnknownEffect(
            VerifierEnforcement.PrivilegeSeparationCapability,
          )({
            schema: "phins.verifier-privilege-separation-capability.v1",
            agentPrincipal: "uid:1000",
            verifierPrincipal: "uid:1000",
            supervisorPrincipal: "uid:2000",
            isolation: "separate-os-principals",
            snapshotControl: "verifier-supervisor",
            settlementControl: "verifier-supervisor",
          }),
        )
        expect(Exit.isFailure(samePrincipal)).toBe(true)

        const unsupportedVersion = yield* Effect.exit(
          Schema.decodeUnknownEffect(
            VerifierEnforcement.ExternalAttestationCapability,
          )({
            schema: "phins.verifier-external-attestation-capability.v2",
            settlementSchema: "phins.verifier-execution-attestation.v1",
            envelopeSchema:
              "phins.verifier-execution-attestation-envelope.v1",
            authorityID: "verifier-supervisor",
            keyID: digest("a"),
            ledgerRevision: 4,
            ledgerDigest: digest("b"),
            auditHeadDigest: digest("c"),
            verifierPrincipal: "uid:2001",
            supervisorPrincipal: "uid:2002",
            transport: "external-supervisor",
          }),
        )
        expect(Exit.isFailure(unsupportedVersion)).toBe(true)
      }),
  )

  it.effect("probes matching code-level providers without opening enforcement", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const providers: VerifierEnforcement.Providers = {
        attestation: {
          descriptor: {
            schema: "phins.verifier-external-attestation-capability.v1",
            settlementSchema:
              "phins.verifier-execution-attestation.v1",
            envelopeSchema:
              "phins.verifier-execution-attestation-envelope.v1",
            authorityID: "verifier-supervisor",
            keyID: digest("a"),
            ledgerRevision: 4,
            ledgerDigest: digest("b"),
            auditHeadDigest: digest("c"),
            verifierPrincipal: "uid:2001",
            supervisorPrincipal: "uid:2002",
            transport: "external-supervisor",
          },
          probe: () => Effect.sync(() => void calls.push("attestation")),
          attest: () => Effect.die("unused attestation fixture"),
          verify: () => Effect.die("unused verification fixture"),
        },
        privilegeSeparation: {
          descriptor: {
            schema: "phins.verifier-privilege-separation-capability.v1",
            agentPrincipal: "uid:1001",
            verifierPrincipal: "uid:2001",
            supervisorPrincipal: "uid:2002",
            isolation: "separate-os-principals",
            snapshotControl: "verifier-supervisor",
            settlementControl: "verifier-supervisor",
          },
          probe: () => Effect.sync(() => void calls.push("separation")),
        },
      }

      yield* VerifierEnforcement.probeProviders(providers)
      expect(calls).toEqual(["attestation", "separation"])

      const mismatch = yield* Effect.flip(
        VerifierEnforcement.probeProviders({
          ...providers,
          privilegeSeparation: {
            ...providers.privilegeSeparation,
            descriptor: {
              ...providers.privilegeSeparation.descriptor,
              supervisorPrincipal: "uid:9999",
            },
          },
        }),
      )
      expect(mismatch.reason).toBe("privilege-separation")
    }),
  )

  it.effect("exposes a boot layer that rejects ineligible enforcement", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Layer.build(
          VerifierEnforcement.layer({
            env: { [VerifierEnforcement.ENV.mode]: "enforce" },
          }),
        ).pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
