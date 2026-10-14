import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { connectLocalService, readSessionSnapshot } from "@phins/engine/transport/client/connection"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const ownerEntry = path.resolve(import.meta.dir, "../../src/index.ts")
// Optional local build verification; the normal suite always uses source.
const binary = process.env.PHINS_TUI_FIXTURE_BINARY
const command = (source: string, args: string[]) => binary
  ? [binary, ...args] : [process.execPath, source, ...args]
async function until<T>(read: () => Promise<T | undefined>, diagnostic: () => string = () => "") {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`TUI fixture timed out: ${diagnostic().slice(-3000)}`)
}

test.skipIf(process.platform === "win32")("full TUI works without Node, preserves lost-ACK drafts and stops its work on exit", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-agent-tui-")))
  const environment = {
    PATH: process.env.PATH, TMPDIR: os.tmpdir(), TERM: "xterm-256color",
    PHINS_TEST_HOME: home, PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
    PHINS_CONFIG_DIR: path.join(home, "config"), PHINS_DB: ":memory:",
    PHINS_DISABLE_MODELS_FETCH: "true",
    // Disable the animated per-character status gradient in this deterministic
    // PTY fixture; matching raw terminal chunks is not a screen emulator.
    PHINS_REDUCED_MOTION: "true",
    PHINS_MODELS_PATH: path.resolve(import.meta.dir, "../../../engine/test/plugin/fixtures/models-dev.json"),
  }
  let calls = 0
  let finish = () => {}
  let delta = () => {}
  const encoder = new TextEncoder()
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    const body = await request.json() as { messages: { role: string; content: unknown }[] }
    expect(body.messages.some((message) => JSON.stringify(message.content).includes("Kiểm tra TUI"))).toBe(true)
    calls++
    const chunk = (content: string, reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({
      id: "chatcmpl_fixture", choices: [{ delta: { content }, finish_reason: reason }],
      usage: reason === "stop" ? { prompt_tokens: 10000, completion_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 200 } } : null,
    })}\n\n`)
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(chunk(""))
      delta = () => controller.enqueue(chunk("Native stream fixture"))
      finish = () => {
        try {
          controller.enqueue(chunk(" finished", "stop"))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch { /* The explicit Stop may already have closed this stream. */ }
      }
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  let owner: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let logs: Promise<unknown> | undefined
  let proxy: ReturnType<typeof Bun.serve> | undefined
  const terminals: Bun.Subprocess[] = []
  let output = ""
  const open = (args: string[]) => {
    const decoder = new TextDecoder()
    const child = Bun.spawn(command(entry, args), { cwd: home, env: environment,
      terminal: { cols: 120, rows: 36, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }) } },
    })
    terminals.push(child)
    return child
  }
  try {
    await writeFile(path.join(home, "phins.json"), JSON.stringify({
      model: "fixture/alpha", snapshots: false, providers: { fixture: {
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
        request: { body: { apiKey: "fixture-only-key" } },
        models: { alpha: { capabilities: { tools: false, input: ["text"], output: ["text"] },
          limit: { context: 100000, output: 128 },
          cost: { input: 2, output: 6, cache: { read: 0.5, write: 2 } } } },
      } },
    }), { mode: 0o600 })
    owner = Bun.spawn(command(ownerEntry, ["agent-host", "--directory", home, "--nonce", randomUUID()]), {
      cwd: home, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    let ownerOutput = ""
    logs = Promise.all([owner.stdout, owner.stderr].map(async (stream) => {
      ownerOutput += await new Response(stream).text()
    }))
    const registrationPath = path.join(home, ".phins/state/agents", `${createHash("sha256").update(home).digest("hex")}.json`)
    const registration = await until(() => readFile(registrationPath, "utf8")
      .then((raw) => JSON.parse(raw) as { url: string; id: string; password: string }).catch(() => undefined), () => ownerOutput)
    const password = registration.password
    const connection = { url: registration.url, generation: registration.id,
      headers: { authorization: `Basic ${Buffer.from(`phins:${password}`).toString("base64")}` } }
    const client = await connectLocalService(connection)
    const runState = async (sessionID: string) => (await readSessionSnapshot(connection, { sessionID })).data.runState
    let rejected = false
    let promptPosts = 0
    let releaseAck = () => {}
    const ack = new Promise<void>((resolve) => { releaseAck = resolve })
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
      const route = new URL(request.url)
      const prompt = request.method === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(route.pathname)
      if (prompt) promptPosts++
      if (!rejected && prompt) {
        rejected = true
        return Response.json({ message: "Admission fixture rejected" }, { status: 503 })
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      const response = await fetch(new Request(`${registration.url}${route.pathname}${route.search}`, new Request(request, { headers })))
      if (prompt) {
        await ack
        // The owner has admitted the intent, but this response loses its ACK.
        // Recovery must use GET by ID, never another prompt POST or Resume.
        return Response.json({ message: "Acknowledgement fixture lost" }, { status: 503 })
      }
      return response
    } })
    // This fixture-only proxy rejects the first admission before it reaches the
    // owner; it never touches a real registration or provider.
    const registered = JSON.parse(await readFile(registrationPath, "utf8"))
    await writeFile(registrationPath, JSON.stringify({ ...registered, url: proxy.url.origin }))
    // No arguments must open the same TUI for the current working directory.
    const first = open([])
    await until(async () => output.includes("Ask Phins") ? true : undefined, () => output)
    expect((await client.v2.session.list({ directory: home })).data?.data).toEqual([])
    first.terminal!.write("Kiểm tra TUI\r")
    await until(async () => rejected && output.includes("Failed to send prompt") ? true : undefined, () => output)
    expect(calls).toBe(0)
    // Retry using Enter alone: the draft must survive rejection and remount,
    // and its already-created session must be reused.
    first.terminal!.write("\r")
    await until(async () => calls === 1 ? true : undefined, () => output)
    await until(async () => output.includes("Running") ? true : undefined, () => output)
    first.terminal!.write(" - next draft")
    await until(async () => output.includes("next draft") ? true : undefined, () => output)
    output = ""
    releaseAck()
    await until(async () => readFile(path.join(home, ".phins/state/prompt-history.jsonl"), "utf8")
      .then((raw) => raw.includes("Kiểm tra TUI") ? true : undefined).catch(() => undefined), () => output)
    first.terminal!.resize(121, 36)
    // The successful ACK must not erase text edited after dispatch, including
    // a redraw. It also must not record that text as sent.
    await until(async () => output.includes("next draft") ? true : undefined, () => output)
    const promptHistory = await readFile(path.join(home, ".phins/state/prompt-history.jsonl"), "utf8")
    expect(promptHistory).toContain("Kiểm tra TUI")
    expect(promptHistory).not.toContain("next draft")
    expect(promptPosts).toBe(2)
    delta()
    await until(async () => output.includes("stream fixture") ? true : undefined, () => output)
    const sessions = (await client.v2.session.list({ directory: home })).data!.data
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.title).toBe("Kiểm tra TUI")
    const id = sessions[0]!.id
    expect((await runState(id))?.status).toBe("busy")
    // Original exit bindings are intentionally disabled with a non-empty
    // focused draft. Clear it explicitly, then detach through the old keymap.
    first.terminal!.write("\u0003")
    await Bun.sleep(100)
    first.terminal!.write("\u0004")
    await until(async () => first.exitCode === null ? undefined : true, () => output)
    expect(await first.exited).toBe(0)
    expect(owner.exitCode).toBeNull()
    expect((await runState(id))?.status).toBe("interrupted")
    output = ""
    const second = open([home, "--session", id])
    await until(async () => output.includes("Kiểm tra TUI") ? true : undefined, () => output)
    expect(calls).toBe(1)
    const beforeSecondPrompt = output.length
    second.terminal!.write("Kiểm tra TUI lần hai\r")
    await until(async () => calls === 2 ? true : undefined, () => output)
    // Provider admission precedes the client ACK/event projection. Exercise
    // Stop only once this TUI has actually rendered the new running state.
    await until(async () => output.slice(beforeSecondPrompt).includes("Running")
      ? true : undefined, () => output)
    // The original TUI deliberately requires Escape twice to stop a run.
    second.terminal!.write("\u001b")
    await Bun.sleep(100)
    second.terminal!.write("\u001b")
    await until(async () => (await runState(id))?.status === "interrupted"
      ? true : undefined, () => output)
    expect(calls).toBe(2)
    expect((await client.v2.session.list({ directory: home })).data?.data).toHaveLength(1)
    // A completed local provider stream must reach both persisted totals and
    // the real TUI footer, including cached input and reasoning usage.
    second.terminal!.write("Kiểm tra TUI usage\r")
    await until(async () => calls === 3 ? true : undefined, () => output)
    finish()
    const settled = await until(async () => {
      const snapshot = (await readSessionSnapshot(connection, { sessionID: id })).data
      return snapshot.session.cost > 0 ? snapshot : undefined
    }, () => output)
    expect(settled.session.title).toBe("Kiểm tra TUI")
    expect(settled.session.cost).toBeCloseTo(0.0245, 10)
    expect(settled.session.tokens).toEqual({ input: 9000, output: 800, reasoning: 200,
      cache: { read: 1000, write: 0 } })
    // A resize produces a full frame; incremental ANSI updates can contain
    // only the changed digits of a previously rendered cost.
    second.terminal!.resize(160, 40)
    await until(async () => output.includes("~0.0245") && output.includes("11%") ? true : undefined, () => output)
    expect(output).toContain("TỪ Ý TƯỞNG ĐẾN CÔNG VIỆC HOÀN THÀNH")
    const listStart = output.length
    second.terminal!.write("/sessions")
    await until(async () => output.slice(listStart).includes("Switch session") ? true : undefined, () => output)
    second.terminal!.write("\r")
    await until(async () => output.slice(listStart).includes("pin/unpin") ? true : undefined, () => output)
    expect(output.slice(listStart)).toContain("Kiểm tra TUI")
    expect(output.slice(listStart)).not.toContain("New session -")
    // Switch the banner in the real TUI, then reopen to verify persistence.
    second.terminal!.write("\u001b")
    await Bun.sleep(100)
    const helpStart = output.length
    second.terminal!.write("/help")
    await until(async () => output.slice(helpStart).includes("Help") ? true : undefined, () => output)
    second.terminal!.write("\r")
    await until(async () => output.slice(helpStart).includes("PHINs Agent help") ? true : undefined, () => output)
    second.terminal!.write("\u0014")
    await until(async () => output.slice(helpStart).includes("Switch tagline to English") ? true : undefined, () => output)
    second.terminal!.write("\u001b[B".repeat(6))
    second.terminal!.write("\r")
    await until(async () => readFile(path.join(home, ".phins/state/kv.json"), "utf8")
      .then((raw) => JSON.parse(raw).tagline_language === "en" ? true : undefined)
      .catch(() => undefined), () => output)
    second.terminal!.write("\u001b")
    await Bun.sleep(100)
    await until(async () => output.slice(helpStart).includes("FROM IDEAS to IMPACT") ? true : undefined, () => output)
    second.terminal!.write("\u0004")
    await until(async () => second.exitCode === null ? undefined : true, () => output)
    expect(await second.exited).toBe(0)
    expect(output).not.toContain(password)
    expect(output).not.toContain("fixture-only-key")
    expect((await client.v2.service.status()).data).toMatchObject({ id: registration.id })
    output = ""
    const third = open([home, "--session", id])
    third.terminal!.resize(160, 40)
    await until(async () => output.includes("FROM IDEAS to IMPACT") && output.includes("Kiểm tra TUI")
      ? true : undefined, () => output)
    expect(output).not.toContain("TỪ Ý TƯỞNG")
    expect(calls).toBe(3)
    third.terminal!.write("\u0004")
    await until(async () => third.exitCode === null ? undefined : true, () => output)
    expect(await third.exited).toBe(0)
  } finally {
    try { finish() } catch { /* The fixture stream may already be cancelled. */ }
    for (const child of terminals) {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      child.terminal?.close()
    }
    owner?.kill("SIGTERM")
    await owner?.exited
    await logs
    proxy?.stop(true)
    provider.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 35000)
