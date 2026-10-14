import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { EventBus } from "../src/runtime/events/bus"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { SessionEvent } from "../src/contracts/events/session"
import { VerifierEnforcement } from "../src/verification/enforcement"
import { VerifierExecutionAttestation } from "../src/verification/execution-attestation"
import { VerifierRegistry } from "../src/verification/registry"
import { VerifierSettlementAdmission } from "../src/verification/settlement-admission"
import { VerificationSettlementPublisher } from "../src/runtime/events/verification-publisher"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { SessionID } from "../src/contracts/session/id"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const receiptID = VerificationReceipt.ID.make("vrc_admission")
const sessionID = SessionID.make("ses_admission")
const projectID = ProjectRegistry.ID.make("project_admission")
const locationKey = VerificationReceipt.LocationKey.make("vloc_admission")
const completedAtMs = 3_000
const policyProvenance: VerificationReceipt.Provenance = {
  kind: "signed-policy",
  authorityID: "phins-policy-root",
  keyID: digest("a"),
  revision: 7,
  policyDigest: digest("1"),
}
const projectRootIdentity: VerifierRegistry.ProjectRootIdentity = {
  schema: "phins.verifier-project-root-identity.v1",
  canonicalPath: AbsolutePath.make("/project"),
  device: "7",
  inode: "11",
}
const selection = VerifierRegistry.pin(
  {
    id: "external-verifier",
    version: "1",
    source: "policy",
    check: {
      id: "unit",
      argv: ["pnpm", "test"],
      cwd: ".",
      timeoutMs: 120_000,
      maxOutputBytes: 16_384,
    },
    executor: {
      id: "external-executor",
      version: "1",
      bundleDigest: digest("b"),
    },
    containment: {
      subject: "snapshot-copy",
      filesystem: "read-only",
      network: "network-deny",
      environment: "sanitized-env",
      profile: "linux-oci-v1",
    },
  },
  {
    projectID,
    projectRoot: AbsolutePath.make("/project"),
    projectRootIdentity,
  },
  policyProvenance,
)
const verifier = selection.verifier
const request: VerificationReceipt.Request = {
  id: receiptID,
  locationKey,
  mode: "shadow",
  subject: { mutationEpoch: 7, snapshot: "tree_admitted" },
  verifier,
}
const durableAttempt: VerifierSettlementAdmission.AttemptBinding = {
  receiptID,
  sessionID,
  ownerID: "workspace-a",
  ownerGeneration: 5,
  timeoutMs: 120_000,
  generation: 3,
  token: "vat_00000000-0000-4000-8000-000000000001",
  claimedAtMs: 1_000,
  expiresAtMs: 181_000,
}
const unsignedSettlement: VerificationReceipt.Settlement = {
  id: receiptID,
  verdict: "passed",
  verifier,
  checks: [
    {
      id: "unit",
      command: ["pnpm", "test"],
      status: "passed",
      exitCode: 0,
      durationMs: 900,
    },
  ],
  startedAt: DateTime.makeUnsafe(2_000),
}
const signedSettlement: VerificationReceipt.Settlement = {
  ...unsignedSettlement,
  attestation: {
    schema: "phins.verifier-execution-attestation-envelope.v1",
    payload: "AA",
    signature: "AA",
  },
}

const data = (
  settlement: VerificationReceipt.Settlement,
): EventBus.Data<typeof SessionEvent.VerificationSettled> => ({
  sessionID,
  timestamp: DateTime.makeUnsafe(completedAtMs),
  settlement,
})

const input = (
  settlement: VerificationReceipt.Settlement,
): VerifierSettlementAdmission.Input => ({
  data: data(settlement),
  attempt: durableAttempt,
  selection,
})

const verified: VerifierExecutionAttestation.Verified = {
  schema: "phins.verifier-execution-attestation.v1",
  authorityID: "phins-attestation-root",
  keyID: digest("c"),
  ledgerRevision: 4,
  ledgerDigest: digest("d"),
  auditHeadDigest: digest("e"),
  attestationDigest: digest("f"),
  issuedAtMs: 3_100,
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
}

