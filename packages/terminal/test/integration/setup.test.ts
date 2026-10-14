/** Real terminal/host, synthetic credentials and loopback inference only. */
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Redacted } from "effect"
import { createPHINsClient } from "@phins/engine/transport/client/create"
import { ensureProviderConfig, providerSetup, readSelectedModel, saveSelectedModel } from "../../src/shared/provider-setup"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const binary = process.env.PHINS_TEST_CLI_BINARY
const command = (args: string[]) => binary ? [binary, ...args] : [process.execPath, entry, ...args]
const nemotron = "nvidia/nemotron-3-super-120b-a12b"
async function until(read: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(25)
  }
  throw new Error("Local setup fixture timed out")
}

test("fresh profile gets a private key-free preset; existing config and preferences survive", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "phins-setup-profile-"))
  try {
    await ensureProviderConfig(home)
    const file = path.join(home, "config.json")
    const original = await readFile(file, "utf8")
    expect(JSON.parse(original).providers.nebius.env).toEqual(["NEBIUS_API_KEY"])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await ensureProviderConfig(home)
    expect(await readFile(file, "utf8")).toBe(original)
    const external = path.join(home, "explicit")
    await ensureProviderConfig(external, "/private/owner-config.json")
    expect(await stat(external).catch(() => undefined)).toBeUndefined()
    await writeFile(path.join(home, "model.json"), JSON.stringify({ favorite: [{ providerID: "x", modelID: "a" }] }))
    await saveSelectedModel(home, { providerID: "x", modelID: "b" })
    expect(await readSelectedModel(home)).toEqual({ providerID: "x", modelID: "b" })
    expect(JSON.parse(await readFile(path.join(home, "model.json"), "utf8")).favorite).toHaveLength(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

for (const scenario of [
  { name: "prefers Super over the API order", providerID: "nebius",
    ids: ["alpha", "nvidia/nemotron-3-nano-30b-a3b", nemotron], expected: nemotron },
  { name: "uses an available Nemotron when Super is absent", providerID: "nebius",
    ids: ["alpha", "other/nemotron", "nvidia/nemotron-embed", "nvidia/nemotron-3-nano-30b-a3b"],
    expected: "nvidia/nemotron-3-nano-30b-a3b" },
  { name: "does not recommend a disabled model", providerID: "nebius",
    ids: ["alpha", nemotron, "nvidia/nemotron-3-nano-30b-a3b"],
    expected: "nvidia/nemotron-3-nano-30b-a3b", disabled: [nemotron] },
  { name: "keeps choices when no Nemotron is available", providerID: "nebius",
    ids: ["alpha", "beta"], expected: "alpha" },
  { name: "keeps other providers in their original order", providerID: "fixture",
    ids: ["alpha", nemotron], expected: "alpha" },
  { name: "prefers Nemotron in the saved list after refresh failure", providerID: "nebius",
    ids: ["alpha", nemotron], expected: nemotron, refreshFailed: true },
  { name: "puts Nebius first when choosing a provider", providerID: "nebius",
    ids: [nemotron], expected: nemotron, multipleProviders: true },
]) {
  test(`setup model default ${scenario.name}`, async () => {
    const calls: string[] = []
    const client = createPHINsClient({ baseUrl: "http://setup.fixture", fetch: (async (request: Request) => {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/integration") return Response.json({ data: [
        ...(scenario.multipleProviders ? [{ id: "other", name: "Other provider", methods: [{ type: "key" }] }] : []), {
        id: scenario.providerID, name: "Local fixture", methods: [{ type: "key" }],
      }] })
      if (url.pathname === `/api/integration/${scenario.providerID}/connect/key`) {
        expect((await request.json()).key).toBe("synthetic-setup-key")
        return Response.json({ data: {} })
      }
      if (url.pathname === "/api/model") {
        if (scenario.refreshFailed && url.searchParams.has("refresh"))
          return Response.json({ message: "Fixture refresh failed" }, { status: 503 })
        return Response.json({ data: scenario.ids.map((id) => ({
          id, providerID: scenario.providerID, name: id,
          enabled: !scenario.disabled?.includes(id), status: "active",
          capabilities: { tools: !id.endsWith("-embed"), input: ["text"], output: ["text"] },
        })) })
      }
      throw new Error(`Unexpected setup request: ${url.pathname}`)
    }) as typeof fetch })
    let titles: string[] = []
    let message = ""
    const selected = await Effect.runPromise(providerSetup(client, { directory: "/tmp/setup-fixture" }, {
      password: () => Effect.succeed(Redacted.make("synthetic-setup-key")),
      select: (options) => {
        expect<unknown>(options.choices[0]!.value).toBe("nebius")
        return Effect.succeed(options.choices[0]!.value)
      },
      model: (options) => {
        titles = options.choices.map((choice) => choice.title + (choice.recommended ? " (recommended)" : ""))
        message = options.message
        return Effect.succeed(options.choices[0]!.value)
      },
    }))
    expect(selected).toEqual({ providerID: scenario.providerID, modelID: scenario.expected })
    const recommended = scenario.expected.startsWith("nvidia/")
    expect(titles[0]).toBe(scenario.expected + (recommended ? " (recommended)" : ""))
    expect(titles.filter((title) => title.endsWith(" (recommended)"))).toHaveLength(recommended ? 1 : 0)
    expect(titles.map((title) => title.replace(" (recommended)", ""))).toEqual([
      scenario.expected, ...scenario.ids.filter((id) => id !== scenario.expected),
    ])
    expect(message.includes("API refresh failed")).toBe(!!scenario.refreshFailed)
    expect(calls).toEqual([
      "GET /api/integration", `POST /api/integration/${scenario.providerID}/connect/key`,
      "GET /api/model", ...(scenario.refreshFailed ? ["GET /api/model"] : []),
    ])
  })
}

