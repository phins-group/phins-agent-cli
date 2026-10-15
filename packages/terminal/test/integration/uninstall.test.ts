import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspectUninstall, removeInstallation } from "../../src/cli/uninstall"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(file => rm(file, { recursive: true, force: true })))
})
async function fixture(managed = false) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-uninstall-")))
  temporary.push(home)
  const platform = process.platform === "win32" ? "windows" : process.platform
  const target = `${platform}-${process.arch}`
  const version = "0.1.2-local"
  const binary = process.platform === "win32" ? "phins.exe" : "phins"
  const root = path.join(home, managed ? `.local/share/phins-agent-cli/phins-${version}-${target}` : "Extracted release à")
  const profile = path.join(home, ".phins-agent-cli")
  const project = path.join(home, "Real project")
  const executable = path.join(root, binary)
  await Promise.all([mkdir(path.join(root, "docs"), { recursive: true }), mkdir(profile), mkdir(project)])
  await writeFile(executable, "executable fixture")
  await writeFile(path.join(root, "docs/guide.md"), "release documentation")
  await writeFile(path.join(root, "NOTICE"), "release notices")
  await writeFile(path.join(profile, "config.json"), "private fixture settings")
  await writeFile(path.join(profile, "sessions.db"), "session fixture")
  await writeFile(path.join(project, "source.ts"), "user source")
  const manifest = { formatVersion: 1, version, target, files: [
    { path: binary, sha256: hash("executable fixture") },
    { path: "docs/guide.md", sha256: hash("release documentation") },
    { path: "NOTICE", sha256: hash("release notices") },
  ] }
  const save = () => writeFile(path.join(root, "INSTALL_MANIFEST.json"), JSON.stringify(manifest))
  await save()
  const options = { executable, profile, home, version, all: false }
  return { home, root, executable, profile, project, manifest, options, save }
}
const exists = (file: string) => Bun.file(file).exists()

test.skipIf(process.platform === "win32")("managed uninstall removes release and launcher, retaining profile, demo and projects", async () => {
  const f = await fixture(true)
  const launcher = path.join(f.home, ".local/bin/phins")
  await mkdir(path.dirname(launcher), { recursive: true })
  await symlink(f.executable, launcher)
  await writeFile(path.join(f.root, ".phins-install"), "a".repeat(64))
  const added = path.join(f.root, ".local/demo/source.js")
  await mkdir(path.dirname(added), { recursive: true })
  await writeFile(added, "user demo edits")
  const plan = await inspectUninstall(f.options)
  expect(plan.launcher?.path).toBe(launcher)
  expect(await removeInstallation(plan)).toEqual({ pendingWindowsExit: false, diagnostic: undefined })
  expect(await exists(f.executable)).toBe(false)
  expect(await readFile(launcher).catch(() => undefined)).toBeUndefined()
  expect(await exists(path.join(f.root, "NOTICE"))).toBe(false)
  expect(await readFile(added, "utf8")).toBe("user demo edits")
  expect(await exists(path.join(f.profile, "sessions.db"))).toBe(true)
  expect(await readFile(path.join(f.project, "source.ts"), "utf8")).toBe("user source")
})

test.skipIf(process.platform === "win32")("manual bundle uninstall removes only the release, including empty directories", async () => {
  const f = await fixture()
  await removeInstallation(await inspectUninstall(f.options))
  expect(await realpath(f.root).catch(() => undefined)).toBeUndefined()
  expect(await exists(path.join(f.profile, "config.json"))).toBe(true)
})

test.skipIf(process.platform === "win32")("--all deletes the default profile without following links into a project", async () => {
  const f = await fixture()
  await symlink(f.project, path.join(f.profile, "linked-project"))
  await removeInstallation(await inspectUninstall({ ...f.options, all: true }))
  expect(await realpath(f.profile).catch(() => undefined)).toBeUndefined()
  expect(await readFile(path.join(f.project, "source.ts"), "utf8")).toBe("user source")
})

test("--all refuses a custom profile", async () => {
  const f = await fixture()
  await expect(inspectUninstall({ ...f.options, all: true, profile: f.project })).rejects.toThrow("default")
  expect(await exists(f.executable)).toBe(true)
})

test("--all refuses external configuration overrides", async () => {
  const f = await fixture()
  const previous = process.env.PHINS_CONFIG_DIR
  process.env.PHINS_CONFIG_DIR = f.project
  try {
    await expect(inspectUninstall({ ...f.options, all: true })).rejects.toThrow("Custom configuration paths")
    expect(await exists(f.executable)).toBe(true)
    expect(await exists(path.join(f.project, "source.ts"))).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.PHINS_CONFIG_DIR
    else process.env.PHINS_CONFIG_DIR = previous
  }
})

test.skipIf(process.platform === "win32")("--all refuses a linked profile", async () => {
  const f = await fixture()
  await rm(f.profile, { recursive: true })
  await symlink(f.project, f.profile)
  await expect(inspectUninstall({ ...f.options, all: true })).rejects.toThrow("linked profiles")
  expect(await exists(f.executable)).toBe(true)
})

