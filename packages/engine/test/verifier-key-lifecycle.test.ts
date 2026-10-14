import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { Effect } from "effect"
import { VerifierKeyLifecycle } from "../src/verification/key-lifecycle"
import { canonicalBytes, sha256 } from "../src/verification/canonical-signature"

const root = generateKeyPairSync("ed25519")
const first = generateKeyPairSync("ed25519")
const second = generateKeyPairSync("ed25519")
const spki = (key: typeof first.publicKey) => Buffer.from(key.export({ format: "der", type: "spki" }))
const encodedSpki = (key: typeof first.publicKey) => spki(key).toString("base64url")
const keyID = (key: typeof first.publicKey) => sha256(spki(key))
const nowMs = 10_000

type EventDraft = VerifierKeyLifecycle.Event extends infer Entry
  ? Entry extends VerifierKeyLifecycle.Event
    ? Omit<Entry, "eventDigest" | "sequence" | "previousEventDigest">
    : never
  : never

const append = (events: VerifierKeyLifecycle.Event[], event: EventDraft) => {
  const commitment = {
    ...event,
    sequence: events.length,
    previousEventDigest: events.at(-1)?.eventDigest ?? VerifierKeyLifecycle.GENESIS_DIGEST,
  } as VerifierKeyLifecycle.UnsignedEvent
  const complete = {
    ...commitment,
    eventDigest: VerifierKeyLifecycle.eventDigest(commitment),
  } as VerifierKeyLifecycle.Event
  events.push(complete)
  return complete
}

const lifecycle = () => {
  const events: VerifierKeyLifecycle.Event[] = []
  append(events, {
    schema: "phins.verifier-key-event.v1",
    type: "distributed",
    occurredAtMs: 1_000,
    keyID: keyID(first.publicKey),
    publicKeySpki: encodedSpki(first.publicKey),
    purpose: "execution-attestation",
    state: "active",
    verifierPrincipal: "uid:2001",
    supervisorPrincipal: "uid:2002",
    notBeforeMs: 500,
    expiresAtMs: 20_000,
  })
  append(events, {
    schema: "phins.verifier-key-event.v1",
    type: "distributed",
    occurredAtMs: 2_000,
    keyID: keyID(second.publicKey),
    publicKeySpki: encodedSpki(second.publicKey),
    purpose: "execution-attestation",
    state: "standby",
    verifierPrincipal: "uid:3001",
    supervisorPrincipal: "uid:3002",
    notBeforeMs: 1_500,
    expiresAtMs: 30_000,
  })
  append(events, {
    schema: "phins.verifier-key-event.v1",
    type: "rotated",
    occurredAtMs: 3_000,
    fromKeyID: keyID(first.publicKey),
    toKeyID: keyID(second.publicKey),
  })
  append(events, {
    schema: "phins.verifier-key-event.v1",
    type: "revoked",
    occurredAtMs: 4_000,
    keyID: keyID(first.publicKey),
    scope: "prospective",
    reason: "superseded",
  })
  return events
}

const signedLedger = (events = lifecycle(), overrides: Record<string, unknown> = {}) => {
  const payload = {
    schema: "phins.verifier-key-ledger.v1",
    authorityID: "phins-attestation-root",
    rootKeyID: keyID(root.publicKey),
    revision: events.length - 1,
    notBeforeMs: 100,
    expiresAtMs: 50_000,
    issuedAtMs: 5_000,
    events,
    headEventDigest: events.at(-1)!.eventDigest,
    ...overrides,
  }
  const bytes = canonicalBytes(payload)
  const bundle = JSON.stringify({
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, root.privateKey).toString("base64url"),
  })
  return {
    payload,
    bundle,
    digest: sha256(bytes),
  }
}

const trusted = (
  signed: ReturnType<typeof signedLedger>,
  overrides: Partial<VerifierKeyLifecycle.TrustedInput> = {},
) => ({
  bundle: signed.bundle,
  expectedAuthorityID: "phins-attestation-root",
  expectedRevision: signed.payload.revision,
  expectedLedgerDigest: signed.digest,
  rootSpki: encodedSpki(root.publicKey),
  nowMs,
  ...overrides,
})

