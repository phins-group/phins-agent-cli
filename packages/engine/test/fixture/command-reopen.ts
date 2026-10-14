import assert from "node:assert/strict"
import { copyFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { EffectDrizzleSqlite } from "../../src/storage/drizzle/index"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/storage/database"
import { DatabaseMigration } from "../../src/storage/migration"
import { migrations } from "../../src/storage/migration.gen"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionRuntimeLocal } from "../../src/sessions/runtime"
import { SessionMessage } from "../../src/sessions/messages/service"
import { SessionInput } from "../../src/sessions/input/inbox"
import type * as Commands from "../../src/sessions/actions/commands"

const root = process.cwd()
const filename = path.join(root, "upgrade.db")
assert.equal(
  process.env.PHINS_DB,
  filename,
  "explicit disposable database required",
)
assert.equal(
  process.env.PHINS_TEST_HOME,
  path.join(root, "home"),
  "isolated test home required",
)
const backup = path.join(root, "before-upgrade.db")
const restored = path.join(root, "restored-separate.db")
const latest = "20261009151628_session_command_receipt"
assert.equal(
  migrations.at(-1)?.id,
  latest,
  "review the upgrade boundary when adding migrations",
)
let networkAttempts = 0
const blockNetwork = () => {
  networkAttempts++
  throw new Error("Network access is forbidden in the upgrade fixture")
}
globalThis.fetch = Object.assign(async () => blockNetwork(), {
  preconnect: blockNetwork,
})
await writeFile(
  path.join(root, "phins.json"),
  JSON.stringify({
    snapshots: false,
    commands: { saved: { template: "Keep $ARGUMENTS" } },
  }),
)

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type DB = Effect.Success<typeof makeDb>
const tables = [
  "session",
  "session_message",
  "session_input",
  "session_run_state",
  "node_command_receipt",
]
const snapshot = (db: DB, names = tables) =>
  Effect.gen(function* () {
    const rows: Record<string, unknown> = {}
    for (const name of names)
      rows[name] = yield* db.all(
        sql`SELECT * FROM ${sql.identifier(name)} ORDER BY 1`,
      )
    return rows
  })
const raw = <A, E>(file: string, operation: (db: DB) => Effect.Effect<A, E>) =>
  makeDb.pipe(
    Effect.flatMap(operation),
    Effect.provide(SqliteClient.layer({ filename: file, disableWAL: true })),
    Effect.scoped,
    Effect.runPromise,
  )
const checkIntegrity = (db: DB) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* db.get(sql`PRAGMA integrity_check`), {
      integrity_check: "ok",
    })
    assert.deepEqual(yield* db.all(sql`PRAGMA foreign_key_check`), [])
  })
const before = await raw(filename, (db) =>
  Effect.gen(function* () {
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* DatabaseMigration.applyOnly(db, migrations.slice(0, -1))
    yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('upgrade-project', ${root}, 1, 1, '[]')`)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_upgrade', 'upgrade-project', 'upgrade', ${root}, 'Giữ lịch sử 🚀', 'fixture', 1, 1)`)
    yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES ('msg_history', 'ses_upgrade', 'user', 1, 1, 1,
      ${JSON.stringify({ text: "Nội dung không đổi 🚀", time: { created: 1 } })})`)
    yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
    VALUES ('msg_pending', 'ses_upgrade', ${JSON.stringify({ text: "Chờ xác nhận, không tự chạy" })}, 'queue', 2, NULL, 2)`)
    yield* db.run(sql`INSERT INTO session_run_state (session_id, run_id, status, time_started, time_settled)
    VALUES ('ses_upgrade', 'run_upgrade', 'interrupted', 1, 2)`)
    yield* checkIntegrity(db)
    const data = yield* snapshot(db)
    yield* db.run(sql`VACUUM INTO ${backup}`)
    return data
  }),
)
const pendingBefore = (await Effect.runPromise(Database.inspect(filename)))
  .pending
assert.deepEqual(pendingBefore, [latest])
await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    assert.deepEqual(yield* snapshot(db), before)
    assert.deepEqual(
      yield* db.all(sql`SELECT * FROM session_command_receipt`),
      [],
    )
    yield* checkIntegrity(db)
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
)

