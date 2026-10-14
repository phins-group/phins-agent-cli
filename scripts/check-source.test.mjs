import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkSource } from "./check-source.mjs"

test("source check detects lost/changed source and workspace or link escapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-source-check-"))
  const root = path.join(directory, "repo")
  const hash = (value) => createHash("sha256").update(value).digest("hex")
  const manifest = { sourceCommit: "test-fixture", packages: ["packages/core"], adaptations: {},
    files: [{ path: "packages/core/index.ts", sha256: hash("source") }] }
  try {
    await mkdir(path.join(root, "packages/core"), { recursive: true })
    await mkdir(path.join(root, "node_modules"))
    await mkdir(path.join(root, "packages/core/node_modules"))
    await writeFile(path.join(root, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core" }))
    await writeFile(path.join(root, "packages/core/index.ts"), "source")
    assert.deepEqual((await checkSource(root, manifest)).failures, [])
    await writeFile(path.join(root, "packages/core/index.ts"), "changed")
    assert.equal((await checkSource(root, manifest)).failures.length, 1)
    manifest.adaptations["packages/core/index.ts"] = { sha256: hash("changed"), reason: "fixture adaptation" }
    assert.deepEqual((await checkSource(root, manifest)).failures, [])
    await rm(path.join(root, "packages/core/index.ts"))
    assert.equal((await checkSource(root, manifest)).failures[0].reason, "missing source")
    await writeFile(path.join(directory, "external.ts"), "changed")
    await symlink(path.join(directory, "external.ts"), path.join(root, "packages/core/index.ts"))
    await symlink(directory, path.join(root, "node_modules/external"))
    await writeFile(path.join(root, "packages/core/package.json"), JSON.stringify({
      name: "@fixture/core", dependencies: { "@fixture/missing": "workspace:*" },
    }))
    const failure = await checkSource(root, manifest)
    assert.equal(failure.failures.length, 3)
    assert.equal(failure.dependencyLinks, 1)
    assert.equal(failure.scope, "source-integrity-only")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})


test("source inventory rejects files reintroduced outside the reviewed boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phins-inventory-"))
  try {
    await mkdir(path.join(root, "packages/retired"), { recursive: true })
    await writeFile(path.join(root, "packages/retired/secret.ts"), "unreviewed source")
    const manifest = { sourceCommit: "fixture", packages: [], adaptations: {}, files: [],
      inventoryDirectories: ["packages"] }
    assert.deepEqual((await checkSource(root, manifest, { dependencies: false })).failures, [
      { path: "packages/retired/secret.ts", reason: "unreviewed source file" },
    ])
    manifest.inventoryDirectories = ["../"]
    assert.equal((await checkSource(root, manifest, { dependencies: false })).failures[0].reason,
      "inventory escapes repository")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
