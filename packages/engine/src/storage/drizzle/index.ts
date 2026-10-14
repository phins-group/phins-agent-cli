/**
 * Adapter Drizzle cho Effect SQLite; export driver, session và migration.
 * Connection lifecycle do SqlClient layer được consumer cung cấp quản lý.
 */
export { EffectLogger } from "drizzle-orm/effect-core"
export * from "./effect-sqlite/driver"
export * from "./effect-sqlite/session"
export { migrate } from "./effect-sqlite/migrator"

export * as EffectDrizzleSqlite from "./index"
