export * as VerifierKeyLifecycle from "./key-lifecycle"

import path from "node:path"
import { Effect, Schema } from "effect"
import { TrustedFile } from "./trusted-file"
import { canonicalBytes, decodeEd25519Spki, sha256, verifyCanonicalEnvelope } from "./canonical-signature"

const LEDGER_SCHEMA = "phins.verifier-key-ledger.v1" as const
const EVENT_SCHEMA = "phins.verifier-key-event.v1" as const
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_EVENTS = 4_096
const MAX_FIELD_CHARS = 1_024
const MAX_AUTHORITY_CHARS = 256
const MAX_COMPACT_BASE64URL_CHARS = 4_096
const CANONICAL_REVISION = /^(?:0|[1-9][0-9]*)$/
const SAFE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
export const GENESIS_DIGEST = `sha256:${"0".repeat(64)}` as const

const strictOptions = { errors: "all", onExcessProperty: "error" } as const

const Field = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FIELD_CHARS),
  Schema.makeFilter((value) => (SAFE_FIELD.test(value) ? undefined : "contains unsafe characters")),
)
const AuthorityField = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_AUTHORITY_CHARS),
  Schema.makeFilter((value) => (SAFE_FIELD.test(value) ? undefined : "contains unsafe characters")),
)
const CompactBase64Url = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_COMPACT_BASE64URL_CHARS),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
)
const BundlePayloadBase64Url = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_BUNDLE_BYTES),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
)
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SafeMillis = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "must be a non-negative safe integer",
  ),
)
const Sequence = SafeMillis

const EventBase = {
  schema: Schema.Literal(EVENT_SCHEMA),
  sequence: Sequence,
  previousEventDigest: Digest,
  eventDigest: Digest,
  occurredAtMs: SafeMillis,
}

export const Distributed = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("distributed"),
  keyID: Digest,
  publicKeySpki: CompactBase64Url,
  purpose: Schema.Literal("execution-attestation"),
  state: Schema.Literals(["active", "standby"]),
  verifierPrincipal: Field,
  supervisorPrincipal: Field,
  notBeforeMs: SafeMillis,
  expiresAtMs: SafeMillis,
}).annotate({ identifier: "VerifierKeyLifecycle.Distributed" })
export type Distributed = typeof Distributed.Type

export const Rotated = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("rotated"),
  fromKeyID: Digest,
  toKeyID: Digest,
}).annotate({ identifier: "VerifierKeyLifecycle.Rotated" })
export type Rotated = typeof Rotated.Type

export const Revoked = Schema.Struct({
  ...EventBase,
  type: Schema.Literal("revoked"),
  keyID: Digest,
  scope: Schema.Literals(["prospective", "all-history"]),
  reason: Schema.Literals(["compromise", "superseded", "operator", "emergency"]),
}).annotate({ identifier: "VerifierKeyLifecycle.Revoked" })
export type Revoked = typeof Revoked.Type

export const Event = Schema.Union([Distributed, Rotated, Revoked]).annotate({
  identifier: "VerifierKeyLifecycle.Event",
})
export type Event = typeof Event.Type
export type UnsignedEvent = Event extends infer Entry
  ? Entry extends Event
    ? Omit<Entry, "eventDigest">
    : never
  : never

export const Payload = Schema.Struct({
  schema: Schema.Literal(LEDGER_SCHEMA),
  authorityID: AuthorityField,
  rootKeyID: Digest,
  revision: Sequence,
  notBeforeMs: SafeMillis,
  expiresAtMs: SafeMillis,
  issuedAtMs: SafeMillis,
  events: Schema.Array(Event).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_EVENTS)),
  headEventDigest: Digest,
}).annotate({
  identifier: "VerifierKeyLifecycle.Payload",
  parseOptions: { onExcessProperty: "error" },
})
export type Payload = typeof Payload.Type

const Envelope = Schema.Struct({
  payload: BundlePayloadBase64Url,
  signature: CompactBase64Url,
})

export type ErrorReason =
  | "configuration"
  | "read"
  | "envelope"
  | "signature"
  | "payload"
  | "authority"
  | "revision"
  | "digest"
  | "audit-chain"
  | "key"
  | "inactive"
  | "revoked"

export class LifecycleError extends globalThis.Error {
  override readonly name = "VerifierKeyLifecycleError"

  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message)
  }
}

