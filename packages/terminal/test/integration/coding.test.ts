/** Local mechanism qualification. Scripted HTTP responses are NOT inference. */
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readSessionSnapshot } from "@phins/engine/transport/client/connection"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const binary = process.env.PHINS_TEST_CLI_BINARY
const command = (args: string[]) => binary
  ? [binary, ...args] : [process.execPath, entry, ...args]
const testCommand = "node --test --test-reporter=tap test/add.test.mjs"
const initial = "export const add = (a, b) => a - b\n"
const incorrect = "export const add = (a, b) => a + b + 1\n"
const corrected = "export const add = (a, b) => a + b\n"
const tests = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from '../src/add.mjs'
test('positive integers', () => assert.equal(add(2, 3), 5))
test('negative integers', () => assert.equal(add(-2, -3), -5))
`
const summary = "Local coding fixture verified two passing tests."
const workflow = "PRIVATE_QA_SYSTEM_MARKER: plan, inspect, test, edit, verify."
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
type RequestBody = {
  model: string
  messages: { role: string; content: unknown; tool_call_id?: string }[]
  tools: { function: { name: string } }[]
}
type Step = { name: string; input: object; check?: (result: string) => void }
async function until<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error("Isolated native coding fixture timed out")
}

for (const mode of ["cli", "tui", "provider-error", "verifier-failure", "missing-snapshot"] as const) {
  test.skipIf((mode === "tui" && process.platform === "win32") ||
    (["verifier-failure", "missing-snapshot"].includes(mode) && process.env.PHINS_TEST_OS_SANDBOX !== "1"))(
    `native ${mode}: coding tools, verification and durable session`, async () => {
      const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-coding-")))
      const project = path.join(home, "project")
      const nebius = JSON.parse(await readFile(path.resolve(
        import.meta.dir, "../../../../configs/nebius.example.json",
      ), "utf8"))
      const model = nebius.model.slice("nebius/".length)
      const fixtureKey = "local-coding-fixture-not-a-credential"
      const environment = {
        PATH: process.env.PATH, TMPDIR: os.tmpdir(), TERM: "xterm-256color",
        PHINS_TEST_HOME: home, PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
        PHINS_CONFIG_DIR: path.join(home, "config"),
        PHINS_CONFIG: path.join(home, "private-nebius.json"),
        PHINS_DB: path.join(home, "runtime.db"), PHINS_CHANNEL: "local",
        PHINS_DISABLE_MODELS_FETCH: "true",
        PHINS_CODING_WORKFLOW: "1", PHINS_ALLOWED_COMMANDS: JSON.stringify([testCommand]), PHINS_DISABLE_AUTOUPDATE: "true",
        ...(process.env.PHINS_TEST_OS_SANDBOX === "1" ? { PHINS_SAFE_MODE: "1", PHINS_PROTECTED_PATHS: '["test"]' } : {}),
        PHINS_REDUCED_MOTION: "true", PHINS_MODELS_PATH: path.join(home, "models.json"),
        NEBIUS_API_KEY: fixtureKey,
      }
      const plan = (status: string) => ({
        todos: [{ content: "Inspect, fix, test and verify addition", status, priority: "high" }],
      })
      const steps: Step[] = [
        { name: "edit", input: { path: "src/add.mjs", oldString: initial, newString: corrected },
          check: (value) => expect(value).toContain("Read the relevant source") },
        { name: "todowrite", input: plan("in_progress") },
        { name: "glob", input: { pattern: "**/*.mjs" },
          check: (value) => expect(value).toContain("src/add.mjs") },
        { name: "grep", input: { pattern: "a - b", include: "*.mjs" },
          check: (value) => expect(value).toContain("a - b") },
        { name: "read", input: { path: "src/add.mjs" },
          check: (value) => expect(value).toContain("a - b") },
        { name: "read", input: { path: path.join(home, "private-note.txt") },
          check: (value) => {
            expect(value).toContain("Unable to read")
            expect(value).not.toContain("EXTERNAL_FIXTURE_MUST_NOT_BE_READ")
          } },
        { name: "bash", input: { command: testCommand, timeout: 10_000 },
          check: (value) => expect(value).toContain("Command exited with code 1") },
        // An untrusted tool request cannot turn this test-file deny into allow.
        { name: "edit", input: { path: "test/add.test.mjs", oldString: "5))", newString: "-1))" },
          check: (value) => expect(value).toContain("Unable to edit") },
        { name: "edit", input: { path: "src/add.mjs", oldString: initial, newString: incorrect },
          check: (value) => expect(value).toContain("Edited file successfully") },
        { name: "bash", input: { command: testCommand, timeout: 10_000 },
          check: (value) => expect(value).toContain("Command exited with code 1") },
        { name: "edit", input: { path: "src/add.mjs", oldString: incorrect, newString: corrected } },
        { name: "bash", input: { command: testCommand, timeout: 10_000 },
          check: (value) => {
            expect(value).toContain("Command exited with code 0")
            expect(value).toContain("# pass 2")
          } },
        { name: "todowrite", input: plan("completed") },
      ]
      const calls: RequestBody[] = []
      const providerErrors: unknown[] = []
      const provider = Bun.serve({ hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          try {
            const body = await request.json() as RequestBody
            const round = calls.length
            calls.push(body)
            expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
            expect(body.model).toBe(model)
            expect(body.tools.map((tool) => tool.function.name)).not.toContain("lsp")
            expect(body.messages.some((message) => message.role === "system" && String(message.content).includes(workflow))).toBe(true)
            expect(request.headers.get("authorization")).toBe(`Bearer ${fixtureKey}`)
            expect(JSON.stringify(body)).not.toContain(fixtureKey)
            if (mode === "provider-error")
              return Response.json({ error: { message: "Explicit fixture failure", type: "invalid_request_error" } }, { status: 400 })
            expect(round).toBeLessThanOrEqual(steps.length)
            if (round > 0) {
              const result = body.messages.find((message) => message.role === "tool"
                && message.tool_call_id === `call_${round - 1}`)
              expect(result).toBeDefined()
              steps[round - 1]!.check?.(String(result!.content))
            }
            const step = steps[round]
            if (step) expect(body.tools.map((tool) => tool.function.name)).toContain(step.name)
            const delta = step ? { tool_calls: [{ index: 0, id: `call_${round}`,
              type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } }] }
              : { content: summary }
            const chunks = [
              { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
              { choices: [{ delta, finish_reason: null }] },
              { choices: [{ delta: {}, finish_reason: step ? "tool_calls" : "stop" }] },
              // Synthetic usage verifies accounting only; never a benchmark.
              { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
            ]
            return new Response(chunks.map((data) => `data: ${JSON.stringify({ id: `chatcmpl_${round}`, ...data })}\n\n`).join("")
              + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
          } catch (error) {
            providerErrors.push(error)
            return Response.json({ error: { message: "Fixture assertion failed" } }, { status: 400 })
          }
        },
      })
      const children: Bun.Subprocess[] = []
      const outputs: Promise<string>[] = []
      const spawn = (args: string[]) => {
        const child = Bun.spawn(command(args), {
          cwd: project, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        })
        children.push(child)
        const stdout = new Response(child.stdout).text()
        const stderr = new Response(child.stderr).text()
        outputs.push(stdout, stderr)
        return { child, stdout, stderr }
      }
      type Registration = { id: string; pid: number; url: string; password: string }
      const startHost = async () => {
        const host = spawn(["agent-host", "--directory", project, "--nonce", randomUUID()])
        const registration = await until(async () => {
          if (host.child.exitCode !== null) throw new Error(`Fixture host exited: ${await host.stderr}`)
          return readFile(path.join(home, ".phins/state/agents", `${hash(project)}.json`), "utf8")
            .then((raw) => JSON.parse(raw) as Registration)
            .then((value) => value.pid === host.child.pid ? value : undefined)
            .catch((error) => {
              if (error.code !== "ENOENT") throw error
              return undefined
            })
        })
        return { ...host, registration, connection: {
          url: registration.url, generation: registration.id,
          headers: { authorization: `Basic ${Buffer.from(`phins:${registration.password}`).toString("base64")}` },
        } }
      }
      try {
        await mkdir(path.join(project, "src"), { recursive: true })
        await mkdir(path.join(project, "test"))
        await writeFile(path.join(home, "models.json"), "{}")
        await writeFile(path.join(home, "private-note.txt"), "EXTERNAL_FIXTURE_MUST_NOT_BE_READ")
        await writeFile(path.join(project, "src/add.mjs"), initial)
        const oracle = tests + (mode === "verifier-failure"
          ? "\nimport {writeFileSync} from 'node:fs'; writeFileSync('report.txt', 'checked');\n" : "")
        await writeFile(path.join(project, "test/add.test.mjs"), oracle)
        if (mode !== "missing-snapshot") {
        const init = Bun.spawn(["git", "-c", "init.templateDir=", "init", "--quiet"], {
          cwd: project, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
        })
        expect(await init.exited, await new Response(init.stderr).text()).toBe(0)
        await new Response(init.stdout).text()
        }
        await writeFile(path.join(home, "private-nebius.json"), JSON.stringify({
          ...nebius, snapshots: false,
          agents: { build: { system: workflow } },
          run_budget: { max_turns: 16, max_tokens: 100_000, max_duration_ms: 30_000 },
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...["read", "glob", "grep", "todowrite"].map((action) => ({ action, resource: "*", effect: "allow" })),
            { action: "edit", resource: "src/add.mjs", effect: "allow" },
            { action: "bash", resource: testCommand, effect: "allow" },
          ],
          providers: { nebius: {
            ...nebius.providers.nebius,
            api: { ...nebius.providers.nebius.api, url: `${provider.url}v1` },
          } },
        }))
        const host = await startHost()
        let sessionID: string
        if (mode === "tui") {
          let screen = ""
          const decoder = new TextDecoder()
          const tui = Bun.spawn(command([project]), { cwd: project, env: environment,
            terminal: { cols: 120, rows: 40, data(_terminal, bytes) {
              screen += decoder.decode(bytes, { stream: true })
            } },
          })
          children.push(tui)
          await until(async () => screen.includes("Ask Phins") ? true : undefined)
          tui.terminal!.write("Fix addition and verify the tests\r")
          await until(async () => screen.includes(summary) ? true : undefined)
          const response = await fetch(`${host.registration.url}/api/session`, {
            headers: { ...host.connection.headers, "x-phins-service-generation": host.registration.id },
          })
          const sessions = await response.json() as { data: { id: string }[] }
          expect(sessions.data).toHaveLength(1)
          sessionID = sessions.data[0]!.id
          // Fast loopback tools may finish between render frames. Inspect the
          // persisted transcript by scrolling, rather than depending on a
          // transient filename being painted while the task is running.
          for (let page = 0; page < 8 && !screen.includes("add.mjs"); page++) {
            tui.terminal!.write("\u001b[5~")
            await Bun.sleep(120)
          }
          expect(screen).toContain("add.mjs")
          expect(screen).not.toContain(host.registration.password)
          expect(screen).not.toContain(fixtureKey)
          await until(async () => {
            const data = (await readSessionSnapshot(host.connection, { sessionID, limit: 1 })).data
            if (data.runState?.status === "terminal-failure") throw new Error("TUI independent verification failed")
            return data.runState?.status === "idle" ? true : undefined
          })
          tui.terminal!.write("\u0004")
          await until(async () => tui.exitCode === null ? undefined : true)
          expect(await tui.exited).toBe(0)
        } else {
          const ask = spawn(["ask", "Fix addition and verify the tests", "--project", project, "--format", "json"])
          await until(async () => ask.child.exitCode === null ? undefined : true)
          const stdout = await ask.stdout
          const stderr = await ask.stderr
          expect(providerErrors).toEqual([])
          expect(stdout + stderr).not.toContain(fixtureKey)
          if (mode === "missing-snapshot") {
            expect(await ask.child.exited).not.toBe(0)
            expect(stdout).not.toContain('"status":"completed"')
            expect(calls).toHaveLength(0)
            expect(await readFile(path.join(project, "src/add.mjs"), "utf8")).toBe(initial)
            return
          }
          if (mode === "verifier-failure") {
            expect(await ask.child.exited).not.toBe(0)
            expect(stdout).not.toContain('"status":"completed"')
            expect(await readFile(path.join(project, "src/add.mjs"), "utf8")).toBe(corrected)
            const db = new Database(environment.PHINS_DB, { readonly: true })
            try {
              const receipt = db.query<{ verdict: string; subject_snapshot: string; checks: string }, []>(
                "SELECT verdict, subject_snapshot, checks FROM verification_receipt ORDER BY time_requested DESC LIMIT 1",
              ).get()
              expect(receipt?.verdict).toBe("failed")
              expect(receipt?.subject_snapshot).toMatch(/^[a-f0-9]{40,64}$/)
              expect(JSON.parse(receipt!.checks)[0]).toMatchObject({ status: "failed", exitCode: 1 })
            } finally { db.close() }
            return
          }
          if (mode === "provider-error") {
            expect(await ask.child.exited).not.toBe(0)
            expect(stdout).not.toContain('"status":"completed"')
            expect(await readFile(path.join(project, "src/add.mjs"), "utf8")).toBe(initial)
            expect(calls).toHaveLength(1)
            return
          }
          expect(await ask.child.exited, stderr).toBe(0)
          const result = JSON.parse(stdout)
          expect(result).toMatchObject({ status: "completed", text: summary, evidence: {
            edits: 2, changedFiles: ["src/add.mjs"], correctionAttempts: 1, verification: "unverified",
          } })
          expect(result.evidence.commands.map((command: { exitCode: number }) => command.exitCode)).toEqual([1, 1, 0])
          if (process.env.PHINS_TEST_OS_SANDBOX === "1")
            expect(result.evidence.independentCheck).toMatchObject({ verdict: "passed", freshness: "unverified" })
          sessionID = result.sessionID
        }
        expect(providerErrors).toEqual([])
        expect(calls).toHaveLength(steps.length + 1)
        expect(await readFile(path.join(project, "src/add.mjs"), "utf8")).toBe(corrected)
        expect(hash(await readFile(path.join(project, "test/add.test.mjs"), "utf8"))).toBe(hash(tests))
        const verification = Bun.spawn(["node", "--test", "--test-reporter=tap", "test/add.test.mjs"], {
          cwd: project, env: environment, stdout: "pipe", stderr: "pipe",
        })
        children.push(verification)
        expect(await verification.exited).toBe(0)
        expect(await new Response(verification.stdout).text()).toContain("# pass 2")
        await new Response(verification.stderr).text()
        const snapshot = await readSessionSnapshot(host.connection, { sessionID, limit: 200 })
        expect(snapshot.data.runState?.status).toBe("idle")
        expect(snapshot.data.session.tokens.input).toBe(100 * calls.length)
        expect(snapshot.data.session.tokens.output).toBe(10 * calls.length)
        expect(JSON.stringify(snapshot.data.messages.data)).toContain("Edited file successfully")
        host.child.kill("SIGTERM")
        await host.child.exited
        const restarted = await startHost()
        const restored = await readSessionSnapshot(restarted.connection, { sessionID, limit: 200 })
        expect(restored.data.messages).toEqual(snapshot.data.messages)
        expect(restored.data.session.tokens).toEqual(snapshot.data.session.tokens)
        expect(calls).toHaveLength(steps.length + 1)
      } finally {
        for (const child of children) {
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
          child.terminal?.close()
        }
        await Promise.all(outputs)
        provider.stop(true)
        await rm(home, { recursive: true, force: true })
      }
    }, 60_000,
  )
}
