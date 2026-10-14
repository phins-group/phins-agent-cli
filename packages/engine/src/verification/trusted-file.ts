export * as TrustedFile from "./trusted-file"

import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { access as accessPath, lstat, open, realpath } from "node:fs/promises"
import path from "node:path"

const READ_CHUNK_BYTES = 64 * 1024

export type ErrorReason =
  | "path"
  | "platform"
  | "open"
  | "type"
  | "size"
  | "changed"
  | "read"
  | "ownership"

export class TrustedFileError extends globalThis.Error {
  override readonly name = "TrustedFileError"

  constructor(
    readonly reason: ErrorReason,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface Identity {
  readonly path: string
  readonly dev: string
  readonly ino: string
  readonly mode: string
  readonly nlink: string
  readonly uid: string
  readonly gid: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly birthtimeNs: string
}

export interface ReadResult {
  readonly bytes: Uint8Array
  readonly identity: Identity
}

export interface DigestResult {
  readonly digest: `sha256:${string}`
  readonly identity: Identity
  readonly prefix: Uint8Array
}

const fail = (reason: ErrorReason, message: string, cause?: unknown): never => {
  throw new TrustedFileError(reason, message, cause)
}

const validatePath = (target: string) => {
  if (
    /[\0\r\n]/.test(target) ||
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    path.normalize(target) !== target
  ) {
    fail("path", "trusted file path must be absolute and normalized")
  }
}

const flags = () => {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    fail("platform", "trusted file no-follow access is unavailable")
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
}

const identity = (target: string, info: BigIntStats): Identity =>
  Object.freeze({
    path: target,
    dev: info.dev.toString(10),
    ino: info.ino.toString(10),
    mode: info.mode.toString(10),
    nlink: info.nlink.toString(10),
    uid: info.uid.toString(10),
    gid: info.gid.toString(10),
    size: info.size.toString(10),
    mtimeNs: info.mtimeNs.toString(10),
    ctimeNs: info.ctimeNs.toString(10),
    birthtimeNs: info.birthtimeNs.toString(10),
  })

const regularIdentity = (target: string, info: BigIntStats) => {
  if (!info.isFile()) return fail("type", "trusted path must be a regular file")
  return identity(target, info)
}

const sameIdentity = (left: Identity, right: Identity) =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.birthtimeNs === right.birthtimeNs

const inspectPath = async (target: string) => {
  let info: BigIntStats
  try {
    info = await lstat(target, { bigint: true })
  } catch (cause) {
    return fail("open", "failed to inspect trusted file", cause)
  }
  return regularIdentity(target, info)
}

const assertCanonical = async (target: string) => {
  let canonical: string
  try {
    canonical = await realpath(target)
  } catch (cause) {
    return fail("open", "failed to resolve trusted file", cause)
  }
  if (canonical !== target)
    return fail(
      "path",
      "trusted file path must be canonical and contain no symlink",
    )
}

const access = async <A>(
  target: string,
  use: (
    handle: Awaited<ReturnType<typeof open>>,
    initial: Identity,
  ) => Promise<A>,
) => {
  validatePath(target)
  await assertCanonical(target)
  const initial = await inspectPath(target)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, flags())
  } catch (cause) {
    if (cause instanceof TrustedFileError) throw cause
    return fail(
      "open",
      "failed to open trusted file without following links",
      cause,
    )
  }

  let result: { readonly value: A; readonly identity: Identity } | undefined
  let failure: TrustedFileError | undefined
  try {
    const opened = regularIdentity(target, await handle.stat({ bigint: true }))
    if (!sameIdentity(initial, opened))
      return fail("changed", "trusted file changed while it was opened")

    const value = await use(handle, opened)
    const after = regularIdentity(target, await handle.stat({ bigint: true }))
    if (!sameIdentity(opened, after))
      return fail("changed", "trusted file changed while it was in use")

    await assertCanonical(target)
    const linked = await inspectPath(target)
    if (!sameIdentity(after, linked))
      return fail("changed", "trusted path no longer names the opened file")
    result = { value, identity: after }
  } catch (cause) {
    failure =
      cause instanceof TrustedFileError
        ? cause
        : new TrustedFileError(
            "read",
            "failed to use trusted file descriptor",
            cause,
          )
  }

  try {
    await handle.close()
  } catch (cause) {
    if (!failure)
      failure = new TrustedFileError(
        "read",
        "failed to close trusted file descriptor",
        cause,
      )
  }
  if (failure) throw failure
  if (!result) return fail("read", "trusted file access produced no result")
  return result
}