for (const mode of ["cli", "tui", "cli-nebius-default", "cli-cancel-model", "tui-nebius-default", "tui-nebius-override", "tui-paste", "tui-cancel-key", "tui-cancel-model", "tui-cancel-ctrl-c", "cancel", "invalid"] as const) {
  test.skipIf(process.platform === "win32")(`${mode} setup masks the key and selects a model without inference`, async () => {
    const tui = mode.startsWith("tui")
    const nebius = mode.includes("nebius")
    const providerID = nebius ? "nebius" : "fixture"
    const expectedModel = mode === "tui-nebius-override" ? "alpha" : nebius ? nemotron : "beta"
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-provider-setup-")))
    const project = path.join(home, "project")
    const key = `synthetic-setup-secret-${randomUUID()}`
    let requests = 0
    let modelRequests = 0
    const failures: unknown[] = []
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`)
        if (new URL(request.url).pathname === "/v1/models") {
          modelRequests++
          expect(request.method).toBe("GET")
          if (mode === "invalid") return Response.json({ detail: `Invalid key: ${key}` }, { status: 401 })
          return Response.json({ object: "list", data: [
            { id: "alpha" }, { id: "beta" },
            ...(nebius ? [{ id: nemotron }] : []),
            ...(mode === "tui" && modelRequests > 1 ? [{ id: "gamma" }] : []),
          ] })
        }
        requests++
        const body = await request.json() as { model: string }
        expect(body.model).toBe(expectedModel)
        if (mode === "invalid") return Response.json({ error: {
          message: `Invalid API key: ${key}`, type: "authentication_error",
        } }, { status: 401 })
        return new Response([
          { choices: [{ delta: { role: "assistant", content: "SETUP_LOCAL_OK" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } })
      } catch (error) {
        failures.push(error)
        return Response.json({ error: { message: "Local fixture failed" } }, { status: 400 })
      }
    } })
    const children: Bun.Subprocess[] = []
    let screen = ""
    const environment = {
      PATH: process.env.PATH, TMPDIR: os.tmpdir(), TERM: "xterm-256color",
      PHINS_TEST_HOME: home, PHINS_CONFIG_DIR: path.join(home, "config"),
      PHINS_CONFIG: path.join(home, "private.json"), PHINS_DB: path.join(home, "runtime.db"),
      PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
      PHINS_DISABLE_MODELS_FETCH: "true", PHINS_DISABLE_AUTOUPDATE: "true",
      PHINS_MODELS_PATH: path.join(home, "models.json"), PHINS_REDUCED_MOTION: "true",
      PHINS_CHANNEL: "local",
    }
    try {
      await mkdir(project)
      await writeFile(path.join(home, "models.json"), "{}")
      await writeFile(environment.PHINS_CONFIG, JSON.stringify({
        model: `${providerID}/alpha`, snapshots: false,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        providers: { [providerID]: {
          name: "Local Fixture", env: ["UNSET_SETUP_FIXTURE_KEY"],
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
          models: Object.fromEntries((mode === "invalid" ? ["alpha", "beta"]
            : nebius ? ["alpha", nemotron] : ["alpha"]).map((id) => [id, {
            name: id === nemotron ? "NVIDIA Nemotron 3 Super" : id === "alpha" ? "Alpha" : "Beta",
            capabilities: { tools: id === nemotron, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 128 },
          }])),
        } },
      }))
      const host = Bun.spawn(command(["agent-host", "--directory", project, "--nonce", randomUUID()]), {
        cwd: project, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      children.push(host)
      const logs = Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()])
      const registration = path.join(home, ".phins/state/agents", `${createHash("sha256").update(project).digest("hex")}.json`)
      await until(async () => readFile(registration, "utf8")
        .then((text) => JSON.parse(text).pid === host.pid).catch(() => false))
      const terminal = Bun.spawn(command(tui ? [project] : ["setup", "--project", project]), {
        cwd: project, env: environment,
        terminal: { cols: 120, rows: 40, data(_terminal, bytes) { screen += new TextDecoder().decode(bytes) } },
      })
      children.push(terminal)
      if (tui) {
        await until(() => screen.includes("Ask Phins"))
        terminal.terminal!.write("/setup")
        await until(() => screen.includes("Set API key and model"))
        await Bun.sleep(100)
        terminal.terminal!.write("\r")
      }
      await until(() => screen.includes("API key (saved locally; no inference)"))
      if (tui) expect(screen.includes("\u001b[?1049l")).toBe(false)
      if (mode === "cancel") {
        terminal.terminal!.write("\u0003")
        await until(() => terminal.exitCode !== null)
        expect(await readSelectedModel(path.join(home, ".phins/state"))).toBeUndefined()
        expect(requests).toBe(0)
        expect(modelRequests).toBe(0)
        return
      }
      const send = (text: string) => terminal.terminal!.write(text)
      const paste = (text: string) => send(`\u001b[200~${text}\u001b[201~`)
      async function cancelAndReopen(cancel: string) {
        send(cancel)
        await Bun.sleep(150)
        expect(terminal.exitCode).toBeNull()
        expect(await readSelectedModel(path.join(home, ".phins/state"))).toBeUndefined()
        expect(requests).toBe(0)
        expect(screen).not.toContain(key)
        const before = screen.length
        send("/setup")
        await until(() => screen.slice(before).includes("Set API key and model"))
        await Bun.sleep(80)
        send("\r")
        await until(() => screen.slice(before).includes("API key (saved locally; no inference)"))
      }
      await Bun.sleep(80)
      if (mode === "tui-cancel-key" || mode === "tui-cancel-ctrl-c") {
        send(key)
        await Bun.sleep(80)
        await cancelAndReopen(mode === "tui-cancel-key" ? "\u001b" : "\u0003")
      }
      if (mode === "tui-paste") {
        send("\r")
        await until(() => screen.includes("Enter a non-empty, single-line API key."))
        paste("broken\nkey")
        // The terminal can redraw only changed spans of the previous error.
        await until(() => screen.includes("4096 characters"))
        paste("discard-this")
        send("\u0015") // ctrl+u clears the entire field
        paste(` ${key}x\n`)
        send("\u007f\r") // backspace, then submit
      } else send(key + "\r")
      await until(() => screen.includes("Default model"))
      if (mode === "cli-cancel-model") {
        send("\u001b")
        await until(() => terminal.exitCode !== null)
        expect(await terminal.exited).not.toBe(0)
        expect(await readSelectedModel(path.join(home, ".phins/state"))).toBeUndefined()
        expect(requests).toBe(0)
        expect(modelRequests).toBe(1)
        expect(screen).not.toContain(key)
        return
      }
      if (mode === "invalid") expect(screen).toContain("API refresh failed")
      if (mode === "tui-cancel-model") {
        await cancelAndReopen("\u001b")
        const before = screen.length
        paste(key)
        send("\r")
        await until(() => screen.slice(before).includes("Default model"))
      }
      if (nebius) await until(() => screen.includes("(recommended)"))
      if (mode === "tui-nebius-override") {
        // Current-model hydration can expand a group; choose by name, not row offset.
        const before = screen.length
        send("alpha")
        await until(() => screen.slice(before).includes("alpha"))
      } else if (!nebius) terminal.terminal!.write("\u001b[B")
      await Bun.sleep(80)
      terminal.terminal!.write("\r")
      await until(async () => (await readSelectedModel(path.join(home, ".phins/state")))?.modelID === expectedModel)
      expect(await readSelectedModel(path.join(home, ".phins/state")))
        .toEqual({ providerID, modelID: expectedModel })
      if (tui) {
        await until(() => screen.includes("Setup saved"))
        expect(screen.includes("\u001b[?1049l")).toBe(false)
        if (mode === "tui") {
          const before = screen.length
          send("/models")
          await until(() => screen.slice(before).includes("Switch model"))
          send("\r")
          await until(() => screen.slice(before).includes("gamma"))
          send("\u001b")
          await Bun.sleep(100)
          expect(await readSelectedModel(path.join(home, ".phins/state")))
            .toEqual({ providerID: "fixture", modelID: "beta" })
        }
        terminal.terminal!.write("\u0004")
      }
      await until(() => terminal.exitCode !== null)
      expect(await terminal.exited).toBe(0)
      expect(screen).not.toContain(key)
      expect(requests).toBe(0)
      expect(modelRequests).toBe(mode === "tui-cancel-model" || mode === "tui" ? 2 : 1)
      // End the host so the next process must load the saved API catalog.
      host.kill("SIGTERM")
      await host.exited
      // A new headless process uses the persisted key and default model.
      const ask = Bun.spawn(command(["ask", "Reply SETUP_LOCAL_OK", "--project", project]), {
        cwd: project, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      children.push(ask)
      const output = Promise.all([new Response(ask.stdout).text(), new Response(ask.stderr).text()])
      await until(() => ask.exitCode !== null)
      const [stdout, stderr] = await output
      if (mode === "invalid") expect(await ask.exited).not.toBe(0)
      else {
        expect(await ask.exited, stderr).toBe(0)
        expect(stdout).toContain("SETUP_LOCAL_OK")
      }
      expect(stdout + stderr).not.toContain(key)
      expect(requests).toBe(1)
      expect(failures).toEqual([])
      expect(await readFile(environment.PHINS_CONFIG, "utf8")).not.toContain(key)
      expect((await logs).join("\n")).not.toContain(key)
    } catch (error) {
      const safeScreen = screen.replaceAll(key, "[redacted]").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/ {4,}/g, " ")
      throw new Error(`${mode} setup failed (terminal=${children[1]?.exitCode}): ${safeScreen.slice(-6000)}`, { cause: error })
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
        child.terminal?.close()
      }
      provider.stop(true)
      // Local hosts observe client exit and drain before fixture cleanup.
      await Bun.sleep(300)
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)
}


test("setup refuses piped secret input without writing credentials", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "phins-setup-headless-"))
  try {
    const child = Bun.spawn(command(["setup", "--project", home]), {
      cwd: home, env: { PATH: process.env.PATH, PHINS_TEST_HOME: home,
        PHINS_DISABLE_MODELS_FETCH: "true", PHINS_DISABLE_AUTOUPDATE: "true" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    child.stdin.end()
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(await child.exited).not.toBe(0)
    expect(stdout + stderr).toContain("interactive terminal")
    expect(await readSelectedModel(path.join(home, ".phins/state"))).toBeUndefined()
  } finally { await rm(home, { recursive: true, force: true }) }
})
