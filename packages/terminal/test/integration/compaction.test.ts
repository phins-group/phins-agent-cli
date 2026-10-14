/** Local provider fixture: exercises real compaction/persistence, not model quality. */
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPHINsClient, type GlobalEvent } from "@phins/engine/transport/client/create"
import { connectLocalService } from "@phins/engine/transport/client/connection"
import { createTuiTransport } from "../../src/tui/transport/client"
import { contextUsage } from "../../src/tui/render/context-usage"

test("TUI compact commits reduced context, honors the selected model and survives reopening and provider failure", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-compact-")))
  const requests: { model: string; messages: unknown[]; tools?: unknown[] }[] = []
  let rejectSummary = false
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [{ id: "alpha" }, { id: "beta" }] })
    const body = await request.json() as typeof requests[number]
    requests.push(body)
    const compacting = JSON.stringify(body.messages).includes("<template>")
    if (compacting && rejectSummary)
      return Response.json({ error: { message: "Fixture summary rejected", type: "invalid_request_error" } }, { status: 400 })
    const content = compacting ? "## Goal\n- Preserve validation and run tests."
      : "OLD_RESPONSE_MARKER " + "Recorded local fixture details. ".repeat(600)
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: {
        prompt_tokens: compacting ? 5000 : 30000, completion_tokens: compacting ? 20 : 1000, total_tokens: compacting ? 5020 : 31000,
      } },
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "fixture", ...chunk })}\n\n`).join("")
      + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  let owner: Bun.Subprocess | undefined
  let logs: Promise<string[]> | undefined
  let transport: Awaited<ReturnType<typeof createTuiTransport>> | undefined
  try {
    await writeFile(path.join(home, "models.json"), "{}")
    const model = { capabilities: { tools: false, input: ["text"], output: ["text"] }, limit: { context: 100000, output: 4096 } }
    await writeFile(path.join(home, "phins.json"), JSON.stringify({ model: "fixture/alpha", snapshots: false,
      compaction: { auto: false }, permissions: [{ action: "*", resource: "*", effect: "deny" }], providers: { fixture: {
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
        request: { body: { apiKey: "synthetic-compaction-fixture" } }, models: { alpha: model, beta: model },
      } },
    }))
    const binary = process.env.PHINS_TEST_CLI_BINARY
    const child = Bun.spawn([...(binary ? [binary] : [process.execPath, path.resolve(import.meta.dir, "../../src/index.ts")]),
      "agent-host", "--directory", home, "--nonce", randomUUID()], {
      cwd: home, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), PHINS_TEST_HOME: home,
        PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"), PHINS_CONFIG_DIR: path.join(home, "config"),
        PHINS_DB: path.join(home, "session.db"), PHINS_CHANNEL: "local", PHINS_DISABLE_MODELS_FETCH: "true",
        PHINS_MODELS_PATH: path.join(home, "models.json") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    owner = child
    logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    let registration: { url: string; id: string; password: string } | undefined
    for (let attempt = 0; attempt < 600 && owner.exitCode === null; attempt++) {
      registration = await readFile(path.join(home, ".phins/state/agents",
        `${createHash("sha256").update(home).digest("hex")}.json`), "utf8").then(JSON.parse).catch(() => undefined)
      if (registration) break
      await Bun.sleep(25)
    }
    expect(registration).toBeDefined()
    const connection = { url: registration!.url, generation: registration!.id,
      headers: { authorization: `Basic ${Buffer.from(`phins:${registration!.password}`).toString("base64")}` } }
    const opened = await fetch(`${connection.url}/api/agent/client/open`, { method: "POST",
      headers: { ...connection.headers, "x-phins-service-generation": connection.generation, "content-type": "application/json" },
      body: JSON.stringify({ kind: "tui" }),
    })
    expect(opened.ok).toBe(true)
    Object.assign(connection.headers, { "x-phins-agent-client": (await opened.json()).clientID })
    const native = await connectLocalService(connection)
    const call = { throwOnError: true } as const
    const sessionID = (await native.v2.session.create({ location: { directory: home }, model: { providerID: "fixture", id: "alpha" } }, call)).data.data.id
    await native.v2.session.prompt({ sessionID, prompt: { text: "OLD_REQUEST_MARKER preserve validation and fix the bug" }, resume: true }, call)
    await native.v2.session.wait({ sessionID }, call)
    transport = await createTuiTransport(connection, home)
    const events: GlobalEvent[] = []
    await transport.events.subscribe((event) => events.push(event))
    let client = createPHINsClient({ baseUrl: connection.url, directory: home, fetch: transport.fetch })
    const usage = (entries: NonNullable<Awaited<ReturnType<typeof client.session.messages>>["data"]>) =>
      contextUsage(entries.map((entry) => entry.info), Object.fromEntries(entries.map((entry) => [entry.info.id, entry.parts])))
    const history = (await client.session.messages({ sessionID }, call)).data
    expect(usage(history)).toMatchObject({ tokens: 31000, estimated: false })
    expect((await client.session.summarize({ sessionID, providerID: "fixture", modelID: "beta" }, call)).data).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.model).toBe("beta")
    expect(requests[1]!.tools ?? []).toEqual([])
    expect(events.some((event) => event.payload.type === "message.part.updated" && event.payload.properties.part.type === "compaction")).toBe(true)
    const compacted = (await client.session.messages({ sessionID }, call)).data
    expect(compacted.filter((entry) => history.some((old) => old.info.id === entry.info.id))
      .map((entry) => ({ id: entry.info.id, parts: entry.parts })))
      .toEqual(history.map((entry) => ({ id: entry.info.id, parts: entry.parts })))
    expect(usage(compacted).estimated).toBe(true)
    expect(usage(compacted).tokens).toBeLessThan(1000)
    expect((await client.session.summarize({ sessionID, providerID: "fixture", modelID: "beta" }, call)).data).toBe(false)
    expect(requests).toHaveLength(2)
    await transport.dispose()
    transport = await createTuiTransport(connection, home)
    client = createPHINsClient({ baseUrl: connection.url, directory: home, fetch: transport.fetch })
    expect(usage((await client.session.messages({ sessionID }, call)).data)).toEqual(usage(compacted))
    await native.v2.session.prompt({ sessionID, prompt: { text: "Continue with the tests" }, resume: true }, call)
    await native.v2.session.wait({ sessionID }, call)
    expect(requests).toHaveLength(3)
    const continued = JSON.stringify(requests[2]!.messages)
    expect(continued).toContain("<conversation-checkpoint>")
    expect(continued).toContain("Preserve validation and run tests")
    expect(continued).not.toContain("OLD_REQUEST_MARKER")
    expect(continued).not.toContain("OLD_RESPONSE_MARKER")
    const beforeFailure = (await native.v2.session.context({ sessionID }, call)).data
    rejectSummary = true
    await expect(client.session.summarize({ sessionID, providerID: "fixture", modelID: "beta" }, call)).rejects.toBeDefined()
    expect(requests).toHaveLength(4)
    expect((await native.v2.session.context({ sessionID }, call)).data).toEqual(beforeFailure)
    expect(usage((await client.session.messages({ sessionID }, call)).data)).toMatchObject({ tokens: 31000, estimated: false })
  } finally {
    await transport?.dispose()
    owner?.kill("SIGTERM")
    await owner?.exited
    await logs
    provider.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