const boundedChunks = async (
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void,
) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    return fail("size", "trusted file byte limit is invalid")

  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1))
  let observed = 0
  while (observed <= maxBytes) {
    const length = Math.min(buffer.length, maxBytes + 1 - observed)
    if (length === 0) break
    let bytesRead: number
    try {
      const result = await handle.read(buffer, 0, length, observed)
      bytesRead = result.bytesRead
    } catch (cause) {
      return fail("read", "failed to read trusted file descriptor", cause)
    }
    if (bytesRead === 0) break
    consume(buffer.subarray(0, bytesRead))
    observed += bytesRead
  }
  if (observed > maxBytes)
    return fail("size", `trusted file must not exceed ${maxBytes} bytes`)
  return observed
}

export async function read(
  target: string,
  maxBytes: number,
): Promise<ReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    return fail("size", "trusted file byte limit is invalid")
  const result = await access(target, async (handle, initial) => {
    if (BigInt(initial.size) > BigInt(maxBytes))
      return fail("size", `trusted file must not exceed ${maxBytes} bytes`)
    const chunks: Uint8Array[] = []
    const observed = await boundedChunks(handle, maxBytes, (chunk) => {
      chunks.push(Uint8Array.from(chunk))
    })
    if (BigInt(observed) !== BigInt(initial.size))
      return fail("changed", "trusted file size changed while it was read")
    return Buffer.concat(chunks)
  })
  return Object.freeze({ bytes: result.value, identity: result.identity })
}

export async function digest(
  target: string,
  maxBytes: number,
  prefixBytes = 4,
): Promise<DigestResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    return fail("size", "trusted file byte limit is invalid")
  if (
    !Number.isSafeInteger(prefixBytes) ||
    prefixBytes < 0 ||
    prefixBytes > READ_CHUNK_BYTES
  )
    return fail("size", "trusted file prefix limit is invalid")
  const result = await access(target, async (handle, initial) => {
    if (BigInt(initial.size) > BigInt(maxBytes))
      return fail("size", `trusted file must not exceed ${maxBytes} bytes`)
    const hash = createHash("sha256")
    const prefix = Buffer.alloc(Math.max(0, prefixBytes))
    let prefixLength = 0
    const observed = await boundedChunks(handle, maxBytes, (chunk) => {
      hash.update(chunk)
      if (prefixLength >= prefix.length) return
      const length = Math.min(prefix.length - prefixLength, chunk.byteLength)
      prefix.set(chunk.subarray(0, length), prefixLength)
      prefixLength += length
    })
    if (BigInt(observed) !== BigInt(initial.size))
      return fail("changed", "trusted file size changed while it was hashed")
    return {
      digest: `sha256:${hash.digest("hex")}` as const,
      prefix: Uint8Array.from(prefix.subarray(0, prefixLength)),
    }
  })
  return Object.freeze({
    digest: result.value.digest,
    identity: result.identity,
    prefix: result.value.prefix,
  })
}

export async function inspect(target: string): Promise<Identity> {
  const result = await access(target, async () => undefined)
  return result.identity
}

export async function assertUnchanged(
  target: string,
  expected: Identity,
): Promise<void> {
  const current = await inspect(target)
  if (!sameIdentity(current, expected))
    return fail("changed", "trusted file identity changed")
}

const permissionDenied = (cause: unknown) => {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return false
  return (
    cause.code === "EACCES" || cause.code === "EPERM" || cause.code === "EROFS"
  )
}

/**
 * Require the process user to neither own nor have write access to the trusted
 * file or any pathname ancestor. This does not identify or attest their owner.
 */
export async function assertOutsideProcessUserControl(
  target: string,
): Promise<void> {
  validatePath(target)
  await assertCanonical(target)
  const realUser = process.getuid?.()
  const effectiveUser = process.geteuid?.()
  const realGroup = process.getgid?.()
  const effectiveGroup = process.getegid?.()
  if (
    realUser === undefined ||
    effectiveUser === undefined ||
    realGroup === undefined ||
    effectiveGroup === undefined
  )
    return fail("platform", "trusted ownership checks are unavailable")
  if (realUser !== effectiveUser || realGroup !== effectiveGroup)
    return fail(
      "platform",
      "trusted ownership checks require matching real and effective IDs",
    )

  let current = target
  while (true) {
    let info: BigIntStats
    try {
      info = await lstat(current, { bigint: true })
    } catch (cause) {
      return fail("open", "failed to inspect trusted path ownership", cause)
    }
    if (info.uid === BigInt(effectiveUser))
      return fail(
        "ownership",
        "trusted path must not be owned by the process user",
      )

    let writable = true
    try {
      await accessPath(current, constants.W_OK)
    } catch (cause) {
      if (permissionDenied(cause)) writable = false
      else
        return fail("open", "failed to verify trusted path permissions", cause)
    }
    if (writable)
      return fail(
        "ownership",
        "trusted path must not be writable by the process user",
      )

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