for (const name of ["../source.ts", "/outside", "docs/../source.ts", "docs\\source.ts", "C:source.ts", "docs//file", "docs/\0file"])
  test(`uninstall rejects unsafe manifest path ${JSON.stringify(name)}`, async () => {
    const f = await fixture()
    f.manifest.files.push({ path: name, sha256: hash("user source") })
    await f.save()
    await expect(inspectUninstall(f.options)).rejects.toThrow("Unsafe installation manifest")
    expect(await exists(f.executable)).toBe(true)
    expect(await exists(path.join(f.project, "source.ts"))).toBe(true)
  })

test("uninstall refuses duplicate manifest entries and mismatched releases", async () => {
  const f = await fixture()
  f.manifest.files.push(f.manifest.files[0])
  await f.save()
  await expect(inspectUninstall(f.options)).rejects.toThrow("Unsafe installation manifest")
  f.manifest.files.pop()
  f.manifest.version = "other release"
  await f.save()
  await expect(inspectUninstall(f.options)).rejects.toThrow("does not match")
})

test("loose/source binaries and changed executables cannot be uninstalled", async () => {
  const f = await fixture()
  await writeFile(f.executable, "changed executable")
  await expect(inspectUninstall(f.options)).rejects.toThrow("executable changed")
  await rm(path.join(f.root, "INSTALL_MANIFEST.json"))
  await expect(inspectUninstall(f.options)).rejects.toThrow("Source checkouts and loose binaries")
})

test.skipIf(process.platform === "win32")("modified files before and after confirmation are retained", async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, "NOTICE"), "user-modified notices")
  const plan = await inspectUninstall(f.options)
  expect(plan.preserved).toContain("NOTICE")
  await writeFile(path.join(f.root, "docs/guide.md"), "user modifications after confirmation")
  await removeInstallation(plan)
  expect(await readFile(path.join(f.root, "NOTICE"), "utf8")).toBe("user-modified notices")
  expect(await readFile(path.join(f.root, "docs/guide.md"), "utf8")).toBe("user modifications after confirmation")
})

test.skipIf(process.platform === "win32")("a linked release subtree never deletes its external target", async () => {
  const f = await fixture()
  await writeFile(path.join(f.project, "guide.md"), "release documentation")
  await rm(path.join(f.root, "docs"), { recursive: true })
  await symlink(f.project, path.join(f.root, "docs"))
  const plan = await inspectUninstall(f.options)
  expect(plan.preserved).toContain("docs/guide.md")
  await removeInstallation(plan)
  expect(await readFile(path.join(f.project, "guide.md"), "utf8")).toBe("release documentation")
})

test.skipIf(process.platform === "win32")("a bundle replaced by a link after confirmation is rejected", async () => {
  const f = await fixture()
  const plan = await inspectUninstall(f.options)
  await writeFile(path.join(f.project, "phins"), "executable fixture")
  await rm(f.root, { recursive: true })
  await symlink(f.project, f.root)
  await expect(removeInstallation(plan)).rejects.toThrow("changed since confirmation")
  expect(await readFile(path.join(f.project, "phins"), "utf8")).toBe("executable fixture")
})

test("a changed executable after confirmation prevents any removal", async () => {
  const f = await fixture()
  const plan = await inspectUninstall(f.options)
  await writeFile(f.executable, "changed after confirmation")
  await expect(removeInstallation(plan)).rejects.toThrow("changed since confirmation")
  expect(await exists(path.join(f.root, "NOTICE"))).toBe(true)
})

test.skipIf(process.platform === "win32")("an unrelated or replaced launcher is preserved", async () => {
  const f = await fixture(true)
  const launcher = path.join(f.home, ".local/bin/phins")
  await mkdir(path.dirname(launcher), { recursive: true })
  await symlink(f.executable, launcher)
  const plan = await inspectUninstall(f.options)
  await rm(launcher)
  await writeFile(launcher, "unrelated user command")
  await removeInstallation(plan)
  expect(await readFile(launcher, "utf8")).toBe("unrelated user command")
})

test("an active runtime blocks uninstall; errors disclose no registration contents", async () => {
  const f = await fixture()
  const directory = path.join(f.profile, ".phins/state/agents")
  await mkdir(directory, { recursive: true })
  const registration = path.join(directory, "a".repeat(64) + ".json")
  await writeFile(registration, JSON.stringify({ pid: process.pid }))
  await expect(inspectUninstall({ ...f.options, all: true })).rejects.toThrow("still running")
  expect(await exists(f.executable)).toBe(true)
  await writeFile(registration, "private-invalid-runtime-fixture")
  await expect(inspectUninstall(f.options)).rejects.toThrow("Invalid runtime registration; profile preserved.")
})

test("non-interactive CLI uninstall requires confirmation and never removes files", async () => {
  const f = await fixture()
  for (const args of [["uninstall"], ["uninstall", "--all"]]) {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), ...args], {
      cwd: f.home, env: { PATH: process.env.PATH, PHINS_TEST_HOME: f.profile,
        PHINS_DISABLE_MODELS_FETCH: "true" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const text = await new Response(child.stdout).text() + await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(text).toContain("Confirmation is required")
    expect(await exists(f.executable)).toBe(true)
    expect(await exists(path.join(f.profile, ".phins/config/config.json"))).toBe(false)
  }
})
