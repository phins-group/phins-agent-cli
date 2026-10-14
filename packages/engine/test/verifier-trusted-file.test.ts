import { describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TrustedFile } from "../src/verification/trusted-file"

const withDirectory = async <A>(use: (directory: string) => Promise<A>) => {
  const created = await mkdtemp(path.join(os.tmpdir(), "phins-trusted-file-"))
  const directory = await realpath(created)
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const reason = async (run: () => Promise<unknown>) => {
  let failure: unknown
  try {
    await run()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(TrustedFile.TrustedFileError)
  return (failure as TrustedFile.TrustedFileError).reason
}

describe("TrustedFile", () => {
  test("reads and hashes one canonical regular-file descriptor", () =>
    withDirectory(async (directory) => {
      const target = path.join(directory, "policy.json")
      await writeFile(target, "trusted-content", { mode: 0o700 })

      const read = await TrustedFile.read(target, 1_024)
      const digest = await TrustedFile.digest(target, 1_024)

      expect(Buffer.from(read.bytes).toString("utf8")).toBe("trusted-content")
      expect(digest.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(Buffer.from(digest.prefix).toString("utf8")).toBe("trus")
      expect(digest.identity).toEqual(read.identity)
      expect(Object.isFrozen(read.identity)).toBe(true)
      await TrustedFile.assertUnchanged(target, read.identity)
    }))

  test("rejects final and intermediate symlink aliases", () =>
    withDirectory(async (directory) => {
      const actual = path.join(directory, "actual")
      const target = path.join(actual, "policy.json")
      const finalAlias = path.join(directory, "policy-link.json")
      const directoryAlias = path.join(directory, "alias")
      await mkdir(actual)
      await writeFile(target, "trusted-content")
      await symlink(target, finalAlias)
      await symlink(actual, directoryAlias)

      expect(await reason(() => TrustedFile.read(finalAlias, 1_024))).toBe(
        "path",
      )
      expect(
        await reason(() =>
          TrustedFile.read(path.join(directoryAlias, "policy.json"), 1_024),
        ),
      ).toBe("path")
    }))

  test("rejects non-regular paths and bounds FIFO access without hanging", () =>
    withDirectory(async (directory) => {
      expect(await reason(() => TrustedFile.read(directory, 1_024))).toBe(
        "type",
      )
      if (process.platform !== "win32")
        expect(await reason(() => TrustedFile.read("/dev/null", 1_024))).toBe(
          "type",
        )

      if (process.platform === "win32") return
      const fifo = path.join(directory, "policy.fifo")
      const created = Bun.spawn(["mkfifo", fifo], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(await created.exited).toBe(0)
      const started = performance.now()
      expect(await reason(() => TrustedFile.read(fifo, 1_024))).toBe("type")
      expect(performance.now() - started).toBeLessThan(1_000)
    }))

  test("rejects oversized files before retaining their content", () =>
    withDirectory(async (directory) => {
      const target = path.join(directory, "oversized")
      await writeFile(target, Buffer.alloc(257, 0x61))
      expect(await reason(() => TrustedFile.read(target, 256))).toBe("size")
      expect(await reason(() => TrustedFile.digest(target, 256))).toBe("size")
    }))

  test("detects replacement, in-place writes, and mode changes", () =>
    withDirectory(async (directory) => {
      const target = path.join(directory, "runtime")
      const previous = path.join(directory, "runtime.previous")
      await writeFile(target, "first", { mode: 0o700 })
      const replaced = await TrustedFile.inspect(target)
      await rename(target, previous)
      await writeFile(target, "other", { mode: 0o700 })
      expect(
        await reason(() => TrustedFile.assertUnchanged(target, replaced)),
      ).toBe("changed")

      const modified = await TrustedFile.inspect(target)
      await writeFile(target, "muted", { mode: 0o700 })
      expect(
        await reason(() => TrustedFile.assertUnchanged(target, modified)),
      ).toBe("changed")

      const remoded = await TrustedFile.inspect(target)
      await chmod(target, 0o600)
      expect(
        await reason(() => TrustedFile.assertUnchanged(target, remoded)),
      ).toBe("changed")
    }))

  test("requires runtime paths to be outside process-user control", () =>
    withDirectory(async (directory) => {
      const owned = path.join(directory, "runtime")
      await writeFile(owned, "runtime", { mode: 0o500 })

      if (process.platform === "win32") {
        expect(
          await reason(() =>
            TrustedFile.assertOutsideProcessUserControl(owned),
          ),
        ).toBe("platform")
        return
      }
      expect(
        await reason(() => TrustedFile.assertOutsideProcessUserControl(owned)),
      ).toBe("ownership")

      if (process.geteuid?.() === 0) return
      const systemBinary = await realpath("/usr/bin/true")
      await TrustedFile.assertOutsideProcessUserControl(systemBinary)
    }))

  test("never returns torn bytes during concurrent atomic replacement", () =>
    withDirectory(async (directory) => {
      const target = path.join(directory, "policy.json")
      const pending = path.join(directory, "policy.pending")
      const first = Buffer.alloc(16 * 1024, 0x61)
      const second = Buffer.alloc(16 * 1024, 0x62)
      await writeFile(target, first, { mode: 0o600 })
      const initial = await TrustedFile.read(target, 32 * 1024)
      const observed: Buffer[] = [Buffer.from(initial.bytes)]
      let rejected = 0

      const writer = (async () => {
        for (let index = 0; index < 128; index++) {
          await writeFile(pending, index % 2 === 0 ? second : first, {
            mode: 0o600,
          })
          await rename(pending, target)
        }
      })()
      const readers = Array.from({ length: 32 }, async () => {
        for (let index = 0; index < 16; index++) {
          try {
            const result = await TrustedFile.read(target, 32 * 1024)
            observed.push(Buffer.from(result.bytes))
          } catch (error) {
            if (!(error instanceof TrustedFile.TrustedFileError)) throw error
            rejected++
          }
        }
      })
      await Promise.all([writer, ...readers])
      const final = await TrustedFile.read(target, 32 * 1024)
      observed.push(Buffer.from(final.bytes))

      expect(observed.length).toBeGreaterThan(0)
      expect(rejected).toBeGreaterThan(0)
      for (const bytes of observed) {
        expect(bytes.equals(first) || bytes.equals(second)).toBe(true)
      }
    }))
})