export interface TrustedInput {
  readonly bundle: string
  readonly expectedAuthorityID: string
  readonly expectedRevision: number
  readonly expectedLedgerDigest: string
  /** Canonical unpadded base64url Ed25519 root SPKI. */
  readonly rootSpki: string
  readonly nowMs?: number
}

export interface EnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly nowMs?: number
}

export const ENV = Object.freeze({
  bundle: "PHINS_VERIFIER_KEY_LEDGER_BUNDLE",
  authorityID: "PHINS_VERIFIER_KEY_LEDGER_AUTHORITY_ID",
  rootSpki: "PHINS_VERIFIER_KEY_LEDGER_ROOT_SPKI",
  revision: "PHINS_VERIFIER_KEY_LEDGER_REVISION",
  digest: "PHINS_VERIFIER_KEY_LEDGER_DIGEST",
})

type Interval = { readonly start: number; end?: number }
type KeyState = {
  readonly keyID: `sha256:${string}`
  readonly publicKeySpki: string
  readonly verifierPrincipal: string
  readonly supervisorPrincipal: string
  readonly notBeforeMs: number
  readonly expiresAtMs: number
  readonly intervals: Interval[]
  revokedAtMs?: number
  invalidatesHistory?: boolean
}

export interface AttestationKey {
  readonly keyID: `sha256:${string}`
  readonly publicKeySpki: string
  readonly verifierPrincipal: string
  readonly supervisorPrincipal: string
}

export interface Interface {
  readonly authorityID: string
  readonly rootKeyID: `sha256:${string}`
  readonly revision: number
  readonly ledgerDigest: `sha256:${string}`
  readonly auditHeadDigest: `sha256:${string}`
  readonly notBeforeMs: number
  readonly expiresAtMs: number
  readonly assertActiveAt: (observedAtMs: number) => void
  readonly keyForAttestation: (keyID: string, issuedAtMs: number) => AttestationKey
}

const decodeStrict = <A>(decode: (input: unknown, options?: typeof strictOptions) => A, input: unknown): A =>
  decode(input, strictOptions)

const asLifecycleError = (error: unknown, reason: ErrorReason, message: string) =>
  error instanceof LifecycleError ? error : new LifecycleError(reason, message)

const eventWithoutDigest = (event: Event) => {
  const { eventDigest: _, ...commitment } = event
  return commitment
}

export const eventDigest = (event: UnsignedEvent | Event) => {
  const commitment = "eventDigest" in event ? eventWithoutDigest(event as Event) : event
  return sha256(canonicalBytes([EVENT_SCHEMA, commitment]))
}

const assertSafeTime = (value: number, message: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new LifecycleError("configuration", message)
}

const parseBundle = (bundle: string) => {
  if (Buffer.byteLength(bundle, "utf8") > MAX_BUNDLE_BYTES)
    throw new LifecycleError("envelope", `key ledger bundle must not exceed ${MAX_BUNDLE_BYTES} UTF-8 bytes`)
  let input: unknown
  try {
    input = JSON.parse(bundle)
  } catch {
    throw new LifecycleError("envelope", "key ledger envelope is not valid JSON")
  }
  try {
    return decodeStrict(Schema.decodeUnknownSync(Envelope), input)
  } catch {
    throw new LifecycleError("envelope", "key ledger envelope is invalid")
  }
}

/**
 * Verify a root-signed, complete append-only lifecycle ledger. Exact revision
 * and digest pins are mandatory; a valid same-revision transplant is rejected.
 */