const commands: Array<{ input: Commands.Input; status: string }> = []
const runtime = <A, E>(
  work: Effect.Effect<A, E, SessionManager.Service | Database.Service>,
) =>
  work.pipe(
    Effect.provide(SessionRuntimeLocal.defaultLayer),
    Effect.provide(Database.defaultLayer),
    Effect.provide(EventBus.defaultLayer),
    Effect.scoped,
    Effect.runPromise,
  )
await runtime(
  Effect.gen(function* () {
    const sessions = yield* SessionManager.Service
    const { db } = yield* Database.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(root) })
    for (const status of ["completed", "failed", "invoked", "unknown"]) {
      const session = yield* sessions.create({ location })
      const input: Commands.Input = {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        command: "saved",
        arguments: status,
        resume: false,
      }
      yield* sessions.command(input)
      assert.equal(
        (yield* SessionInput.find(db, input.id))?.prompt.text,
        `Keep ${status}`,
      )
      // Persist the four receipt outcomes, including interruption/crash sentinels.
      yield* db.run(
        sql`UPDATE session_command_receipt SET status = ${status} WHERE id = ${input.id}`,
      )
      commands.push({ input, status })
    }
    yield* checkIntegrity(db)
  }),
)
const preservedTables = [
  ...tables,
  "event",
  "migration",
  "session_command_receipt",
]
const first = await raw(filename, (db) => snapshot(db, preservedTables))
await runtime(
  Effect.gen(function* () {
    const sessions = yield* SessionManager.Service
    const { db } = yield* Database.Service
    assert.deepEqual(
      yield* snapshot(db, preservedTables),
      first,
      "reopening cannot mutate pending work or receipts",
    )
    for (const { input, status } of commands) {
      const result = yield* sessions.command(input).pipe(Effect.result)
      assert.equal(result._tag, status === "completed" ? "Success" : "Failure")
      if (result._tag === "Failure")
        assert.match(String(result.failure), /incomplete or uncertain/)
    }
    assert.deepEqual(
      yield* snapshot(db, preservedTables),
      first,
      "duplicate commands cannot re-admit or replay work",
    )
    yield* checkIntegrity(db)
  }),
)
const pendingAfter = (await Effect.runPromise(Database.inspect(filename)))
  .pending
assert.deepEqual(pendingAfter, [])

// Rollback is a separate snapshot restore. Never downgrade the active database
// or drop post-upgrade receipts/history merely to make an older build start.
await copyFile(backup, restored)
await raw(restored, (db) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* snapshot(db), before)
    assert.equal(
      yield* db.get(
        sql`SELECT name FROM sqlite_master WHERE name='session_command_receipt'`,
      ),
      undefined,
    )
    assert.equal(
      (yield* db.all(sql`SELECT id FROM migration`)).length,
      migrations.length - 1,
    )
    yield* checkIntegrity(db)
  }),
)
assert.deepEqual(
  (await Effect.runPromise(Database.inspect(restored))).pending,
  [latest],
)
assert.deepEqual(
  await raw(filename, (db) => snapshot(db, preservedTables)),
  first,
  "restore leaves all upgraded data and receipts intact in the original file",
)
assert.equal(networkAttempts, 0)
const hash = async (file: string) =>
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
    .digest("hex")
await writeFile(
  path.join(root, "evidence.json"),
  JSON.stringify(
    {
      latestMigration: latest,
      migrationCount: migrations.length,
      pendingBefore,
      pendingAfter,
      networkAttempts,
      commandStatuses: commands.map(({ status }) => status),
      preservedTables,
      beforeCounts: Object.fromEntries(
        Object.entries(before).map(([name, rows]) => [
          name,
          (rows as unknown[]).length,
        ]),
      ),
      afterCounts: Object.fromEntries(
        Object.entries(first).map(([name, rows]) => [
          name,
          (rows as unknown[]).length,
        ]),
      ),
      restoredSnapshotMatches: true,
      upgradedSnapshotUnchanged: true,
      files: {
        upgraded: { path: filename, sha256: await hash(filename) },
        backup: { path: backup, sha256: await hash(backup) },
        restored: { path: restored, sha256: await hash(restored) },
      },
      limits: [
        "No old release binary was opened against new data.",
        "Rollback restores the pre-upgrade snapshot separately; post-backup work remains in the upgraded database.",
        "Runtime duplicate commands use record-only admission; no model or shell execution is required.",
        "Receipt interruption states are explicit fixtures, not a forced process crash.",
      ],
    },
    null,
    2,
  ),
)
console.log(
  "command upgrade: history, pending, receipt reopen and separate backup restore passed",
)