describe("VerifierKeyLifecycle", () => {
  test("verifies the complete hash chain and historical rotation windows", () => {
    const signed = signedLedger()
    const ledger = VerifierKeyLifecycle.make(trusted(signed))

    expect(ledger.keyForAttestation(keyID(first.publicKey), 2_500)).toMatchObject({
      keyID: keyID(first.publicKey),
      verifierPrincipal: "uid:2001",
      supervisorPrincipal: "uid:2002",
    })
    expect(ledger.keyForAttestation(keyID(second.publicKey), 3_500)).toMatchObject({
      keyID: keyID(second.publicKey),
      verifierPrincipal: "uid:3001",
      supervisorPrincipal: "uid:3002",
    })
    expect(() => ledger.keyForAttestation(keyID(first.publicKey), 3_500)).toThrow("not active")
  })

  test("rejects rollback, same-revision transplant and a broken audit link", () => {
    const signed = signedLedger()
    expect(() => VerifierKeyLifecycle.make(trusted(signed, { expectedRevision: signed.payload.revision - 1 }))).toThrow(
      "revision",
    )
    expect(() =>
      VerifierKeyLifecycle.make(
        trusted(signed, {
          expectedLedgerDigest: `sha256:${"f".repeat(64)}`,
        }),
      ),
    ).toThrow("digest")

    const broken = lifecycle()
    broken[1] = {
      ...broken[1]!,
      previousEventDigest: `sha256:${"e".repeat(64)}`,
    }
    const brokenSigned = signedLedger(broken)
    expect(() => VerifierKeyLifecycle.make(trusted(brokenSigned))).toThrow("event chain")
  })

  test("all-history revocation invalidates older signatures", () => {
    const events = lifecycle()
    append(events, {
      schema: "phins.verifier-key-event.v1",
      type: "revoked",
      occurredAtMs: 6_000,
      keyID: keyID(second.publicKey),
      scope: "all-history",
      reason: "compromise",
    })
    const signed = signedLedger(events, { issuedAtMs: 7_000 })
    const ledger = VerifierKeyLifecycle.make(trusted(signed))

    expect(() => ledger.keyForAttestation(keyID(second.publicKey), 3_500)).toThrow("invalidates its history")
  })

  test("retains ledger validity and rechecks it for later attestations", () => {
    const signed = signedLedger(lifecycle(), { expiresAtMs: 6_000 })
    const ledger = VerifierKeyLifecycle.make(trusted(signed, { nowMs: 5_500 }))

    expect(ledger.notBeforeMs).toBe(100)
    expect(ledger.expiresAtMs).toBe(6_000)
    expect(() => ledger.assertActiveAt(5_999)).not.toThrow()
    expect(() => ledger.assertActiveAt(6_000)).toThrow("not active")
    expect(() => ledger.keyForAttestation(keyID(second.publicKey), 7_000)).toThrow("key ledger is not active")
  })

  test("accepts a valid signed ledger payload larger than four KiB", () => {
    const events = lifecycle()
    for (let index = 0; index < 16; index++) {
      const extra = generateKeyPairSync("ed25519")
      append(events, {
        schema: "phins.verifier-key-event.v1",
        type: "distributed",
        occurredAtMs: 4_100 + index,
        keyID: keyID(extra.publicKey),
        publicKeySpki: encodedSpki(extra.publicKey),
        purpose: "execution-attestation",
        state: "standby",
        verifierPrincipal: `uid:4${index.toString().padStart(3, "0")}`,
        supervisorPrincipal: `uid:5${index.toString().padStart(3, "0")}`,
        notBeforeMs: 4_000,
        expiresAtMs: 30_000,
      })
    }
    const signed = signedLedger(events)
    const envelope = JSON.parse(signed.bundle) as { payload: string }

    expect(envelope.payload.length).toBeGreaterThan(4_096)
    expect(VerifierKeyLifecycle.make(trusted(signed)).revision).toBe(events.length - 1)
  })

  test("rejects authority identifiers exceeding the shared bound", () => {
    const authorityID = "a".repeat(257)
    const signed = signedLedger(lifecycle(), { authorityID })

    expect(() => VerifierKeyLifecycle.make(trusted(signed, { expectedAuthorityID: authorityID }))).toThrow()
  })

  test("environment loading is all-or-none and never invents trust", async () => {
    expect(await Effect.runPromise(VerifierKeyLifecycle.loadFromEnvironment({ env: {} }))).toBeUndefined()
    await expect(
      Effect.runPromise(
        VerifierKeyLifecycle.loadFromEnvironment({
          env: { [VerifierKeyLifecycle.ENV.authorityID]: "partial" },
        }),
      ),
    ).rejects.toThrow("all five")
  })
})
