import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative))
}

/** Verify source provenance and integrity without needing the commercial checkout. */
export async function checkSource(root, manifest, { dependencies = true } = {}) {
  root = await realpath(root)
  const failures = []
  const known = new Set()
  let sourceFiles = 0
  for (const file of manifest.files) {
    const target = path.resolve(root, file.path)
    if (!within(root, target) || path.isAbsolute(file.path) || known.has(file.path)) {
      failures.push({ path: file.path, reason: "invalid manifest path" })
      continue
    }
    known.add(file.path)
    try {
      const stat = await lstat(target)
      if (!stat.isFile() || !within(root, await realpath(target)))
        throw new Error("source must be a regular file inside this repository")
      const sha256 = createHash("sha256").update(await readFile(target)).digest("hex")
      const adaptation = manifest.adaptations[file.path]
      if (sha256 !== (adaptation?.sha256 ?? file.sha256))
        throw new Error("source hash differs from the reviewed import/adaptation")
      sourceFiles++
    } catch (error) {
      failures.push({ path: file.path, reason: error.code === "ENOENT" ? "missing source" : error.message })
    }
  }
  for (const name of Object.keys(manifest.adaptations))
    if (!known.has(name)) failures.push({ path: name, reason: "adaptation has no source origin" })

  // Inventory the runnable source as well as checking its pinned hashes. This
  // catches accidental reintroduction of retired packages or unreviewed files.
  async function inventory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "__pycache__"].includes(item.name)
        || item.name.endsWith(".tsbuildinfo")) continue
      const target = path.join(directory, item.name)
      const relative = path.relative(root, target)
      if (item.isDirectory()) await inventory(target)
      else if (!known.has(relative) && !manifest.inventoryExclusions?.includes(relative))
        failures.push({ path: relative, reason: "unreviewed source file" })
    }
  }
  for (const directory of manifest.inventoryDirectories ?? []) {
    const target = path.resolve(root, directory)
    if (!within(root, target)) {
      failures.push({ path: directory, reason: "inventory escapes repository" })
      continue
    }
    const stat = await lstat(target).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      failures.push({ path: directory, reason: "invalid source inventory root" })
      continue
    }
    await inventory(target)
  }

  const packages = new Map()
  for (const directory of manifest.packages) {
    if (!within(root, path.resolve(root, directory))) {
      failures.push({ path: directory, reason: "package escapes repository" })
      continue
    }
    try {
      const pkg = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"))
      if (packages.has(pkg.name)) throw new Error("duplicate workspace package")
      packages.set(pkg.name, { directory, pkg })
    } catch {
      failures.push({ path: directory, reason: "missing or invalid workspace package" })
    }
  }
  for (const { directory, pkg } of packages.values()) {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies,
      ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (version.startsWith("workspace:") && !packages.has(name))
        failures.push({ path: directory, reason: `missing workspace dependency ${name}` })
    }
  }

  let dependencyLinks = 0
  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name)
      if (item.isSymbolicLink()) {
        dependencyLinks++
        const resolved = await realpath(target).catch(() => undefined)
        if (!resolved || !within(root, resolved))
          failures.push({ path: path.relative(root, target), reason: "external or broken dependency link" })
      } else if (item.isDirectory()) await inspect(target)
    }
  }
  if (dependencies) {
    for (const directory of [".", ...manifest.packages]) {
      const modules = path.join(root, directory, "node_modules")
      try {
        const stat = await lstat(modules)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid dependency root")
        await inspect(modules)
      } catch (error) {
        // Some workspace packages have no dependencies at all.
        const pkg = [...packages.values()].find((item) => item.directory === directory)?.pkg
        if (error.code !== "ENOENT" || directory === "."
          || Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).length)
          failures.push({ path: path.relative(root, modules), reason: "independent install required" })
      }
    }
  }
  return { sourceCommit: manifest.sourceCommit, sourceFiles, expectedFiles: manifest.files.length,
    packages: packages.size, dependencyLinks, failures, scope: "source-integrity-only" }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(root, "configs/source-manifest.json"), "utf8"))
  const result = await checkSource(root, manifest)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.failures.length ? 1 : 0
}
