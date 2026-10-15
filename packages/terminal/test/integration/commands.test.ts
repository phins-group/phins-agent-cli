/** Real local CLI/TUI; synthetic project with catalog reads but no inference. */
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import stripAnsi from "strip-ansi"
import { connectLocalService } from "@phins/engine/transport/client/connection"

const binary = process.env.PHINS_TEST_CLI_BINARY
const command = (args: string[]) => binary ? [binary, ...args]
  : [process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), ...args]
async function until(read: () => boolean | Promise<boolean>, diagnostic: () => string = () => "") {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(25)
  }
  throw new Error(`Command fixture timed out: ${stripAnsi(diagnostic()).slice(-9000)}`)
}

test("CLI help exposes setup, uninstall, ask and resume but keeps its execution host internal", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "phins-command-help-"))
  try {
    const child = Bun.spawn(command(["--help"]), {
      env: { PATH: process.env.PATH, PHINS_TEST_HOME: home },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(await child.exited).toBe(0)
    for (const name of ["setup", "uninstall", "ask", "resume"]) expect(out).toContain(name)
    expect(out + err).not.toContain("agent-host")
    expect(out + err).not.toContain("session watch")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("TUI orders seven commands consistently and rejects removed actions without inference", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-command-menu-")))
  let modelCalls = 0
  let catalogReads = 0
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
      catalogReads++
      return Response.json({ data: [{ id: "alpha" }] })
    }
    modelCalls++
    return Response.json({ error: "Unexpected inference in command fixture" }, { status: 500 })
  } })
  const env = { PATH: process.env.PATH, TMPDIR: os.tmpdir(), TERM: "xterm-256color",
    PHINS_TEST_HOME: home, PHINS_CONFIG_DIR: path.join(home, "config"),
    PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"), PHINS_DB: ":memory:",
    PHINS_MODELS_PATH: path.join(home, "models.json"), PHINS_CHANNEL: "local",
    PHINS_DISABLE_MODELS_FETCH: "true", PHINS_DISABLE_AUTOUPDATE: "true", PHINS_REDUCED_MOTION: "true" }
  const children: Bun.Subprocess[] = []
  let screen = ""
  try {
    await writeFile(env.PHINS_MODELS_PATH, "{}")
    await writeFile(path.join(home, "phins.json"), JSON.stringify({ model: "fixture/alpha", snapshots: false,
      permissions: [{ action: "*", resource: "*", effect: "deny" }], providers: { fixture: {
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
        request: { body: { apiKey: "synthetic-command-fixture" } }, models: {
          alpha: { capabilities: { tools: false, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 128 }, variants: [{ id: "fast" }] },
        },
      } },
    }))
    const host = Bun.spawn(command(["agent-host", "--directory", home, "--nonce", randomUUID()]), {
      cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    children.push(host)
    const logs = Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()])
    const registration = path.join(home, ".phins/state/agents", `${createHash("sha256").update(home).digest("hex")}.json`)
    await until(() => readFile(registration, "utf8").then(() => true).catch(() => false))
    const registered = JSON.parse(await readFile(registration, "utf8"))
    const connection = { url: registered.url, generation: registered.id,
      headers: { authorization: `Basic ${Buffer.from(`phins:${registered.password}`).toString("base64")}` } }
    const opened = await fetch(connection.url + "/api/agent/client/open", { method: "POST",
      headers: { ...connection.headers, "x-phins-service-generation": connection.generation,
        "content-type": "application/json" }, body: JSON.stringify({ kind: "tui" }) })
    expect(opened.status).toBe(200)
    Object.assign(connection.headers, { "x-phins-agent-client": (await opened.json() as { clientID: string }).clientID })
    const client = await connectLocalService(connection)
    const session = (await client.v2.session.create({ title: "Command menu fixture", location: { directory: home } },
      { throwOnError: true })).data.data
    await client.v2.session.prompt({ sessionID: session.id, id: `msg_${randomUUID()}`,
      prompt: { text: "LOCAL_TRANSCRIPT_EVIDENCE" }, delivery: "queue", resume: false }, { throwOnError: true })
    expect((await client.v2.command.list({ location: { directory: home } }, { throwOnError: true })).data.data).toEqual([])
    // Hand control to the real TUI. A seed client's queued prompt owns the
    // session even while idle, so leaving that lease open makes TUI read-only.
    const closed = await fetch(connection.url + "/api/agent/client/close", { method: "POST",
      headers: { ...connection.headers, "x-phins-service-generation": connection.generation,
        "content-type": "application/json" }, body: JSON.stringify({ background: false }) })
    expect(closed.status).toBe(200)
    const terminal = Bun.spawn(command([home, "--session", session.id]), { cwd: home, env,
      terminal: { cols: 120, rows: 50, data(_terminal, bytes) { screen += new TextDecoder().decode(bytes) } },
    })
    children.push(terminal)
    const send = (text: string) => terminal.terminal!.write(text)
    const shown = (value: string) => until(() => stripAnsi(screen).includes(value), () => screen)
    let width = 125
    const redraw = async () => {
      await Bun.sleep(100)
      screen = ""
      terminal.terminal!.resize(++width, 50)
    }
    await shown("LOCAL_TRANSCRIPT_EVIDENCE")
    send("\u0010") // Ctrl+P, global palette
    await shown("Commands")
    await Bun.sleep(100)
    screen = ""
    terminal.terminal!.resize(121, 50)
    await shown("/compact")
    await shown("/setup")
    const names = [...new Set(stripAnsi(screen).match(/(?<!\w)\/[a-z][a-z-]*(?=\s)/g))]
    expect(names).toEqual(["/models", "/new", "/sessions", "/compact", "/setup", "/help", "/exit"])
    expect(screen).not.toContain("OC |")
    if (process.env.PHINS_COMMAND_CAPTURE) {
      await mkdir(process.env.PHINS_COMMAND_CAPTURE, { recursive: true })
      await writeFile(path.join(process.env.PHINS_COMMAND_CAPTURE, "palette.ansi"), screen)
    }
    send("\u001b")
    await Bun.sleep(100)
    screen = ""
    send("/")
    await shown("Switch model")
    await redraw()
    await shown("/exit")
    const completionNames = [...new Set(stripAnsi(screen).match(/(?<!\w)\/[a-z][a-z-]*(?=\s)/g))]
    expect(completionNames).toEqual(names)
    send("\u0003")
    await Bun.sleep(100)
    const retiredCommands = ["undo", "redo", "diff", "export", "agents", "providers", "background", "connect", "init", "review"]
    for (const [index, retired] of retiredCommands.entries()) {
      screen = ""
      send(`/${retired} `) // trailing space closes completion without discarding the draft
      await Bun.sleep(100)
      send("\r")
      await Bun.sleep(100)
      terminal.terminal!.resize(120 + index % 2, 50)
      await shown("Unknown command or arguments")
      expect(modelCalls).toBe(0)
      send("\u0003") // clear retained input, not the running process
      await Bun.sleep(100)
      expect(terminal.exitCode).toBeNull()
    }
    // The same model must still offer its variant selector after one was chosen.
    for (let i = 0; i < 2; i++) {
      screen = ""
      send("/models")
      await shown("Switch model")
      send("\r")
      await shown("Select model")
      await Bun.sleep(100)
      send("\r")
      await redraw()
      await shown("Select variant")
      if (i === 0) send("\u001b[B")
      send("\r")
      await Bun.sleep(100)
    }
    expect(catalogReads).toBe(2)
    expect(modelCalls).toBe(0)
    screen = ""
    send("/sessions")
    await shown("Switch session")
    send("\r")
    await shown("Sessions")
    send("\u0012") // rename remains inside /sessions
    await shown("Rename Session")
    await Bun.sleep(100)
    send("\u0005 renamed")
    await shown("renamed")
    send("\r")
    let renamedTitle = ""
    await until(async () => {
      renamedTitle = (await client.v2.session.get({ sessionID: session.id }, { throwOnError: true })).data.data.title
      return renamedTitle.includes("renamed")
    }, () => screen + `\nRecorded title: ${renamedTitle}`)
    // Persistence can finish before the rename dialog receives its response.
    await until(async () => {
      await redraw()
      await shown("LOCAL_TRANSCRIPT_EVIDENCE")
      return !stripAnsi(screen).includes("Rename Session")
    }, () => screen)
    screen = ""
    send("/help")
    await shown("Help")
    send("\r")
    await shown("PHINs Agent help")
    await redraw()
    await shown("PHINs Agent help")
    await shown("/setup")
    // Read the dialog after its heading, excluding the draft behind the overlay.
    const helpFrame = stripAnsi(screen).split("PHINs Agent help").at(-1)!
    const helpNames = [...new Set(helpFrame.match(/(?<!\w)\/[a-z][a-z-]*(?=\s)/g))]
    expect(helpNames).toEqual(names)
    expect(stripAnsi(screen)).not.toContain("project skills")
    expect(stripAnsi(screen)).not.toContain("configured MCPs")
    send("\u0014")
    await redraw()
    await shown("Display options")
    expect(modelCalls).toBe(0)
    send("\u001b")
    await Bun.sleep(100)
    send("\u0004")
    await until(() => terminal.exitCode !== null, () => screen)
    expect(await terminal.exited).toBe(0)
    expect(stripAnsi(screen)).toContain(`phins resume ${session.id}`)
    host.kill("SIGTERM")
    await host.exited
    await logs
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      child.terminal?.close()
    }
    provider.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
