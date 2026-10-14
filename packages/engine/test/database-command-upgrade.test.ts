import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

test("receipt migration preserves file-backed history and pending work across reopen and backup restore", async () => {
  await using fixture = await tmpdir()
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/command-reopen.ts")],
    {
      cwd: fixture.path,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        PHINS_TEST_HOME: path.join(fixture.path, "home"),
        PHINS_TEST_MANAGED_CONFIG_DIR: path.join(fixture.path, "managed"),
        PHINS_DB: path.join(fixture.path, "upgrade.db"),
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
  const watchdog = setTimeout(() => child.kill(), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    expect(stdout).toContain(
      "command upgrade: history, pending, receipt reopen and separate backup restore passed",
    )
    const evidence = await Bun.file(
      path.join(fixture.path, "evidence.json"),
    ).json()
    expect(evidence.pendingBefore).toEqual([
      "20261009151628_session_command_receipt",
    ])
    expect(evidence.pendingAfter).toEqual([])
    expect(evidence.networkAttempts).toBe(0)
    expect(evidence.commandStatuses).toEqual([
      "completed",
      "failed",
      "invoked",
      "unknown",
    ])
    expect(evidence.restoredSnapshotMatches).toBe(true)
    expect(evidence.upgradedSnapshotUnchanged).toBe(true)
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}, 35_000)
