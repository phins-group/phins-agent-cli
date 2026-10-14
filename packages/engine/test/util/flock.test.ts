import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { spawn } from "child_process"
import path from "path"
import os from "os"
import { Flock } from "../../src/shared/flock"
import { Hash } from "../../src/shared/hash"

type Msg = {
  key: string
  dir: string
  staleMs?: number
  timeoutMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/flock-worker.ts")

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flock-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function wait(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }

  throw new Error(`Timed out waiting for file: ${file}`)
}

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>(
    (resolve) => {
      const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
        cwd: root,
      })

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []

      proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
      proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))

      proc.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
      })
    },
  )
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const closed = new Promise<void>((resolve) =>
    proc.once("close", () => resolve()),
  )

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    await closed
    return
  }

  await new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
  await closed
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

describe("util.flock", () => {
  test("enforces mutual exclusion under process contention", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const done = path.join(tmp.path, "done.log")
    const active = path.join(tmp.path, "active")
    const key = "flock:stress"
    const n = 16

    const out = await Promise.all(
      Array.from({ length: n }, () =>
        run({
          key,
          dir,
          done,
          active,
          holdMs: 30,
          staleMs: 1_000,
          timeoutMs: 15_000,
        }),
      ),
    )

    expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
    expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

    const lines = (await fs.readFile(done, "utf8"))
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
    expect(lines.length).toBe(n)
  }, 20_000)

  test("times out while waiting when lock is still healthy", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:timeout"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 10_000,
      timeoutMs: 30_000,
    })

    try {
      await wait(ready, 5_000)
      const seen: string[] = []
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 1_000,
        onWait: (tick) => {
          seen.push(tick.key)
        },
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      expect(err.message).toContain("Timed out waiting for lock")
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x === key)).toBe(true)
    } finally {
      await stopWorker(proc).catch(() => undefined)
    }
  }, 15_000)

  test("opt-in recovery reclaims a fresh dead owner, but never a live owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:dead-without-expiry"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 60_000,
    })
    try {
      await wait(ready, 5_000)
      const before = await fs.readFile(lock(dir, key), "utf8")
      await expect(
        Flock.acquire(key, { dir, timeoutMs: 0, recoverDeadOwner: true }),
      ).rejects.toThrow("Timed out")
      expect(await fs.readFile(lock(dir, key), "utf8")).toBe(before)
      await stopWorker(proc)
      await expect(Flock.acquire(key, { dir, timeoutMs: 0 })).rejects.toThrow(
        "Timed out",
      )
      const lease = await Flock.acquire(key, {
        dir,
        timeoutMs: 0,
        recoverDeadOwner: true,
      })
      try {
        expect(await fs.readFile(lock(dir, key), "utf8")).not.toBe(before)
      } finally {
        await lease.release()
      }
    } finally {
      await stopWorker(proc)
    }
  }, 10_000)

  test("recovers after a crashed lock owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:crash"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 500,
      timeoutMs: 30_000,
    })

    await wait(ready, 5_000)
    await stopWorker(proc)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 8_000,
      },
    )

    expect(hit).toBe(true)
  }, 20_000)

  test("acquires a reclaimed stale lease without a waiting budget", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-no-wait"
    const file = lock(dir, key)
    const exited = spawn(process.execPath, ["-e", "process.exit(0)"])
    const deadPid = exited.pid
    await new Promise<void>((resolve) => exited.once("close", () => resolve()))
    if (!deadPid) throw new Error("Test process did not have a PID")

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        token: "crashed-owner",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(file, old, old)

    await using lease = await Flock.acquire(key, {
      dir,
      staleMs: 200,
      timeoutMs: 0,
    })
    const owner = await readJson<{ token: string; pid: number }>(file)
    expect(owner.pid).toBe(process.pid)
    expect(owner.token).not.toBe("crashed-owner")
    expect(await exists(file + ".breaker")).toBe(false)
    expect(
      (await fs.readdir(dir)).some((name) => name.includes(".reap-")),
    ).toBe(false)
    // Even an expired heartbeat is insufficient while the owner is alive.
    await fs.utimes(file, old, old)
    await expect(
      Flock.acquire(key, { dir, staleMs: 200, timeoutMs: 0 }),
    ).rejects.toThrow("Timed out waiting for lock")
    expect(await readJson<typeof owner>(file)).toEqual(owner)
  })

  test("serializes contenders while quarantining a stale generation", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-contention"
    const lockfile = lock(dir, key)
    const active = path.join(tmp.path, "active")
    const done = path.join(tmp.path, "done.log")

    const exited = spawn(process.execPath, ["-e", "process.exit(0)"])
    const deadPid = exited.pid
    await new Promise<void>((resolve) => exited.once("close", () => resolve()))
    if (!deadPid) throw new Error("Test process did not have a PID")

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      lockfile,
      JSON.stringify({
        token: "stale-generation",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockfile, old, old)

    const out = await Promise.all(
      Array.from({ length: 8 }, () =>
        run({
          key,
          dir,
          active,
          done,
          holdMs: 30,
          staleMs: 200,
          timeoutMs: 10_000,
        }),
      ),
    )

    expect(out.map((result) => result.code)).toEqual(
      Array.from({ length: 8 }, () => 0),
    )
    expect(
      out.map((result) => result.stderr.toString()).filter(Boolean),
    ).toEqual([])
    expect((await fs.readFile(done, "utf8")).trim().split("\n").length).toBe(8)
    expect(
      (await fs.readdir(dir)).some((entry) => entry.includes(".reap-")),
    ).toBe(false)
  }, 20_000)

  test("ignores crash leftovers that were never published", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:unpublished"
    const lockfile = lock(dir, key)

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(lockfile + ".candidate-crashed", "partial")
    await fs.writeFile(lockfile + ".breaker.candidate-crashed", "partial")

    await Flock.withLock(
      key,
      async () => {
        const info = await fs.lstat(lockfile)
        expect(info.isFile()).toBe(true)
        expect(info.isDirectory()).toBe(false)
        const owner = await readJson<{ token?: unknown }>(lockfile)
        expect(typeof owner.token).toBe("string")
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )
  })

  test("fails closed for stale lock dirs with missing owner metadata", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:missing-heartbeat"
    const lockDir = lock(dir, key)

    await fs.mkdir(lockDir, { recursive: true })
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)

    const err = await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 500,
    }).catch((cause) => cause)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("Timed out waiting for lock")
  })

  test("fails closed when a stale breaker claim was left behind", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-breaker"
    const lockDir = lock(dir, key)
    const breaker = lockDir + ".breaker"

    const exited = spawn(process.execPath, ["-e", "process.exit(0)"])
    const deadPid = exited.pid
    await new Promise<void>((resolve) => exited.once("close", () => resolve()))
    if (!deadPid) throw new Error("Test process did not have a PID")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      lockDir,
      JSON.stringify({
        token: "abandoned",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )
    await fs.writeFile(
      breaker,
      JSON.stringify({
        token: "abandoned-breaker",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )

    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)
    await fs.utimes(breaker, old, old)

    const blocked = await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 500,
    }).catch((cause) => cause)

    expect(blocked).toBeInstanceOf(Error)
    expect((blocked as Error).message).toContain("Timed out waiting for lock")
    expect(await exists(breaker)).toBe(true)

    // Removing a complete stale breaker is an explicit operator action. The
    // next contender can then quarantine the stale canonical generation.
    await fs.rm(breaker)
    await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 3_000,
    })
  })

  test("migrates a complete stale directory lease", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:legacy-directory"
    const lockDir = lock(dir, key)

    const exited = spawn(process.execPath, ["-e", "process.exit(0)"])
    const deadPid = exited.pid
    await new Promise<void>((resolve) => exited.once("close", () => resolve()))
    if (!deadPid) throw new Error("Test process did not have a PID")

    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "meta.json"),
      JSON.stringify({
        token: "legacy-owner",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )
    await fs.writeFile(path.join(lockDir, "heartbeat"), "")
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(path.join(lockDir, "heartbeat"), old, old)

    await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 3_000,
    })

    expect(await exists(lockDir)).toBe(false)
  })

  test("fails clearly if lock dir is removed while held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:compromised"
    const lockDir = lock(dir, key)

    const err = await Flock.withLock(
      key,
      async () => {
        await fs.rm(lockDir, {
          recursive: true,
          force: true,
        })
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("compromised")

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )
    expect(hit).toBe(true)
  })

  test("writes owner metadata while lock is held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:meta"
    const file = lock(dir, key)

    await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{
          token?: unknown
          pid?: unknown
          hostname?: unknown
          createdAt?: unknown
        }>(file)

        expect(typeof json.token).toBe("string")
        expect(typeof json.pid).toBe("number")
        expect(typeof json.hostname).toBe("string")
        expect(typeof json.createdAt).toBe("string")
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    )
  })

  test("supports acquire with await using", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:acquire"
    const lockDir = lock(dir, key)

    {
      await using _ = await Flock.acquire(key, {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      })
      expect(await exists(lockDir)).toBe(true)
    }

    expect(await exists(lockDir)).toBe(false)
  })

  test("refuses token mismatch release and never steals from a live owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:token"
    const lockDir = lock(dir, key)
    const meta = lockDir

    const err = await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{ token?: string }>(meta)
        json.token = "tampered"
        await fs.writeFile(meta, JSON.stringify(json, null, 2))
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("token mismatch")
    expect(await exists(lockDir)).toBe(true)

    const blocked = await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 100,
      timeoutMs: 500,
    }).catch((cause) => cause)
    expect(blocked).toBeInstanceOf(Error)
    expect((blocked as Error).message).toContain("Timed out waiting for lock")
  })

  test("fails clearly on unwritable lock roots", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:perm"

    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o500)

    try {
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 100,
        timeoutMs: 500,
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      const text = err.message
      expect(text.includes("EACCES") || text.includes("EPERM")).toBe(true)
    } finally {
      await fs.chmod(dir, 0o700)
    }
  })
})
