/** Remove a release's unchanged files, never an enclosing project directory. */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, realpath, readlink, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const inventoryName = "INSTALL_MANIFEST.json"
type InstalledFile = { path: string; sha256: string }
type Launcher = { path: string; content: string; symlink: boolean }
export interface UninstallOptions {
  executable: string
  version: string
  profile: string
  all: boolean
  home?: string
}
export interface UninstallPlan {
  root: string
  executable: string
  files: InstalledFile[]
  launcher?: Launcher
  profile: string
  all: boolean
  preserved: string[]
}

const samePath = (a: string, b: string) => path.relative(a, b) === ""
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
const stat = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
})
async function digest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

/** Check every component before reading/deleting; do not follow a linked subtree. */
async function plainFile(root: string, name: string) {
  const rootInfo = await stat(root)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) return false
  let current = root
  const parts = name.split("/")
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = await stat(current)
    if (!info || info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return false
  }
  return samePath(await realpath(current), current)
}

async function idleProfile(profile: string) {
  const info = await stat(profile)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(profile), profile))
    throw new Error("Profile must be a real directory; linked profiles are preserved.")
  const registry = ".phins/state/agents"
  const names = await readdir(path.join(profile, registry)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return []
  })
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const relative = `${registry}/${name}`
    if (!(await plainFile(profile, relative))) throw new Error("Cannot verify runtime state; profile preserved.")
    const file = path.join(profile, relative)
    if ((await lstat(file)).size > 65_536) throw new Error("Invalid runtime registration; profile preserved.")
    let value: { pid?: number }
    try { value = JSON.parse(await readFile(file, "utf8")) } catch {
      throw new Error("Invalid runtime registration; profile preserved.")
    }
    if (!value || !Number.isSafeInteger(value.pid) || value.pid! <= 1) throw new Error("Invalid runtime PID; profile preserved.")
    try { process.kill(value.pid!, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
    }
    throw new Error("A PHINs Agent runtime is still running. Close its sessions, then retry uninstall.")
  }
}

export async function inspectUninstall(options: UninstallOptions): Promise<UninstallPlan> {
  const executable = await realpath(options.executable)
  const root = path.dirname(executable)
  if (await stat(path.join(root, ".git")))
    throw new Error("Release directory is a Git repository; project files are preserved.")
  const binary = process.platform === "win32" ? "phins.exe" : "phins"
  if (path.basename(executable) !== binary || !(await plainFile(root, inventoryName)))
    throw new Error("Uninstall requires a release bundle with INSTALL_MANIFEST.json. Source checkouts and loose binaries are preserved.")
  const inventoryPath = path.join(root, inventoryName)
  if ((await lstat(inventoryPath)).size > 4_000_000) throw new Error("Installation manifest is too large.")
  let manifest: {
    formatVersion: number; version: string; target: string; files: InstalledFile[]
  }
  try { manifest = JSON.parse(await readFile(inventoryPath, "utf8")) } catch {
    throw new Error("Invalid installation manifest; no files removed.")
  }
  const platform = process.platform === "win32" ? "windows" : process.platform
  if (!manifest || manifest.formatVersion !== 1 || manifest.version !== options.version
    || manifest.target !== `${platform}-${process.arch}` || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > 10_000)
    throw new Error("Installation manifest does not match this release.")
  const names = new Set<string>()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || /[\\:\x00-\x1f\x7f]/.test(file.path)
      || file.path.split("/").some(part => !part || part === "." || part === "..")
      || path.isAbsolute(file.path) || file.path === inventoryName || names.has(file.path)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error("Unsafe installation manifest; no files removed.")
    names.add(file.path)
  }
  const binaryEntry = manifest.files.find(file => file.path === binary)
  if (!binaryEntry || await digest(executable) !== binaryEntry.sha256)
    throw new Error("Installed executable changed; no files removed.")
  const home = await realpath(options.home ?? os.homedir())
  const profile = path.resolve(options.profile)
  if (options.all) {
    const expected = path.join(home, ".phins-agent-cli")
    if (!samePath(profile, expected) || inside(root, profile) || inside(profile, root))
      throw new Error("--all only removes the default ~/.phins-agent-cli profile. Custom or overlapping profiles are preserved.")
    for (const [name, expectedPath] of [
      ["PHINS_CONFIG_DIR", path.join(profile, ".phins/config")],
      ["PHINS_TEST_MANAGED_CONFIG_DIR", path.join(profile, "managed")],
    ]) {
      if (process.env[name] && !samePath(path.resolve(process.env[name]!), expectedPath))
        throw new Error("Custom configuration paths are preserved; unset their overrides before using --all.")
    }
  }
  await idleProfile(profile)
  const files: InstalledFile[] = []
  const preserved: string[] = []
  for (const file of manifest.files) {
    if (await plainFile(root, file.path) && await digest(path.join(root, file.path)) === file.sha256) files.push(file)
    else preserved.push(file.path)
  }
  files.push({ path: inventoryName, sha256: await digest(inventoryPath) })
  const base = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "PHINsAgent") : path.join(home, ".local/share/phins-agent-cli")
  let launcher: Launcher | undefined
  if (samePath(root, path.join(base, `phins-${manifest.version}-${manifest.target}`))) {
    const receipt = ".phins-install"
    if (await plainFile(root, receipt) && /^[a-f0-9]{64}\s*$/.test(await readFile(path.join(root, receipt), "utf8")))
      files.push({ path: receipt, sha256: await digest(path.join(root, receipt)) })
    if (process.platform === "win32") {
      const command = path.join(base, "bin/phins.cmd")
      const entry = files.find(file => file.path === "phins.cmd")
      if (entry && await plainFile(root, entry.path)) {
        const content = (await readFile(path.join(root, entry.path), "utf8"))
          .replaceAll("%~dp0phins.exe", `%~dp0..\\${path.basename(root)}\\phins.exe`)
        if (await plainFile(base, "bin/phins.cmd") && await readFile(command, "utf8") === content)
          launcher = { path: command, content, symlink: false }
      }
    } else {
      const command = path.join(home, ".local/bin/phins")
      if ((await stat(command))?.isSymbolicLink() && samePath(await realpath(path.dirname(command)), path.dirname(command))) {
        const content = await readlink(command)
        if (samePath(path.resolve(path.dirname(command), content), executable)) launcher = { path: command, content, symlink: true }
      }
    }
  }
  return { root, executable, files, launcher, profile, all: options.all, preserved }
}

