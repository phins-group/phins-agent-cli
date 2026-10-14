/** Explicit database paths only; importing this module never bootstraps AppPaths. */
import { EffectDrizzleSqlite } from "./drizzle/index"
import { layer as sqliteLayer } from "./sqlite.bun"
import { Effect } from "effect"
import * as Migration from "./migration"

const database = EffectDrizzleSqlite.makeWithDefaults()
export const inspectFile = (filename: string) =>
  database.pipe(
    Effect.flatMap(Migration.inspect),
    Effect.provide(
      sqliteLayer({
        filename,
        readonly: true,
        readwrite: false,
        create: false,
        disableWAL: true,
      }),
    ),
    Effect.scoped,
  )
export const migrateFile = (filename: string) =>
  database.pipe(
    Effect.flatMap((db) =>
      db
        .run("PRAGMA foreign_keys = ON")
        .pipe(
          Effect.andThen(db.run("PRAGMA busy_timeout = 5000")),
          Effect.andThen(Migration.apply(db)),
        ),
    ),
    Effect.provide(sqliteLayer({ filename, create: false, disableWAL: true })),
    Effect.scoped,
  )
