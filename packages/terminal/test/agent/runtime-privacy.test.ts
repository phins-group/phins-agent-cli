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

test.skipIf(process.platform !== "win32")("native Windows ACL protects inherited files and rejects an Everyone grant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-runtime-acl-"))
  try {
    expect(await windowsRuntimePrivacy(directory, true)).toBe(true)
    const file = path.join(directory, "registration.json")
    await writeFile(file, "{}")
    expect(await windowsRuntimePrivacy(file)).toBe(true)
    const script = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:PHINS_TEST_ACL_PATH
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
  [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:PHINS_TEST_ACL_PATH -AclObject $acl
`
    const env: NodeJS.ProcessEnv = { PHINS_TEST_ACL_PATH: file }
    for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE",
    "PATH", "PSModulePath", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramData", "SystemDrive"])
      if (process.env[name] !== undefined) env[name] = process.env[name]
    execFileSync(path.join(process.env.SystemRoot!,
      "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")],
    { env, windowsHide: true, timeout: 10_000, stdio: "pipe" })
    expect(await windowsRuntimePrivacy(file)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