const providers = (
  verify: VerifierEnforcement.ExternalAttestationProvider["verify"],
  attest: VerifierEnforcement.ExternalAttestationProvider["attest"] = () =>
    Effect.die("unexpected attestation request"),
): VerifierEnforcement.Providers => ({
  attestation: {
    descriptor: {
      schema: "phins.verifier-external-attestation-capability.v1",
      settlementSchema: "phins.verifier-execution-attestation.v1",
      envelopeSchema:
        "phins.verifier-execution-attestation-envelope.v1",
      authorityID: verified.authorityID,
      keyID: verified.keyID,
      ledgerRevision: verified.ledgerRevision,
      ledgerDigest: verified.ledgerDigest,
      auditHeadDigest: verified.auditHeadDigest,
      verifierPrincipal: verified.principals.verifierPrincipal,
      supervisorPrincipal: verified.principals.supervisorPrincipal,
      transport: "external-supervisor",
    },
    probe: () => Effect.void,
    attest,
    verify,
  },
  privilegeSeparation: {
    descriptor: {
      schema: "phins.verifier-privilege-separation-capability.v1",
      agentPrincipal: verified.principals.agentPrincipal,
      verifierPrincipal: verified.principals.verifierPrincipal,
      supervisorPrincipal: verified.principals.supervisorPrincipal,
      isolation: "separate-os-principals",
      snapshotControl: "verifier-supervisor",
      settlementControl: "verifier-supervisor",
    },
    probe: () => Effect.void,
  },
})

const fixture = async (
  verify: VerifierEnforcement.ExternalAttestationProvider["verify"],
  attest?: VerifierEnforcement.ExternalAttestationProvider["attest"],
  loadBinding: VerifierSettlementAdmission.BindingLoader = () =>
    Effect.succeed({ request, attempt: durableAttempt, projectID }),
) => {
  let publishCalls = 0
  let commitCalls = 0
  const publisher = VerificationSettlementPublisher.Service.of({
    settle: (_data, options) =>
      Effect.gen(function* () {
        publishCalls++
        if (options?.commit) yield* options.commit(0)
        return undefined as never
      }),
  })
  const admission = await Effect.runPromise(
    VerifierSettlementAdmission.build(
      providers(verify, attest),
      loadBinding,
    ).pipe(
      Effect.provideService(
        VerificationSettlementPublisher.Service,
        publisher,
      ),
    ),
  )
  return {
    admission,
    publishCalls: () => publishCalls,
    commitCalls: () => commitCalls,
    commit: () => Effect.sync(() => void commitCalls++),
  }
}

