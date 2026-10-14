export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Schema, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "./drizzle/index"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
  /** Run non-schema objects (for example triggers) after a fresh schema build. */
  runOnFreshSchema?: boolean
}

export class IncompatibleSchemaError extends Schema.TaggedErrorClass<IncompatibleSchemaError>()(
  "DatabaseMigration.IncompatibleSchemaError",
  { reason: Schema.Literals(["unknown-migration", "missing-history"]) },
) {
  override get message() {
    return (
      "Database migration history is not supported by this build. " +
      "Use a compatible Phins Agents version or restore a verified backup " +
      "into a separate state directory. Do not delete the migration journal."
    )
  }
}

function assertSupportedHistory(db: Database, tables: { name: string }[]) {
  return Effect.gen(function* () {
    let completed = tables.some((table) => table.name === "migration")
      ? yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)
      : []
    // Match applyOnly's authority: a populated canonical journal supersedes
    // Drizzle. Inspect the legacy source only when it would be imported.
    if (
      !completed.length &&
      tables.some((table) => table.name === "__drizzle_migrations")
    )
      completed = yield* db.all<{ id: string }>(
        sql`SELECT name AS id FROM __drizzle_migrations WHERE name IS NOT NULL`,
      )
    if (!completed.length)
      return yield* new IncompatibleSchemaError({ reason: "missing-history" })
    const supported = new Set<string>(
      migrations.map((migration) => migration.id),
    )
    // This metadata-column migration shipped briefly under a replacement ID.
    // Its original migration already handles the column idempotently.
    supported.add("20260530232709_lovely_romulus")
    if (completed.some((row) => !supported.has(row.id)))
      return yield* new IncompatibleSchemaError({ reason: "unknown-migration" })
    return completed.map((row) => row.id)
  })
}

/** Read-only qualification; never creates/imports the migration journal. */
export function inspect(db: Database) {
  return Effect.gen(function* () {
    const tables = yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    const initial = tables.length === 0
    if (!initial && !tables.some((table) => table.name === "session"))
      return yield* Effect.die("Database is not empty and has no session table")
    const completed = initial ? [] : yield* assertSupportedHistory(db, tables)
    return {
      initial,
      completed,
      pending: migrations
        .filter((migration) => !completed.includes(migration.id))
        .map((migration) => migration.id),
    }
  })
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) {
        // Read-only admission check before creating/importing the journal or
        // applying any migration. Never treat an unknown ID as an old one.
        yield* assertSupportedHistory(db, tables)
        return yield* applyOnly(db, migrations)
      }
      if (tables.length > 0)
        return yield* Effect.die(
          "Database is not empty and has no session table",
        )
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(
            migrations,
            (migration) =>
              Effect.gen(function* () {
                if (
                  "runOnFreshSchema" in migration &&
                  migration.runOnFreshSchema
                )
                  yield* migration.up(tx)
                yield* tx.run(
                  sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
                )
              }),
            { discard: true },
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(
        sql`SELECT id FROM ${sql.identifier("migration")}`,
      )).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`,
        )
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(
            sql`SELECT id FROM ${sql.identifier("migration")}`,
          )).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