export function make(input: TrustedInput): Interface {
  assertSafeTime(input.expectedRevision, "expected key ledger revision is invalid")
  const nowMs = input.nowMs ?? Date.now()
  assertSafeTime(nowMs, "key ledger verification time is invalid")
  if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedLedgerDigest))
    throw new LifecycleError("configuration", "expected key ledger digest is invalid")

  const root = (() => {
    try {
      return decodeEd25519Spki(input.rootSpki, "key ledger root SPKI")
    } catch (error) {
      throw asLifecycleError(error, "key", "key ledger root SPKI is invalid")
    }
  })()
  const envelope = parseBundle(input.bundle)
  const verified = (() => {
    try {
      return verifyCanonicalEnvelope({
        envelope,
        publicKeySpki: input.rootSpki,
        decode: (value) => decodeStrict(Schema.decodeUnknownSync(Payload), value),
        label: "key ledger",
      })
    } catch (error) {
      const message = error instanceof globalThis.Error ? error.message : "key ledger verification failed"
      const reason: ErrorReason = message.includes("signature") ? "signature" : "payload"
      throw asLifecycleError(error, reason, message)
    }
  })()
  const payload = verified.value
  if (payload.authorityID !== input.expectedAuthorityID)
    throw new LifecycleError("authority", "key ledger authority does not match the trusted authority")
  if (payload.rootKeyID !== root.keyID)
    throw new LifecycleError("key", "key ledger root key ID does not match its SPKI")
  if (payload.revision !== input.expectedRevision)
    throw new LifecycleError("revision", "key ledger revision does not match the trusted revision")
  if (verified.payloadDigest !== input.expectedLedgerDigest)
    throw new LifecycleError("digest", "key ledger digest does not match the trusted digest")
  if (
    payload.expiresAtMs <= payload.notBeforeMs ||
    payload.issuedAtMs < payload.notBeforeMs ||
    payload.issuedAtMs >= payload.expiresAtMs
  )
    throw new LifecycleError("payload", "key ledger validity window is invalid")
  const assertActiveAt = (observedAtMs: number) => {
    assertSafeTime(observedAtMs, "key ledger observation time is invalid")
    if (observedAtMs < payload.notBeforeMs || observedAtMs >= payload.expiresAtMs)
      throw new LifecycleError("inactive", "key ledger is not active")
  }
  assertActiveAt(nowMs)
  if (payload.revision !== payload.events.length - 1)
    throw new LifecycleError("audit-chain", "key ledger revision is not the complete event-chain head")

  const keys = new Map<string, KeyState>()
  let previous = GENESIS_DIGEST as string
  let previousTime = 0
  let activeKeyID: string | undefined
  for (const [index, event] of payload.events.entries()) {
    if (
      event.sequence !== index ||
      event.previousEventDigest !== previous ||
      event.eventDigest !== eventDigest(event) ||
      event.occurredAtMs < previousTime ||
      event.occurredAtMs > payload.issuedAtMs
    )
      throw new LifecycleError("audit-chain", "key ledger event chain is not contiguous and canonical")

    if (event.type === "distributed") {
      if (
        event.expiresAtMs <= event.notBeforeMs ||
        event.occurredAtMs >= event.expiresAtMs ||
        event.verifierPrincipal === event.supervisorPrincipal ||
        keys.has(event.keyID)
      )
        throw new LifecycleError("key", "distributed attestation key is invalid")
      const publicKey = (() => {
        try {
          return decodeEd25519Spki(event.publicKeySpki, "distributed attestation key SPKI")
        } catch (error) {
          throw asLifecycleError(error, "key", "distributed attestation key is invalid")
        }
      })()
      if (publicKey.keyID !== event.keyID) throw new LifecycleError("key", "distributed key ID does not match its SPKI")
      if (event.state === "active") {
        if (activeKeyID !== undefined || event.occurredAtMs < event.notBeforeMs)
          throw new LifecycleError("audit-chain", "key activation order is invalid")
        activeKeyID = event.keyID
      }
      keys.set(event.keyID, {
        keyID: publicKey.keyID,
        publicKeySpki: event.publicKeySpki,
        verifierPrincipal: event.verifierPrincipal,
        supervisorPrincipal: event.supervisorPrincipal,
        notBeforeMs: event.notBeforeMs,
        expiresAtMs: event.expiresAtMs,
        intervals: event.state === "active" ? [{ start: event.occurredAtMs }] : [],
      })
    } else if (event.type === "rotated") {
      const from = keys.get(event.fromKeyID)
      const to = keys.get(event.toKeyID)
      if (
        !from ||
        !to ||
        activeKeyID !== event.fromKeyID ||
        event.fromKeyID === event.toKeyID ||
        to.intervals.length > 0 ||
        to.revokedAtMs !== undefined ||
        event.occurredAtMs < to.notBeforeMs ||
        event.occurredAtMs >= to.expiresAtMs
      )
        throw new LifecycleError("audit-chain", "key rotation is invalid")
      const interval = from.intervals.at(-1)
      if (!interval || interval.end !== undefined)
        throw new LifecycleError("audit-chain", "rotated source key was not active")
      interval.end = event.occurredAtMs
      to.intervals.push({ start: event.occurredAtMs })
      activeKeyID = event.toKeyID
    } else {
      const key = keys.get(event.keyID)
      if (!key || key.revokedAtMs !== undefined) throw new LifecycleError("audit-chain", "key revocation is invalid")
      key.revokedAtMs = event.occurredAtMs
      key.invalidatesHistory = event.scope === "all-history"
      if (activeKeyID === event.keyID) {
        const interval = key.intervals.at(-1)
        if (!interval || interval.end !== undefined)
          throw new LifecycleError("audit-chain", "revoked key was not active")
        interval.end = event.occurredAtMs
        activeKeyID = undefined
      }
    }
    previous = event.eventDigest
    previousTime = event.occurredAtMs
  }
  if (payload.headEventDigest !== previous)
    throw new LifecycleError("audit-chain", "key ledger head digest does not match its event chain")

  const keyForAttestation = (keyID: string, issuedAtMs: number) => {
    assertSafeTime(issuedAtMs, "attestation issue time is invalid")
    assertActiveAt(issuedAtMs)
    const key = keys.get(keyID)
    if (!key) throw new LifecycleError("key", "attestation key is not distributed")
    if (key.invalidatesHistory)
      throw new LifecycleError("revoked", "attestation key revocation invalidates its history")
    if (
      issuedAtMs < key.notBeforeMs ||
      issuedAtMs >= key.expiresAtMs ||
      (key.revokedAtMs !== undefined && issuedAtMs >= key.revokedAtMs) ||
      !key.intervals.some(
        (interval) => issuedAtMs >= interval.start && (interval.end === undefined || issuedAtMs < interval.end),
      )
    )
      throw new LifecycleError("inactive", "attestation key was not active at the signed issue time")
    return Object.freeze({
      keyID: key.keyID,
      publicKeySpki: key.publicKeySpki,
      verifierPrincipal: key.verifierPrincipal,
      supervisorPrincipal: key.supervisorPrincipal,
    })
  }

  return Object.freeze({
    authorityID: payload.authorityID,
    rootKeyID: root.keyID,
    revision: payload.revision,
    ledgerDigest: verified.payloadDigest,
    auditHeadDigest: payload.headEventDigest as `sha256:${string}`,
    notBeforeMs: payload.notBeforeMs,
    expiresAtMs: payload.expiresAtMs,
    assertActiveAt,
    keyForAttestation,
  })
}

