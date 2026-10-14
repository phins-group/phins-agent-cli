export * as Database from "./database"

import { EffectDrizzleSqlite } from "./drizzle/index"
import { layer as sqliteLayer } from "./sqlite.bun"
import { Context, Effect, Layer } from "effect"
import { AppPaths } from "../runtime/paths"
import { Flag } from "../runtime/flags"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { ServiceGraph } from "../runtime/effect/service-graph"
import { inspectFile } from "./offline"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/storage/Database",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/** Inspection does not use the initialization layer, PRAGMAs or migrations. */
export const inspect = inspectFile

export function path() {
  if (Flag.PHINS_DB) {
    if (Flag.PHINS_DB === ":memory:" || isAbsolute(Flag.PHINS_DB))
      return Flag.PHINS_DB
    return join(AppPaths.directories.data, Flag.PHINS_DB)
  }
  return join(AppPaths.directories.data, "phins.db")
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(AppPaths.defaultLayer))

export const node = ServiceGraph.node(layerFromPath(path()), [])
