import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/storage/database"
import { tmpdir } from "./fixture/tmpdir"

for (const commit of [false, true]) {
  test(`SQLite reopens consistently after an owned writer crashes ${commit ? "after" : "before"} commit`, async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "crash.db")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('fixture-project', '/fixture', 1, 1, '[]')`)
        yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('ses_crash', 'fixture-project', 'fixture', '/fixture', 'before', 'fixture', 1, 1)`)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const { Database } = require("bun:sqlite");
      const db = new Database(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
      db.exec("UPDATE session SET title = 'after' WHERE id = 'ses_crash'");
      if (process.argv[2] === "commit") db.exec("COMMIT");
      process.stdout.write("writer-ready\\n");
      setInterval(() => {}, 1000);
    `,
        filename,
        commit ? "commit" : "uncommitted",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toBe("writer-ready\n")
      child.kill("SIGKILL")
      await child.exited
      await reader.cancel()
    } finally {
      clearTimeout(deadline)
      child.kill("SIGKILL")
      await child.exited
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* db.get(sql`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        expect(yield* db.get(sql`SELECT title FROM session WHERE id = 'ses_crash'`)).toEqual({
          title: commit ? "after" : "before",
        })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  }, 20_000)
}
