import { $ } from "bun"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { layer as sqliteLayer } from "../src/storage/sqlite.bun"
import { EffectDrizzleSqlite } from "../src/storage/drizzle/index"
import { Database } from "../src/storage/database"
import { DatabaseMigration } from "../src/storage/migration"
import { migrations } from "../src/storage/migration.gen"
import { Config } from "../src/settings/config"
import { FileAccess } from "../src/workspace/files/access"
import { Git } from "../src/workspace/repository/git"
import { AppPaths } from "../src/runtime/paths"
import { Location } from "../src/workspace/location"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath, RelativePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { tmpdir } from "./fixture/tmpdir"

// QA-only, quiescent fixtures. This is not a live-state backup command.
async function inventory(root: string, directory = ""): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, item.name)
    if (item.isDirectory()) Object.assign(entries, await inventory(root, relative))
    else {
      expect(item.isFile()).toBe(true)
      const file = path.join(root, relative)
      entries[relative] =
        `${(await fs.stat(file)).mode & 0o777}:` +
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex")
    }
  }
  return entries
}

function snapshotLayer(state: string, project: string) {
  const location = Location.layer(Location.Ref.make({ directory: AbsolutePath.make(project) })).pipe(
    Layer.provide(ProjectRegistry.defaultLayer),
  )
  return Snapshot.layer.pipe(
    Layer.provide(location),
    Layer.provide(Config.locationLayer.pipe(Layer.provide(location))),
    Layer.provide(FileAccess.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(AppPaths.layerWith({ data: path.join(state, "share"), config: path.join(state, "config") })),
  )
}

test("quiescent full-state backup survives upgrade and restores a separate pre-upgrade state", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source-state")
  const backup = path.join(tmp.path, "backup-state")
  const upgraded = path.join(tmp.path, "upgraded-state")
  const rollback = path.join(tmp.path, "rollback-state")
  const project = path.join(tmp.path, "project có dấu")
  for (const directory of ["share/repos", "share/snapshot", "config", "state", "cache/bin", "log"])
    await fs.mkdir(path.join(source, directory), { recursive: true })
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, "tracked.txt"), "Trước nâng cấp 🚀\n")
  await $`git init ${project}`.quiet()
  await $`git -C ${project} -c core.fsmonitor=false add .`.quiet()
  await $`git -C ${project} -c core.fsmonitor=false -c commit.gpgsign=false -c user.name=Fixture -c user.email=fixture@phins.test commit -m fixture`.quiet()
  await $`git clone --bare ${project} ${path.join(source, "share/repos/fixture.git")}`.quiet()
  await fs.writeFile(path.join(source, "config/phins.json"), '{"model":"fixture/local","snapshots":true}')
  await fs.writeFile(path.join(source, "share/auth.json"), '{"fixture":"not-a-real-credential"}', { mode: 0o600 })
  await fs.writeFile(path.join(source, "state/kv.json"), '{"fixture":"giữ lựa chọn"}', { mode: 0o600 })
  await fs.writeFile(path.join(source, "log/fixture.log"), "fixture only\n", { mode: 0o600 })
  await fs.writeFile(path.join(source, "cache/bin/fixture-tool"), "fixture only\n", { mode: 0o700 })

  const cutover = migrations.findIndex((item) => item.id === "20260801163000_backfill_session_transcript")
  expect(cutover).toBeGreaterThan(0)
  const dbPath = (root: string) => path.join(root, "share/phins.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, cutover))
      yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('fixture-project', ${project}, 1, 1, '[]')`)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('ses_backup', 'fixture-project', 'fixture', ${project}, 'Giữ phiên 🚀', 'fixture', 1, 1)`)
    }).pipe(Effect.provide(sqliteLayer({ filename: dbPath(source) })), Effect.scoped),
  )
  const captured = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Snapshot.Service).capture()
    }).pipe(Effect.provide(snapshotLayer(source, project)), Effect.scoped),
  )
  expect(captured).toBeDefined()
  if (!captured) throw new Error("Fixture snapshot was not captured")

  // All fixture DB/snapshot scopes are closed before copying the full tree.
  const original = await inventory(source)
  await fs.cp(source, backup, { recursive: true, force: false, errorOnExist: true })
  expect(await inventory(backup)).toEqual(original)
  await fs.cp(backup, upgraded, { recursive: true, force: false, errorOnExist: true })
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.get(sql`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      expect(yield* db.get(sql`SELECT title FROM session WHERE id = 'ses_backup'`)).toEqual({ title: "Giữ phiên 🚀" })
      yield* db.run(sql`UPDATE session SET title = 'Sau nâng cấp' WHERE id = 'ses_backup'`)
    }).pipe(Effect.provide(Database.layerFromPath(dbPath(upgraded))), Effect.scoped),
  )

  await fs.writeFile(path.join(project, "tracked.txt"), "Thay đổi ngoài state\n")
  await fs.cp(backup, rollback, { recursive: true, force: false, errorOnExist: true })
  expect(await inventory(rollback)).toEqual(original)
  // Inspect the old journal without migrating it: restoration does not mean
  // an old released binary has been qualified to read the restored state.
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: cutover })
      expect(yield* db.get(sql`SELECT title FROM session WHERE id = 'ses_backup'`)).toEqual({ title: "Giữ phiên 🚀" })
      expect(yield* db.get(sql`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    }).pipe(Effect.provide(sqliteLayer({ filename: dbPath(rollback) })), Effect.scoped),
  )
  await $`git --git-dir ${path.join(rollback, "share/repos/fixture.git")} fsck --full --strict`.quiet()
  // State restoration must not secretly rewind the external project.
  expect(await fs.readFile(path.join(project, "tracked.txt"), "utf8")).toBe("Thay đổi ngoài state\n")
  await Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const files = new Map([[RelativePath.make("tracked.txt"), captured]])
      expect((yield* snapshot.preview({ files, context: 1 })).length).toBeGreaterThan(0)
      yield* snapshot.restore({ files })
    }).pipe(Effect.provide(snapshotLayer(rollback, project)), Effect.scoped),
  )
  expect(await fs.readFile(path.join(project, "tracked.txt"), "utf8")).toBe("Trước nâng cấp 🚀\n")
  // A closed source must remain byte-identical even when statement wrappers
  // are collected later, as happens under the memory pressure of a full suite.
  Bun.gc(true)
  expect(await inventory(backup)).toEqual(original)
  expect(await inventory(source)).toEqual(original)
}, 30_000)
