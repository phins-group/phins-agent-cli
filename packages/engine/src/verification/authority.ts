export * as VerifierAuthority from "./authority"

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ProjectRegistry } from "../workspace/projects/service"
import { AbsolutePath } from "../shared/schema"
import { VerifierRegistry } from "./registry"
import { TrustedFile } from "./trusted-file"

const POLICY_SCHEMA = "phins.verifier-policy.v1"
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 1_024
const MAX_FIELD_CHARS = 256
const MAX_PROJECT_ROOT_BYTES = 4_096
const BASE64URL = /^[A-Za-z0-9_-]+$/
const CANONICAL_REVISION = /^(?:0|[1-9][0-9]*)$/
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

export const ENV = Object.freeze({
  bundle: "PHINS_VERIFIER_POLICY_BUNDLE",
  authorityID: "PHINS_VERIFIER_AUTHORITY_ID",
  authoritySpki: "PHINS_VERIFIER_AUTHORITY_SPKI",
  revision: "PHINS_VERIFIER_POLICY_REVISION",
  digest: "PHINS_VERIFIER_POLICY_DIGEST",
  required: "PHINS_VERIFIER_AUTHORITY_REQUIRED",
})

export type ErrorReason =
  | "configuration"
  | "read"
  | "envelope"
  | "key"
  | "signature"
  | "payload"
  | "authority"
  | "revision"
  | "digest"
  | "inactive"
  | "duplicate"
  | "root"

export class AuthorityError extends globalThis.Error {
  override readonly name = "VerifierAuthorityError"

  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message)
  }
}

const Base64Url = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) =>
    BASE64URL.test(value) ? undefined : "must use unpadded base64url",
  ),
)

const Envelope = Schema.Struct({
  payload: Base64Url,
  signature: Base64Url,
})

const SafeField = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FIELD_CHARS),
  Schema.makeFilter((value) =>
    SAFE_FIELD.test(value) ? undefined : "contains unsafe characters",
  ),
)

const SafeMillis = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0
      ? undefined
      : "must be a non-negative safe integer",
  ),
)

const ProjectRoot = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PROJECT_ROOT_BYTES),
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "must not contain NUL"
    if (Buffer.byteLength(value, "utf8") > MAX_PROJECT_ROOT_BYTES)
      return `must not exceed ${MAX_PROJECT_ROOT_BYTES} UTF-8 bytes`
    if (!path.isAbsolute(value)) return "must be absolute"
    if (path.normalize(value) !== value || path.resolve(value) !== value)
      return "must be normalized"
    return undefined
  }),
)

const PolicyPlan = VerifierRegistry.Plan.check(
  Schema.makeFilter((value) =>
    value.source === "policy"
      ? undefined
      : "signed policy plans must use policy source",
  ),
)

const Entry = Schema.Struct({
  projectID: ProjectRegistry.ID,
  projectRoot: ProjectRoot,
  plan: PolicyPlan,
})

const Payload = Schema.Struct({
  schema: Schema.Literal(POLICY_SCHEMA),
  authorityID: SafeField,
  revision: SafeMillis,
  notBeforeMs: SafeMillis,
  expiresAtMs: SafeMillis,
  entries: Schema.Array(Entry).check(Schema.isMaxLength(MAX_ENTRIES)),
})

export type PolicyPayload = typeof Payload.Type

export interface TrustedInput {
  readonly bundle: string
  readonly expectedAuthorityID: string
  readonly expectedRevision: number
  /** SHA-256 of the exact decoded signed payload bytes. */
  readonly expectedPolicyDigest: string
  /** Unpadded base64url encoding of an Ed25519 SubjectPublicKeyInfo DER value. */
  readonly authoritySpki: string
  readonly nowMs?: number
  readonly clock?: () => number
  /**
   * Strict by default. `null` preserves the legacy v2 path-only selection for
   * shadow-only callers; OCI/enforcement admission rejects that legacy form.
   */
  readonly projectRootInspector?:
    | VerifierRegistry.ProjectRootInspector
    | null
}

export interface EnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly nowMs?: number
  readonly clock?: () => number
}

const strictOptions = { errors: "all", onExcessProperty: "error" } as const

const decodeStrict = <A>(
  decode: (input: unknown) => A,
  input: unknown,
  reason: ErrorReason,
  message: string,
): A => {
  try {
    return decode(input)
  } catch {
    throw new AuthorityError(reason, message)
  }
}

const parseJson = (
  input: string,
  reason: ErrorReason,
  message: string,
): unknown => {
  try {
    return JSON.parse(input)
  } catch {
    throw new AuthorityError(reason, message)
  }
}

const decodeBase64Url = (input: string, reason: ErrorReason, label: string) => {
  if (!BASE64URL.test(input))
    throw new AuthorityError(reason, `${label} must use unpadded base64url`)
  const bytes = Buffer.from(input, "base64url")
  if (bytes.length === 0 || bytes.toString("base64url") !== input)
    throw new AuthorityError(reason, `${label} is not canonical base64url`)
  return bytes
}