describe("VerifierSettlementAdmission", () => {
  test("calls the provider with the exact request, attempt and subject binding before commit", async () => {
    let observed: VerifierExecutionAttestation.Expected | undefined
    const state = await fixture((expected) =>
      Effect.sync(() => {
        observed = expected
        return verified
      }),
    )

    await Effect.runPromise(
      state.admission.settleEvidence(input(signedSettlement), {
        commit: state.commit,
      }),
    )

    expect(observed).toMatchObject({
      sessionID,
      completedAtMs,
      request,
      attemptGeneration: 3,
      attemptToken: "vat_00000000-0000-4000-8000-000000000001",
      projectID,
      executorDigest: digest("b"),
      containmentProfile: "linux-oci-v1",
      agentPrincipal: "uid:1001",
    })
    expect(observed?.settlement).toEqual(signedSettlement)
    expect(state.publishCalls()).toBe(1)
    expect(state.commitCalls()).toBe(1)
  })

  test("requests a missing envelope and verifies it before commit", async () => {
    let requested: VerifierExecutionAttestation.Expected | undefined
    let verifiedInput: VerifierExecutionAttestation.Expected | undefined
    const state = await fixture(
      (expected) =>
        Effect.sync(() => {
          verifiedInput = expected
          return verified
        }),
      (expected) =>
        Effect.sync(() => {
          requested = expected
          return signedSettlement.attestation!
        }),
    )

    await Effect.runPromise(
      state.admission.settleEvidence(input(unsignedSettlement), {
        commit: state.commit,
      }),
    )

    expect(requested?.settlement.attestation).toBeUndefined()
    expect(requested).toMatchObject({
      request,
      attemptGeneration: 3,
      projectID,
    })
    expect(verifiedInput?.settlement.attestation).toEqual(
      signedSettlement.attestation,
    )
    expect(state.publishCalls()).toBe(1)
    expect(state.commitCalls()).toBe(1)
  })

  test("does not publish or commit when the supervisor omits attestation", async () => {
    let verifyCalls = 0
    const state = await fixture(
      () =>
        Effect.sync(() => {
          verifyCalls++
          return verified
        }),
      () => Effect.succeed(undefined as never),
    )

    await expect(
      Effect.runPromise(
        state.admission.settleEvidence(input(unsignedSettlement), {
          commit: state.commit,
        }),
      ),
    ).rejects.toThrow("invalid")
    expect(verifyCalls).toBe(0)
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("does not publish or commit an attestation rejected by the provider", async () => {
    let verifyCalls = 0
    const state = await fixture(() => {
      verifyCalls++
      return Effect.fail(
        new VerifierExecutionAttestation.AttestationError(
          "signature",
          "invalid signature",
        ),
      )
    })

    await expect(
      Effect.runPromise(
        state.admission.settleEvidence(input(signedSettlement), {
          commit: state.commit,
        }),
      ),
    ).rejects.toThrow("rejected")
    expect(verifyCalls).toBe(1)
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("does not publish a provider result outside its admitted descriptor", async () => {
    const state = await fixture(() =>
      Effect.succeed({
        ...verified,
        keyID: digest("9"),
      }),
    )

    await expect(
      Effect.runPromise(
        state.admission.settleEvidence(input(signedSettlement), {
          commit: state.commit,
        }),
      ),
    ).rejects.toThrow("does not match")
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("does not publish a malformed provider success value", async () => {
    const state = await fixture(() =>
      Effect.succeed({
        ...verified,
        issuedAtMs: -1,
      }),
    )

    await expect(
      Effect.runPromise(
        state.admission.settleEvidence(input(signedSettlement), {
          commit: state.commit,
        }),
      ),
    ).rejects.toThrow("does not match")
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("rejects every forged full-attempt field before provider admission", async () => {
    let verifyCalls = 0
    const state = await fixture(() =>
      Effect.sync(() => {
        verifyCalls++
        return verified
      }),
    )
    for (const attempt of [
      {
        ...durableAttempt,
        receiptID: VerificationReceipt.ID.make("vrc_other"),
      },
      { ...durableAttempt, ownerGeneration: 6 },
      { ...durableAttempt, timeoutMs: 120_001 },
      { ...durableAttempt, token: "vat_forged" },
      { ...durableAttempt, claimedAtMs: 999 },
      { ...durableAttempt, expiresAtMs: 181_001 },
    ])
      await expect(
        Effect.runPromise(
          state.admission.settleEvidence(
            { ...input(signedSettlement), attempt },
            { commit: state.commit },
          ),
        ),
      ).rejects.toThrow("changed")
    expect(verifyCalls).toBe(0)
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("ignores a caller-forged request and uses the durable loader subject", async () => {
    let observed: VerifierExecutionAttestation.Expected | undefined
    const state = await fixture((expected) =>
      Effect.sync(() => {
        observed = expected
        return verified
      }),
    )
    const forged = {
      ...input(signedSettlement),
      request: {
        ...request,
        subject: { mutationEpoch: 999, snapshot: "tree_forged" },
      },
    } as VerifierSettlementAdmission.Input

    await Effect.runPromise(
      state.admission.settleEvidence(forged, {
        commit: state.commit,
      }),
    )

    expect(observed?.request).toEqual(request)
    expect(observed?.request.subject).toEqual({
      mutationEpoch: 7,
      snapshot: "tree_admitted",
    })
  })

  test("rejects a forged executor outside the durable verifier digest", async () => {
    let verifyCalls = 0
    const state = await fixture(() =>
      Effect.sync(() => {
        verifyCalls++
        return verified
      }),
    )
    const forgedSelection = {
      ...selection,
      plan: {
        ...selection.plan,
        executor: {
          ...selection.plan.executor,
          bundleDigest: digest("9"),
        },
      },
    } as VerifierRegistry.Selection

    await expect(
      Effect.runPromise(
        state.admission.settleEvidence(
          { ...input(signedSettlement), selection: forgedSelection },
          { commit: state.commit },
        ),
      ),
    ).rejects.toThrow("canonical verifier selection")
    expect(verifyCalls).toBe(0)
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })

  test("rejects legacy or non-policy selections before any provider or publisher call", async () => {
    let attestCalls = 0
    let verifyCalls = 0
    const state = await fixture(
      () =>
        Effect.sync(() => {
          verifyCalls++
          return verified
        }),
      () =>
        Effect.sync(() => {
          attestCalls++
          return signedSettlement.attestation!
        }),
    )
    const legacy = VerifierRegistry.pin(selection.plan, {
      projectID,
      projectRoot: selection.projectRoot,
    })
    const nonPolicy = VerifierRegistry.pin(
      { ...selection.plan, source: "project" },
      {
        projectID,
        projectRoot: selection.projectRoot,
        projectRootIdentity,
      },
      policyProvenance,
    )

    for (const candidate of [legacy, nonPolicy])
      await expect(
        Effect.runPromise(
          state.admission.settleEvidence(
            { ...input(unsignedSettlement), selection: candidate },
            { commit: state.commit },
          ),
        ),
      ).rejects.toThrow("root-bound signed-policy")

    expect(attestCalls).toBe(0)
    expect(verifyCalls).toBe(0)
    expect(state.publishCalls()).toBe(0)
    expect(state.commitCalls()).toBe(0)
  })
})
