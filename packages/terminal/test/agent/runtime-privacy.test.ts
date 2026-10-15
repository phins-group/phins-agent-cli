import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { privateRuntimeAcl, windowsRuntimePrivacy } from "../../src/agent/runtime-privacy"

const user = "S-1-5-21-100-200-300-1001"
const full = 0x1f01ff
const own = { sid: user, type: 0, rights: full }
const privateAcl = { user, owner: user, rules: [own] }

test("runtime ACL permits its user, SYSTEM and administrators", () => {
  expect(privateRuntimeAcl({ ...privateAcl, rules: [own,
    { sid: "S-1-5-18", type: 0, rights: full },
    { sid: "S-1-5-32-544", type: 0, rights: full },
  ] })).toBe(true)
})

test("runtime ACL rejects broad access and a foreign owner", () => {
  expect(privateRuntimeAcl({ ...privateAcl, rules: [own,
    { sid: "S-1-1-0", type: 0, rights: 1 },
  ] })).toBe(false)
  expect(privateRuntimeAcl({ ...privateAcl, owner: "S-1-5-21-100-200-300-1002" })).toBe(false)
})

test("empty, malformed and owner-inaccessible ACLs fail closed", () => {
  for (const acl of [null, {}, { ...privateAcl, rules: [] },
    { ...privateAcl, rules: [{ ...own, rights: "FullControl" }] },
    { ...privateAcl, rules: [{ ...own, rights: 1 }] },
    { ...privateAcl, rules: [{ ...own, type: 2 }] },
  ]) expect(privateRuntimeAcl(acl)).toBe(false)
})

test("a deny entry does not grant an untrusted principal access", () => {
  expect(privateRuntimeAcl({ ...privateAcl, rules: [own,
    { sid: "S-1-1-0", type: 1, rights: full },
  ] })).toBe(true)
})

test("inherit-only grants cannot prove access to the runtime itself", () => {
  expect(privateRuntimeAcl({ ...privateAcl, rules: [{ ...own, inheritOnly: true }] })).toBe(false)
})

test.skipIf(process.platform !== "win32")("native Windows ACL works without PowerShell and rejects an Everyone grant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-runtime-acl-"))
  const originalPath = process.env.PATH, originalModules = process.env.PSModulePath
  try {
    // A shell executable, profile and module loader are not part of ACL authority.
    process.env.PATH = ""
    process.env.PSModulePath = path.join(directory, "missing-modules")
    expect(await windowsRuntimePrivacy(directory, true)).toBe(true)
    const file = path.join(directory, "registration à space.json")
    await writeFile(file, "{}")
    expect(await windowsRuntimePrivacy(file)).toBe(true)
    // An independent OS tool mutates the ACL; the checker must detect it.
    execFileSync(path.join(process.env.SystemRoot!, "System32/icacls.exe"),
      [file, "/grant", "*S-1-1-0:R"], { windowsHide: true, timeout: 10_000, stdio: "pipe" })
    expect(await windowsRuntimePrivacy(file)).toBe(false)
    await expect(windowsRuntimePrivacy(file, true)).rejects.toThrow("Runtime directory")
    expect(await windowsRuntimePrivacy(directory)).toBe(true)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalModules === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = originalModules
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
