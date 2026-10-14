import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "../src/storage/drizzle/index"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { copyFile } from "node:fs/promises"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "../src/storage/database"
import { DatabaseMigration } from "../src/storage/migration"
import { migrations } from "../src/storage/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type TestDatabase = Effect.Success<typeof makeDb>
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

// Snapshot schema, migration history and sentinel data, not just the error.
const snapshot = (db: TestDatabase) =>
  Effect.gen(function* () {
    const schema = yield* db.all<{ name: string }>(sql`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
    const rows: Record<string, unknown> = {}
    for (const name of ["session", "migration", "__drizzle_migrations"]) {
      if (schema.some((row) => row.name === name))
        rows[name] = yield* db.all(sql`SELECT * FROM ${sql.identifier(name)} ORDER BY id`)
    }
    return { schema, rows, changes: yield* db.get(sql`SELECT total_changes() AS count`) }
  })

const expectRejected = (db: TestDatabase) =>
  Effect.gen(function* () {
    const before = yield* snapshot(db)
    const exit = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.pretty(exit.cause)).toContain("Database migration history is not supported by this build")
    expect(yield* snapshot(db)).toEqual(before)
  })

test("startup rejects an unknown migration before applying any pending migration", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      const pending = migrations[migrations.length - 1].id
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, -1))
      yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20990101000000_future', 1)`)
      yield* expectRejected(db)
      expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${pending}`)).toBeUndefined()
    }),
  )
})

test("startup rejects an unknown legacy migration before creating the new journal", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)`)
      yield* db.run(sql`INSERT INTO session VALUES ('fixture', 'Giữ dữ liệu nguyên vẹn')`)
      yield* db.run(sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, name TEXT)`)
      yield* db.run(sql`INSERT INTO __drizzle_migrations (name) VALUES ('20990101000000_future')`)
      yield* expectRejected(db)
    }),
  )
})

test("startup rejects a session database with no usable migration history", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)`)
      yield* db.run(sql`INSERT INTO session VALUES ('fixture', 'Không tự sửa journal')`)
      yield* expectRejected(db)
    }),
  )
})

for (const id of ["20000101000000_unknown", "", null]) {
  test(`startup rejects unknown or invalid canonical ID ${JSON.stringify(id)}`, async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, 1)`)
        yield* expectRejected(db)
      }),
    )
  })
}

test("an empty canonical journal does not hide an unsupported legacy journal", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
      yield* db.run(sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, name TEXT)`)
      yield* db.run(sql`INSERT INTO __drizzle_migrations (name) VALUES ('20990101000000_future')`)
      yield* expectRejected(db)
    }),
  )
})

test("an empty canonical journal and unnamed legacy entries fail without importing", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
      yield* db.run(sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, name TEXT)`)
      yield* db.run(sql`INSERT INTO __drizzle_migrations (name) VALUES (NULL)`)
      yield* expectRejected(db)
    }),
  )
})

test("current schema reopens without writes and accepts the shipped legacy alias", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)
      const before = yield* snapshot(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* snapshot(db)).toEqual(before)
    }),
  )
})

test("a populated canonical journal retains authority over stale Drizzle history", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, name TEXT)`)
      yield* db.run(sql`INSERT INTO __drizzle_migrations (name) VALUES ('stale-ignored-entry')`)
      const before = yield* snapshot(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* snapshot(db)).toEqual(before)
    }),
  )
})

test("supported Drizzle history is imported without replaying schema changes", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, name TEXT)`)
      yield* db.run(sql`INSERT INTO __drizzle_migrations (name) SELECT id FROM migration`)
      yield* db.run(sql`DROP TABLE migration`)
      yield* DatabaseMigration.apply(db)
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      const before = yield* snapshot(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* snapshot(db)).toEqual(before)
    }),
  )
})

const seedSession = (db: TestDatabase) =>
  Effect.gen(function* () {
    yield* db.run(sql`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('fixture-project', '/fixture', 1, 1, '[]')
  `)
    yield* db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_fixture', 'fixture-project', 'fixture', '/fixture', 'Dữ liệu cần giữ 🚀', 'fixture', 1, 1)
  `)
  })

test("supported upgrade backfills legacy transcript and keeps session data", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      const cutover = migrations.findIndex((migration) => migration.id === "20260801163000_backfill_session_transcript")
      expect(cutover).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, cutover))
      yield* seedSession(db)
      const data = JSON.stringify({
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture" },
      })
      const part = JSON.stringify({ type: "text", text: "Nội dung giữ nguyên 🚀", time: { start: 1, end: 1 } })
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_fixture', 'ses_fixture', 1, 1, ${data})`)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_fixture', 'msg_fixture', 'ses_fixture', 1, 1, ${part})`)
      const sessions = yield* db.all(sql`SELECT * FROM session`)
      yield* DatabaseMigration.apply(db)
      expect(yield* db.all(sql`SELECT * FROM session`)).toEqual(sessions)
      expect(yield* db.all(sql`SELECT name FROM sqlite_master WHERE name IN ('message', 'part')`)).toEqual([])
      const events = yield* db.all<{ data: string }>(sql`SELECT data FROM event WHERE aggregate_id = 'ses_fixture'`)
      expect(events.some((event) => event.data.includes("Nội dung giữ nguyên 🚀"))).toBe(true)
      const before = yield* snapshot(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* snapshot(db)).toEqual(before)
    }),
  )
})

test("the production database layer rejects unsupported history without changing schema or data", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "unsupported.db")
  const inspect = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
    Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const before = await inspect(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)`)
      yield* db.run(sql`INSERT INTO session VALUES ('ses_fixture', 'Không thay đổi 🚀')`)
      yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
      yield* db.run(sql`INSERT INTO migration VALUES ('20990101000000_future', 1)`)
      const { schema, rows } = yield* snapshot(db)
      return { schema, rows }
    }),
  )
  const exit = await Effect.runPromise(
    Database.Service.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.exit),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(Cause.pretty(exit.cause)).toContain("Database migration history is not supported by this build")
  const after = await inspect(
    Effect.gen(function* () {
      const db = yield* makeDb
      const { schema, rows } = yield* snapshot(db)
      expect(yield* db.get(sql`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
      return { schema, rows }
    }),
  )
  expect(after).toEqual(before)
})

test("a SQLite backup restores into a separate file without changing the source", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.db")
  const backup = path.join(tmp.path, "backup.db")
  const restored = path.join(tmp.path, "restored.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      yield* db.run(sql`VACUUM INTO ${backup}`)
      // A post-backup write must not leak into the restored snapshot.
      yield* db.run(sql`UPDATE session SET title = 'Sau backup' WHERE id = 'ses_fixture'`)
    }).pipe(Effect.provide(Database.layerFromPath(source)), Effect.scoped),
  )
  await copyFile(backup, restored)
  for (const [filename, title] of [
    [restored, "Dữ liệu cần giữ 🚀"],
    [source, "Sau backup"],
  ] as const) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* db.get(sql`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        expect(yield* db.get(sql`SELECT title FROM session WHERE id = 'ses_fixture'`)).toEqual({ title })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  }
})