const sha256 = (input: Uint8Array) =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`

const selectionKey = (projectID: ProjectRegistry.ID, projectRoot: string) =>
  JSON.stringify([projectID, projectRoot])

const immutableEmptyRegistry = Object.freeze(
  VerifierRegistry.Registry.of({
    select: (_input: VerifierRegistry.SelectInput) => Effect.succeed(undefined),
  }),
)

const asAuthorityError = (
  error: unknown,
  reason: ErrorReason,
  message: string,
) =>
  error instanceof AuthorityError ? error : new AuthorityError(reason, message)

/**
 * Verify and decode one signed policy bundle into an immutable exact-match
 * registry. Payload JSON is not parsed until its Ed25519 signature succeeds.
 */
export function make(input: TrustedInput): VerifierRegistry.Interface {
  if (Buffer.byteLength(input.bundle, "utf8") > MAX_BUNDLE_BYTES)
    throw new AuthorityError(
      "envelope",
      `policy bundle must not exceed ${MAX_BUNDLE_BYTES} UTF-8 bytes`,
    )

  const expectedAuthorityID = decodeStrict(
    (value) => Schema.decodeUnknownSync(SafeField)(value, strictOptions),
    input.expectedAuthorityID,
    "configuration",
    "expected authority ID is invalid",
  )
  const expectedRevision = decodeStrict(
    (value) => Schema.decodeUnknownSync(SafeMillis)(value, strictOptions),
    input.expectedRevision,
    "configuration",
    "expected policy revision is invalid",
  )
  if (!SHA256_DIGEST.test(input.expectedPolicyDigest))
    throw new AuthorityError(
      "configuration",
      "expected policy digest must be canonical sha256",
    )
  const envelope = decodeStrict(
    (value) => Schema.decodeUnknownSync(Envelope)(value, strictOptions),
    parseJson(
      input.bundle,
      "envelope",
      "policy bundle envelope is not valid JSON",
    ),
    "envelope",
    "policy bundle envelope is invalid",
  )
  const payloadBytes = decodeBase64Url(
    envelope.payload,
    "envelope",
    "policy payload",
  )
  const signature = decodeBase64Url(
    envelope.signature,
    "envelope",
    "policy signature",
  )
  const spki = decodeBase64Url(input.authoritySpki, "key", "authority SPKI")

  let publicKey
  let canonicalSpki: Buffer
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" })
    canonicalSpki = Buffer.from(
      publicKey.export({ format: "der", type: "spki" }),
    )
  } catch {
    throw new AuthorityError("key", "authority SPKI is not a valid public key")
  }
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new AuthorityError("key", "authority public key must be Ed25519")
  if (!canonicalSpki.equals(spki))
    throw new AuthorityError(
      "key",
      "authority SPKI must use canonical Ed25519 SubjectPublicKeyInfo DER",
    )
  if (
    signature.length !== 64 ||
    !verifySignature(null, payloadBytes, publicKey, signature)
  )
    throw new AuthorityError(
      "signature",
      "policy signature verification failed",
    )
  const policyDigest = sha256(payloadBytes)
  if (policyDigest !== input.expectedPolicyDigest)
    throw new AuthorityError(
      "digest",
      "signed policy digest does not match the trusted digest",
    )

  let payloadText: string
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)
  } catch {
    throw new AuthorityError(
      "payload",
      "signed policy payload is not valid UTF-8",
    )
  }
  const payload = decodeStrict(
    (value) => Schema.decodeUnknownSync(Payload)(value, strictOptions),
    parseJson(
      payloadText,
      "payload",
      "signed policy payload is not valid JSON",
    ),
    "payload",
    "signed policy payload is invalid",
  )
  if (payload.authorityID !== expectedAuthorityID)
    throw new AuthorityError(
      "authority",
      "signed policy authority does not match the trusted authority",
    )
  if (payload.revision !== expectedRevision)
    throw new AuthorityError(
      "revision",
      "signed policy revision does not match the trusted revision",
    )
  if (payload.expiresAtMs <= payload.notBeforeMs)
    throw new AuthorityError(
      "payload",
      "signed policy validity window is invalid",
    )

  const fixedNowMs = input.nowMs
  const clock =
    input.clock ?? (fixedNowMs === undefined ? Date.now : () => fixedNowMs)
  const assertActive = () => {
    const nowMs = clock()
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new AuthorityError(
        "configuration",
        "policy verification time must be a non-negative safe integer",
      )
    if (nowMs < payload.notBeforeMs)
      throw new AuthorityError("inactive", "signed policy is not active yet")
    if (nowMs >= payload.expiresAtMs)
      throw new AuthorityError("inactive", "signed policy has expired")
  }
  assertActive()

  const provenance = Object.freeze({
    kind: "signed-policy" as const,
    authorityID: payload.authorityID,
    keyID: sha256(canonicalSpki),
    revision: payload.revision,
    policyDigest,
  })
  const selections = new Map<string, VerifierRegistry.Selection>()
  for (const entry of payload.entries) {
    const selectionInput = {
      projectID: entry.projectID,
      projectRoot: AbsolutePath.make(entry.projectRoot),
    }
    const key = selectionKey(
      selectionInput.projectID,
      selectionInput.projectRoot,
    )
    if (selections.has(key))
      throw new AuthorityError(
        "duplicate",
        "signed policy contains a duplicate project and root entry",
      )
    let selection: VerifierRegistry.Selection
    try {
      selection = VerifierRegistry.pin(entry.plan, selectionInput, provenance)
    } catch (error) {
      throw asAuthorityError(
        error,
        "payload",
        "signed policy verifier plan is invalid",
      )
    }
    selections.set(key, selection)
  }
  const inspectProjectRoot =
    input.projectRootInspector === null
      ? undefined
      : (input.projectRootInspector ?? VerifierRegistry.inspectProjectRoot)

  return Object.freeze(
    VerifierRegistry.Registry.of({
      select: (selection: VerifierRegistry.SelectInput) =>
        Effect.gen(function* () {
          // A long-lived location must not keep using a policy after its signed
          // validity window closes.
          assertActive()
          if (!inspectProjectRoot)
            return selections.get(
              selectionKey(selection.projectID, selection.projectRoot),
            )
          const identity = yield* inspectProjectRoot(
            selection.projectRoot,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AuthorityError(
                  "root",
                  cause instanceof globalThis.Error
                    ? cause.message
                    : "failed to bind verifier project root identity",
                ),
            ),
            Effect.orDie,
          )
          const admitted = selections.get(
            selectionKey(selection.projectID, identity.canonicalPath),
          )
          if (!admitted) return undefined
          return VerifierRegistry.pin(
            admitted.plan,
            {
              projectID: selection.projectID,
              projectRoot: identity.canonicalPath,
              projectRootIdentity: identity,
            },
            provenance,
          )
        }),
    }),
  )
}

/** Load the signed authority exactly once while constructing its Layer. */
export const loadFromEnvironment = Effect.fn(
  "VerifierAuthority.loadFromEnvironment",
)(function* (options: EnvironmentOptions = {}) {
  const env = options.env ?? process.env
  const bundlePath = env[ENV.bundle]
  const expectedAuthorityID = env[ENV.authorityID]
  const authoritySpki = env[ENV.authoritySpki]
  const revisionText = env[ENV.revision]
  const expectedPolicyDigest = env[ENV.digest]
  const authorityRequired = env[ENV.required]
  if (authorityRequired !== undefined && authorityRequired !== "1")
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        `${ENV.required} must be unset or exactly 1`,
      ),
    )

  const configured = [
    bundlePath,
    expectedAuthorityID,
    authoritySpki,
    revisionText,
    expectedPolicyDigest,
  ].filter((value) => value !== undefined).length
  if (configured === 0) {
    if (authorityRequired === "1")
      return yield* Effect.fail(
        new AuthorityError(
          "configuration",
          "signed verifier authority is required but is not configured",
        ),
      )
    return immutableEmptyRegistry
  }
  if (
    configured !== 5 ||
    !bundlePath ||
    !expectedAuthorityID ||
    !authoritySpki ||
    revisionText === undefined ||
    !expectedPolicyDigest
  )
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        "signed verifier authority requires all five policy environment variables",
      ),
    )
  if (!CANONICAL_REVISION.test(revisionText))
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        "trusted policy revision must be a canonical non-negative integer",
      ),
    )
  if (!SHA256_DIGEST.test(expectedPolicyDigest))
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        "trusted policy digest must be canonical sha256",
      ),
    )
  const expectedRevision = Number(revisionText)
  if (!Number.isSafeInteger(expectedRevision))
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        "trusted policy revision must be a non-negative safe integer",
      ),
    )
  if (
    !path.isAbsolute(bundlePath) ||
    /[\0\r\n]/.test(bundlePath) ||
    path.resolve(bundlePath) !== bundlePath ||
    path.normalize(bundlePath) !== bundlePath
  )
    return yield* Effect.fail(
      new AuthorityError(
        "configuration",
        "verifier policy bundle path must be absolute and normalized",
      ),
    )

  const loaded = yield* Effect.tryPromise({
    try: () => TrustedFile.read(bundlePath, MAX_BUNDLE_BYTES),
    catch: (error) =>
      asAuthorityError(
        error,
        "read",
        "failed to securely read verifier policy bundle",
      ),
  })
  const bundle = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes),
    catch: (error) =>
      asAuthorityError(
        error,
        "read",
        "verifier policy bundle is not valid UTF-8",
      ),
  })
  return yield* Effect.try({
    try: () =>
      make({
        bundle,
        expectedAuthorityID,
        expectedRevision,
        expectedPolicyDigest,
        authoritySpki,
        nowMs: options.nowMs,
        clock: options.clock,
      }),
    catch: (error) =>
      asAuthorityError(error, "payload", "verifier policy bundle is invalid"),
  })
})

export const layer = (options: EnvironmentOptions = {}) =>
  Layer.effect(VerifierRegistry.Registry, loadFromEnvironment(options))

export const defaultLayer = Layer.effect(
  VerifierRegistry.Registry,
  loadFromEnvironment().pipe(Effect.orDie),
)