export const loadFromEnvironment = Effect.fn("VerifierKeyLifecycle.loadFromEnvironment")(function* (
  options: EnvironmentOptions = {},
) {
  const env = options.env ?? process.env
  const values = [env[ENV.bundle], env[ENV.authorityID], env[ENV.rootSpki], env[ENV.revision], env[ENV.digest]]
  const configured = values.filter((value) => value !== undefined).length
  if (configured === 0) return undefined
  if (configured !== values.length || values.some((value) => !value))
    return yield* Effect.fail(
      new LifecycleError("configuration", "key lifecycle trust requires all five environment variables"),
    )
  const [bundlePath, authorityID, rootSpki, revisionText, digest] = values as string[]
  if (
    !path.isAbsolute(bundlePath) ||
    path.normalize(bundlePath) !== bundlePath ||
    path.resolve(bundlePath) !== bundlePath ||
    /[\0\r\n]/.test(bundlePath)
  )
    return yield* Effect.fail(new LifecycleError("configuration", "key ledger path must be absolute and normalized"))
  if (!CANONICAL_REVISION.test(revisionText))
    return yield* Effect.fail(new LifecycleError("configuration", "key ledger revision must be canonical"))
  const revision = Number(revisionText)
  if (!Number.isSafeInteger(revision))
    return yield* Effect.fail(new LifecycleError("configuration", "key ledger revision is too large"))
  const loaded = yield* Effect.tryPromise({
    try: () => TrustedFile.read(bundlePath, MAX_BUNDLE_BYTES),
    catch: (error) => asLifecycleError(error, "read", "failed to securely read key ledger"),
  })
  const bundle = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes),
    catch: (error) => asLifecycleError(error, "read", "key ledger is not valid UTF-8"),
  })
  return yield* Effect.try({
    try: () =>
      make({
        bundle,
        expectedAuthorityID: authorityID,
        expectedRevision: revision,
        expectedLedgerDigest: digest,
        rootSpki,
        nowMs: options.nowMs,
      }),
    catch: (error) => asLifecycleError(error, "payload", "key ledger is invalid"),
  })
})
