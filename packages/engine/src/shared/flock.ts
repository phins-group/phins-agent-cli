import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  utimes,
} from "fs/promises"
import type { Stats } from "fs"
import { Effect } from "effect"
import { Hash } from "./hash"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    /** Reclaim a verified dead local owner without waiting for lease expiry. */
    recoverDeadOwner?: boolean
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    recoverDeadOwner: boolean
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owner = {
    token: string
    pid: number
    hostname: string
    createdAt: string
  }

  type Identity = {
    dev: number
    ino: number
  }

  type FileLease = {
    kind: "file"
    file: string
    identity: Identity
    owner: Owner
    mtimeMs: number
  }

  type LegacyLease = {
    kind: "legacy-directory"
    file: string
    identity: Identity
    owner: Owner
    mtimeMs: number
  }

  type LeaseState = FileLease | LegacyLease

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  function identity(info: Stats): Identity {
    return { dev: info.dev, ino: info.ino }
  }

  function sameIdentity(a: Identity, b: Identity) {
    return a.dev === b.dev && a.ino === b.ino
  }

  async function stats(file: string) {
    try {
      return await lstat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  function decodeOwner(raw: string): Owner | undefined {
    if (Buffer.byteLength(raw, "utf8") > 4_096) return

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      const value = parsed as Record<string, unknown>
      if (
        typeof value.token !== "string" ||
        value.token.length === 0 ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.hostname !== "string" ||
        value.hostname.length === 0 ||
        typeof value.createdAt !== "string" ||
        value.createdAt.length === 0
      )
        return

      return {
        token: value.token,
        pid: value.pid,
        hostname: value.hostname,
        createdAt: value.createdAt,
      }
    } catch {
      return
    }
  }

  async function readOwner(file: string) {
    return readFile(file, "utf8")
      .then(decodeOwner)
      .catch((err) => {
        const errCode = code(err)
        if (errCode === "ENOENT" || errCode === "ENOTDIR") return undefined
        throw err
      })
  }

  async function observe(file: string): Promise<LeaseState | undefined> {
    const info = await stats(file)
    if (!info) return

    if (info.isFile()) {
      const owner = await readOwner(file)
      if (!owner) return
      const current = await stats(file)
      if (!current || !current.isFile()) return
      if (!sameIdentity(identity(info), identity(current))) return
      return {
        kind: "file",
        file,
        identity: identity(current),
        owner,
        mtimeMs: current.mtimeMs,
      }
    }

    if (info.isDirectory()) {
      const metaPath = path.join(file, "meta.json")
      const heartbeatPath = path.join(file, "heartbeat")
      const owner = await readOwner(metaPath)
      if (!owner) return

      const heartbeat = await stats(heartbeatPath)
      const meta = await stats(metaPath)
      const current = await stats(file)
      if (!current || !current.isDirectory()) return
      if (!sameIdentity(identity(info), identity(current))) return

      return {
        kind: "legacy-directory",
        file,
        identity: identity(current),
        owner,
        mtimeMs: heartbeat?.mtimeMs ?? meta?.mtimeMs ?? current.mtimeMs,
      }
    }

    // Symlinks and special files are never followed or reclaimed.
    return
  }

  function ownerIsDead(owner: Owner) {
    if (owner.hostname !== os.hostname()) return false

    try {
      process.kill(owner.pid, 0)
      return false
    } catch (err) {
      // EPERM and unknown failures fail closed. Only ESRCH proves that the
      // recorded local process is gone.
      return code(err) === "ESRCH"
    }
  }

  function stale(lease: LeaseState, opts: Opts) {
    return (
      (opts.recoverDeadOwner || wall() - lease.mtimeMs > opts.staleMs) &&
      ownerIsDead(lease.owner)
    )
  }

  function sameLease(a: LeaseState, b: LeaseState) {
    return (
      a.kind === b.kind &&
      a.owner.token === b.owner.token &&
      sameIdentity(a.identity, b.identity)
    )
  }

  async function prepare(file: string, owner: Owner) {
    const candidate = `${file}.candidate-${process.pid}-${owner.token}`
    const handle = await open(candidate, "wx", 0o600)
    let complete = false

    try {
      await handle.writeFile(JSON.stringify(owner, null, 2), "utf8")
      await handle.sync()
      complete = true
    } finally {
      await handle.close().catch(() => undefined)
      if (!complete) await unlink(candidate).catch(() => undefined)
    }

    return candidate
  }

  async function claim(file: string): Promise<FileLease | undefined> {
    const owner: Owner = {
      token: randomUUID?.() ?? randomBytes(16).toString("hex"),
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }
    const candidate = await prepare(file, owner)

    try {
      try {
        // link(2) is the publication fence: it never replaces an existing
        // canonical claim, and the linked bytes were fully written and fsynced.
        await link(candidate, file)
      } catch (err) {
        if (code(err) === "EEXIST") return
        throw err
      }

      const info = await lstat(file)
      if (!info.isFile()) {
        throw new Error("Lock publication produced a non-file claim.")
      }

      const current = await readOwner(file)
      if (!current || current.token !== owner.token) {
        throw new Error("Lock publication could not verify its owner token.")
      }

      return {
        kind: "file",
        file,
        identity: identity(info),
        owner,
        mtimeMs: info.mtimeMs,
      }
    } finally {
      // A SIGKILL can leave candidates behind, but they are never canonical
      // and therefore never block another acquisition.
      await unlink(candidate).catch(() => undefined)
    }
  }

  async function removeFileLease(expected: FileLease) {
    const current = await observe(expected.file)
    if (!current || current.kind !== "file" || !sameLease(expected, current)) {
      return false
    }

    await unlink(expected.file)
    return true
  }

  async function refreshFileLease(expected: FileLease) {
    const current = await observe(expected.file)
    if (!current || current.kind !== "file" || !sameLease(expected, current)) {
      return false
    }

    const now = new Date()
    await utimes(expected.file, now, now)
    return true
  }

  async function removeStaleLease(
    expected: LeaseState,
    opts: Opts,
    breaker: FileLease,
  ) {
    const current = await observe(expected.file)
    if (!current || !sameLease(expected, current) || !stale(current, opts)) {
      return false
    }

    // The live breaker is the exclusive reaper. Move the exact generation to
    // a same-parent, uniquely-created quarantine before deleting anything.
    // Once renamed, later canonical generations cannot be touched by this
    // cleanup even if the reaper pauses for an arbitrary amount of time.
    const quarantineDir = await mkdtemp(current.file + ".reap-")
    const quarantine = path.join(quarantineDir, "lease")
    let renamed = false

    try {
      if (!(await refreshFileLease(breaker))) {
        throw new Error("Refusing to reap: breaker identity or token mismatch.")
      }
      await rename(current.file, quarantine)
      renamed = true
      const moved = await observe(quarantine)
      if (!moved || !sameLease(current, moved)) {
        throw new Error(
          "Refusing to reap: quarantined lock identity or token mismatch.",
        )
      }

      await rm(quarantineDir, { recursive: true, force: true })
    } finally {
      // An unused unique quarantine directory is never authoritative and is
      // safe to remove. A moved-but-unverified lease stays for operator review.
      if (!renamed) {
        await rm(quarantineDir, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    }
    return true
  }

  async function tryAcquireLock(
    lockfile: string,
    opts: Opts,
  ): Promise<Owned | { acquired: false }> {
    let owned = await claim(lockfile)
    if (!owned) {
      const observed = await observe(lockfile)
      if (!observed || !stale(observed, opts)) {
        return { acquired: false }
      }

      const breakerPath = lockfile + ".breaker"
      const breaker = await claim(breakerPath)
      if (!breaker) {
        // Breakers fail closed, including complete stale file claims. There is no
        // portable conditional unlink-by-inode primitive in Node: deleting an
        // observed stale breaker by path has an ABA race with a newly-published
        // live breaker. An abandoned breaker therefore needs operator recovery.
        return { acquired: false }
      }

      const breakerHeartbeat = setInterval(
        () => {
          void refreshFileLease(breaker).catch(() => undefined)
        },
        Math.max(100, Math.floor(opts.staleMs / 3)),
      )
      breakerHeartbeat.unref?.()

      try {
        await removeStaleLease(observed, opts, breaker)
      } finally {
        clearInterval(breakerHeartbeat)
        if (!(await removeFileLease(breaker))) {
          throw new Error(
            "Refusing to release: breaker is compromised (identity or token mismatch).",
          )
        }
      }

      // One bounded publication attempt after reclamation also works for a
      // non-waiting caller. link(2) still fences any intervening contender.
      owned = await claim(lockfile)
      if (!owned) return { acquired: false }
    }

    const lease = owned
    let timer: NodeJS.Timeout | undefined
    const startHeartbeat = (
      intervalMs = Math.max(100, Math.floor(opts.staleMs / 3)),
    ) => {
      if (timer) return
      timer = setInterval(() => {
        void refreshFileLease(lease).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (!(await removeFileLease(lease))) {
        throw new Error(
          "Refusing to release: lock is compromised (identity or token mismatch).",
        )
      }
    }

    return { acquired: true, startHeartbeat, release }
  }

  async function acquireLock(
    lockfile: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLock(lockfile, opts)
      if (res.acquired) return res

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(
    key: string,
    input: Options = {},
  ): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      recoverDeadOwner: input.recoverDeadOwner ?? false,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLock(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(
    key: string,
    fn: () => Promise<T>,
    input: Options = {},
  ) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  export const effect = Effect.fn("Flock.effect")(function* (
    key: string,
    input: Options = {},
  ) {
    return yield* Effect.acquireRelease(
      Effect.promise((signal) => Flock.acquire(key, { ...input, signal })).pipe(
        Effect.withSpan("Flock.acquire", {
          attributes: { key },
        }),
      ),
      (lock) =>
        Effect.promise(() => lock.release()).pipe(
          Effect.withSpan("Flock.release"),
        ),
    ).pipe(Effect.asVoid)
  })
}
