import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto"

const BASE64URL = /^[A-Za-z0-9_-]+$/

export const sha256 = (input: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(input).digest("hex")}` as const

/**
 * Minimal canonical JSON used by the verifier trust boundary. All signed
 * payload schemas are restricted to these JSON primitives and safe integers.
 */
export function canonicalJson(input: unknown): string {
  if (input === null) return "null"
  if (typeof input === "string" || typeof input === "boolean")
    return JSON.stringify(input)
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input))
      throw new TypeError("canonical signed payload numbers must be safe integers")
    return JSON.stringify(input)
  }
  if (Array.isArray(input))
    return `[${input.map((value) => canonicalJson(value)).join(",")}]`
  if (typeof input !== "object" || input === undefined)
    throw new TypeError("canonical signed payload contains a non-JSON value")

  const record = input as Record<string, unknown>
  const entries = Object.keys(record)
    .sort()
    .map((key) => {
      const value = record[key]
      if (value === undefined)
        throw new TypeError("canonical signed payload contains undefined")
      return `${JSON.stringify(key)}:${canonicalJson(value)}`
    })
  return `{${entries.join(",")}}`
}

export const canonicalBytes = (input: unknown) =>
  Buffer.from(canonicalJson(input), "utf8")

export function decodeCanonicalBase64Url(
  input: string,
  label: string,
): Buffer {
  if (!BASE64URL.test(input))
    throw new TypeError(`${label} must use unpadded base64url`)
  const decoded = Buffer.from(input, "base64url")
  if (decoded.length === 0 || decoded.toString("base64url") !== input)
    throw new TypeError(`${label} is not canonical base64url`)
  return decoded
}

export interface Ed25519PublicKey {
  readonly key: KeyObject
  readonly spki: Buffer
  readonly keyID: `sha256:${string}`
}

export function decodeEd25519Spki(
  encoded: string,
  label = "Ed25519 SPKI",
): Ed25519PublicKey {
  const spki = decodeCanonicalBase64Url(encoded, label)
  let key: KeyObject
  let canonical: Buffer
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" })
    canonical = Buffer.from(key.export({ format: "der", type: "spki" }))
  } catch {
    throw new TypeError(`${label} is not a valid public key`)
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError(`${label} must be Ed25519`)
  if (!canonical.equals(spki))
    throw new TypeError(
      `${label} must use canonical Ed25519 SubjectPublicKeyInfo DER`,
    )
  return Object.freeze({ key, spki: canonical, keyID: sha256(canonical) })
}

export interface SignedEnvelope {
  readonly payload: string
  readonly signature: string
}

export interface VerifiedEnvelope<A> {
  readonly value: A
  readonly payloadBytes: Buffer
  readonly payloadDigest: `sha256:${string}`
  readonly keyID: `sha256:${string}`
}

/** Verify the signature before parsing and require one canonical JSON form. */
export function verifyCanonicalEnvelope<A>(input: {
  readonly envelope: SignedEnvelope
  readonly publicKeySpki: string
  readonly decode: (input: unknown) => A
  readonly label: string
}): VerifiedEnvelope<A> {
  const payloadBytes = decodeCanonicalBase64Url(
    input.envelope.payload,
    `${input.label} payload`,
  )
  const signature = decodeCanonicalBase64Url(
    input.envelope.signature,
    `${input.label} signature`,
  )
  const publicKey = decodeEd25519Spki(
    input.publicKeySpki,
    `${input.label} public key`,
  )
  if (
    signature.length !== 64 ||
    !verifySignature(null, payloadBytes, publicKey.key, signature)
  )
    throw new TypeError(`${input.label} signature verification failed`)

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)
  } catch {
    throw new TypeError(`${input.label} payload is not valid UTF-8`)
  }
  let unknown: unknown
  try {
    unknown = JSON.parse(text)
  } catch {
    throw new TypeError(`${input.label} payload is not valid JSON`)
  }
  const value = input.decode(unknown)
  const canonical = canonicalBytes(value)
  if (!canonical.equals(payloadBytes))
    throw new TypeError(`${input.label} payload is not canonical JSON`)
  return Object.freeze({
    value,
    payloadBytes,
    payloadDigest: sha256(payloadBytes),
    keyID: publicKey.keyID,
  })
}
