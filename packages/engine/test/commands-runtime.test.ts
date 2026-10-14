import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

test("native named commands are owned, bounded and never replay uncertain side effects", async () => {
  await using fixture = await tmpdir()
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "fixture/commands-runtime.ts"),
    ],
    {
      cwd: fixture.path,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        PHINS_TEST_HOME: path.join(fixture.path, "home"),
        PHINS_TEST_MANAGED_CONFIG_DIR: path.join(fixture.path, "managed"),
        PHINS_DB: ":memory:",
        PHINS_DISABLE_MODELS_FETCH: "true",
        PHINS_MODELS_PATH: path.join(
          import.meta.dir,
          "plugin/fixtures/models-dev.json",
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const watchdog = setTimeout(() => child.kill(), 30000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    expect(stdout).toContain(
      "commands: record-only, substitutions, canonical subtask, shared budget, receipt, permission and Stop passed",
    )
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}, 35000)
