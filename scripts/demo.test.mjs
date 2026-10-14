import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { prepareDemo, checkOracle, demoLauncher } from "./demo.mjs"

test("historical demo reproduces the real bug in an independent copy and protects its oracle", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "phins-demo-test-"))
  const root = fileURLToPath(new URL("..", import.meta.url))
  const destination = path.join(await realpath(temporary), "demo")
  try {
    const original = await readFile(path.join(root, "examples/live/ms-pr111/index.js"))
    const result = await prepareDemo(root, destination)
    await checkOracle(destination)
    assert.deepEqual(await readFile(path.join(result.project, "index.js")), original)
    const baseline = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/regression.test.mjs"], {
      cwd: result.project, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30000,
    })
    assert.equal(baseline.status, 1)
    assert.match(baseline.stdout, /# tests 27\b/)
    assert.match(baseline.stdout, /# fail [1-9]\d*\b/)
    assert.equal(execFileSync("git", ["remote"], { cwd: result.project, encoding: "utf8" }).trim(), "")
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: result.project }).status, 0)
    const config = JSON.parse(await readFile(path.join(destination, "profile.json")))
    assert.deepEqual(config.permissions.filter(rule => rule.action === "edit"), [{ action: "edit", resource: "index.js", effect: "allow" }])
    assert.equal(result.inference, false)
    await assert.rejects(prepareDemo(root, destination), /EEXIST/)
    await writeFile(path.join(result.project, "test/regression.test.mjs"), "// tampered")
    await assert.rejects(checkOracle(destination), /oracle changed/)
    assert.deepEqual(await readFile(path.join(root, "examples/live/ms-pr111/index.js")), original)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("demo preparation refuses changed inputs, traversal and symlinked oracles", async t => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-demo-boundary-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const source = fileURLToPath(new URL("..", import.meta.url))
  const root = path.join(temporary, "source")
  await mkdir(root)
  await cp(path.join(source, "examples"), path.join(root, "examples"), { recursive: true })
  const destination = path.join(temporary, "demo")
  const filename = path.join(root, "examples/live/ms-pr111/index.js")
  const original = await readFile(filename)
  await writeFile(filename, "changed")
  await assert.rejects(prepareDemo(root, destination), /Changed upstream input/)
  await writeFile(filename, original)
  const oracle = path.join(root, "examples/live/ms-pr111-strict/test/regression.test.mjs")
  await rm(oracle)
  await symlink(filename, oracle)
  await assert.rejects(prepareDemo(root, destination), /Symlink demo input/)
  const upstreamFile = path.join(root, "examples/live/UPSTREAM.json")
  const upstream = JSON.parse(await readFile(upstreamFile))
  upstream.files[0].path = "../escape"
  await writeFile(upstreamFile, JSON.stringify(upstream))
  await assert.rejects(prepareDemo(root, destination), /Invalid demo input path/)
})

test("demo launches the bundled executable without Bun and rejects symlink substitution", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-demo-launch-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, "project with spaces")
  const binary = path.join(root, process.platform === "win32" ? "phins.exe" : "phins")
  assert.deepEqual(await demoLauncher(root, "tui", project), ["bun", path.join(root, "scripts/local-agent.ts"), project])
  await writeFile(binary, "fixture", { mode: 0o755 })
  assert.deepEqual(await demoLauncher(root, "setup", project), [binary, "setup", "--project", project])
  assert.deepEqual(await demoLauncher(root, "tui", project), [binary, project])
  await rm(binary)
  await symlink("replacement", binary)
  await assert.rejects(demoLauncher(root, "tui", project), /regular file/)
})