async function removeEmptyDirectories(plan: UninstallPlan) {
  const directories = new Set([plan.root])
  for (const file of plan.files) {
    let directory = path.dirname(path.join(plan.root, file.path))
    while (inside(plan.root, directory)) {
      directories.add(directory)
      if (samePath(directory, plan.root)) break
      directory = path.dirname(directory)
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    const info = await stat(directory)
    if (!info?.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) continue
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code!)) throw error
    })
  }
}

/** The Windows launcher runs this receipt only after the binary exits. */
async function windowsCleanup(plan: UninstallPlan, binary: InstalledFile) {
  const receipt = process.env.PHINS_UNINSTALL_RECEIPT
  if (!receipt || !path.isAbsolute(receipt)
    || !/^phins-uninstall-[0-9]+-[0-9]+\.ps1$/.test(path.basename(receipt))
    || !samePath(await realpath(path.dirname(receipt)), await realpath(os.tmpdir())))
    throw new Error("Use the release's phins.cmd launcher for Windows uninstall; nothing removed.")
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  const removeRoot = !inside(plan.root, await realpath(process.cwd()))
  const script = `$ErrorActionPreference = 'Stop'
try {
  $binary = ${literal(plan.executable)}
  $parent = Split-Path -LiteralPath $binary
  while ($parent) {
    if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory became a link.' }
    $next = Split-Path -LiteralPath $parent
    if ($next -eq $parent) { break }
    $parent = $next
  }
  if ((Get-Item -LiteralPath $binary -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Executable became a link.' }
  if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${binary.sha256}') { throw 'Executable changed; preserved.' }
  Remove-Item -LiteralPath $binary -Force
  $root = ${literal(plan.root)}
  if (${removeRoot ? "$true" : "$false"} -and -not (Get-ChildItem -LiteralPath $root -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $root }
  [Console]::Out.WriteLine('PHINs Agent uninstalled.')
} finally { Remove-Item -LiteralPath ${literal(receipt)} -Force -ErrorAction SilentlyContinue }
`
  await writeFile(receipt, script, { mode: 0o600, flag: "wx" })
  return { cancel: () => unlink(receipt) }
}

export async function removeInstallation(plan: UninstallPlan) {
  await idleProfile(plan.profile)
  const binary = plan.files.find(file => path.join(plan.root, file.path) === plan.executable)!
  if (!binary || !(await plainFile(plan.root, binary.path)) || await digest(plan.executable) !== binary.sha256)
    throw new Error("Executable changed since confirmation; no files removed.")
  const currentLauncher = process.platform === "win32" && process.env.PHINS_UNINSTALL_LAUNCHER
    ? await realpath(process.env.PHINS_UNINSTALL_LAUNCHER) : undefined
  if (process.platform === "win32") {
    const bundled = plan.files.find(file => file.path === "phins.cmd")
    const approved = currentLauncher && ((plan.launcher && samePath(currentLauncher, plan.launcher.path)
      && await readFile(currentLauncher, "utf8") === plan.launcher.content)
      || (bundled && samePath(currentLauncher, path.join(plan.root, bundled.path))
        && await digest(currentLauncher) === bundled.sha256))
    if (!approved) throw new Error("Windows launcher changed or is unrecognized; files are preserved.")
  }
  const helper = process.platform === "win32" ? await windowsCleanup(plan, binary) : undefined
  try {
    // Recheck all paths/hashes after confirmation. New/changed files are retained.
    for (const file of plan.files) {
      if (helper && file === binary) continue
      if (currentLauncher && samePath(path.join(plan.root, file.path), currentLauncher)) continue
      if (await plainFile(plan.root, file.path) && await digest(path.join(plan.root, file.path)) === file.sha256)
        await unlink(path.join(plan.root, file.path))
    }
    if (plan.launcher && (!currentLauncher || !samePath(plan.launcher.path, currentLauncher))) {
      const { path: file, content, symlink } = plan.launcher
      const info = await stat(file)
      if (samePath(await realpath(path.dirname(file)), path.dirname(file)) && (symlink ? info?.isSymbolicLink() && await readlink(file) === content
        : info?.isFile() && !info.isSymbolicLink() && await readFile(file, "utf8") === content)) await unlink(file)
    }
    if (plan.all) await rm(plan.profile, { recursive: true, force: true })
    await removeEmptyDirectories(plan)
    return { pendingWindowsExit: !!helper }
  } catch (error) {
    await helper?.cancel()
    throw error
  }
}
