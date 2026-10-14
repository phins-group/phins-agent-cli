import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProcessSandbox } from "../src/execution/sandbox"

test("sandbox policy is explicit and rejects unknown modes", () => {
  expect(ProcessSandbox.parse(undefined)).toEqual({ mode: "disabled" })
  expect(() => ProcessSandbox.parse('{"mode":"auto"}')).toThrow()
  expect(() => ProcessSandbox.parse("broken")).toThrow()
})

test("disabled sandbox preserves the original command", async () => {
  const command = {
    command: "cmd.exe",
    args: ["/c", "echo test"],
    cwd: "/missing",
    root: "/missing",
  }
  expect(await Effect.runPromise(ProcessSandbox.prepareWith({ mode: "disabled" }, command))).toBe(command)
})

// Opt in on a host that can start native sandboxes. A skipped host check is
// never evidence of filesystem/network enforcement.
test.skipIf(process.env.PHINS_TEST_OS_SANDBOX !== "1")(
  "native sandbox enforces child, symlink, metadata and network boundaries",
  async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phins-sandbox-")))
    const root = path.join(base, "workspace")
    const outside = path.join(base, "outside")
    await fs.mkdir(root)
    await fs.mkdir(outside)
    await fs.mkdir(path.join(root, ".git"))
    await fs.symlink(outside, path.join(root, "escape"))
    const execute = async (
      command: string,
      mode: "workspace-write" | "read-only" = "workspace-write",
      network: "deny" | "allow" = "deny",
    ) => {
      const prepared = await Effect.runPromise(
        ProcessSandbox.prepareWith(
          { mode, network },
          {
            command: "/bin/sh",
            args: ["-c", command],
            root,
            cwd: root,
          },
        ),
      )
      const child = Bun.spawn([prepared.command, ...prepared.args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, stdout, stderr }
    }
    try {
      expect(await execute("printf allowed > ok; cat ok")).toMatchObject({
        code: 0,
        stdout: "allowed",
      })
      // macOS mktemp without a template prefers _CS_DARWIN_USER_TEMP_DIR
      // over TMPDIR. Use an explicit template to exercise the granted root.
      expect(await execute('printf "%s" "$TMPDIR"')).toMatchObject({
        code: 0,
        stdout: root,
      })
      expect(await execute('scratch=$(mktemp "$TMPDIR/phins.XXXXXX") && rm "$scratch"')).toMatchObject({ code: 0 })
      expect((await execute("/bin/sh -c 'printf escaped > escape/denied'")).code).not.toBe(0)
      expect((await execute("printf denied > .git/denied")).code).not.toBe(0)
      expect((await execute("printf denied > readonly", "read-only")).code).not.toBe(0)
      let hits = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          hits++
          return new Response("reachable")
        },
      })
      try {
        const command = `/usr/bin/curl --noproxy '*' --silent --show-error --connect-timeout 1 http://127.0.0.1:${server.port}`
        expect(await execute(command, "read-only", "allow")).toMatchObject({
          code: 0,
          stdout: "reachable",
        })
        expect((await execute(command)).code).not.toBe(0)
        expect(hits).toBe(1)
      } finally {
        await server.stop(true)
      }
      expect(await fs.readdir(outside)).toEqual([])
      expect(await fs.readdir(path.join(root, ".git"))).toEqual([])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  },
  30000,
)
