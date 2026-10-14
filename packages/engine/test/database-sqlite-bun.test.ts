import type { Database as BunDatabase } from "bun:sqlite"
import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Sqlite } from "../src/storage/sqlite"
import { layer } from "../src/storage/sqlite.bun"
import { tmpdir } from "./fixture/tmpdir"

for (const mode of ["rows", "values"] as const) {
  for (const failing of [false, true]) {
    test(`Bun SQLite finalizes ${mode} statements after ${failing ? "failure" : "success"} without GC`, async () => {
      await using tmp = await tmpdir()
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* SqlClient.SqlClient
          yield* client`CREATE TABLE fixture (id INTEGER CHECK (id >= 0))`
          // Exceed Bun's query cache: an uncached statement must not keep the
          // connection (and its WAL checkpoint) alive until a later GC cycle.
          for (let index = 0; index < 300; index++) {
            const statement = client.unsafe(`INSERT INTO fixture VALUES (?) -- ${index}`, [failing ? -1 : index])
            const result = mode === "values" ? statement.values : statement
            const exit = yield* Effect.exit(result)
            expect(Exit.isFailure(exit)).toBe(failing)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("CHECK constraint failed")
          }
          expect(yield* client`SELECT count(*) AS count FROM fixture`).toEqual([{ count: failing ? 0 : 300 }])
          const native = (yield* Sqlite.Native) as BunDatabase
          // Strict close detects leaked statements deterministically; default
          // close silently leaves a zombie connection until they are finalized.
          expect(() => native.close(true)).not.toThrow()
        }).pipe(Effect.provide(layer({ filename: path.join(tmp.path, "fixture.db") })), Effect.scoped),
      )
    })
  }
}

test("Bun SQLite preserves bindings, integer modes and transaction rollback", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      for (const value of ["Giữ phiên 🚀", "updated"]) {
        expect(yield* client`SELECT ${value} AS value`).toEqual([{ value }])
        expect(yield* client`SELECT ${value} AS value`.values).toEqual([[value]])
      }
      expect(yield* client`SELECT 1 AS value`).toEqual([{ value: 1 }])
      expect(yield* client`SELECT 1 AS value`.pipe(Effect.provideService(SqlClient.SafeIntegers, true))).toEqual([
        { value: 1n },
      ])
      expect(yield* client`SELECT 1 AS value`.values.pipe(Effect.provideService(SqlClient.SafeIntegers, true))).toEqual(
        [[1n]],
      )
      yield* client`CREATE TABLE fixture (id INTEGER)`
      const exit = yield* client
        .withTransaction(client`INSERT INTO fixture VALUES (1)`.pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* client`SELECT * FROM fixture`).toEqual([])
    }).pipe(Effect.provide(layer({ filename: ":memory:" })), Effect.scoped),
  )
})
