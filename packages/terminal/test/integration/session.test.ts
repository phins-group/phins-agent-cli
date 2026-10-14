import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPHINsClient } from "@phins/engine/transport/client/create"
import { connectLocalService, readSessionSnapshot } from "@phins/engine/transport/client/connection"
import { createTuiTransport } from "../../src/tui/transport/client"

test("the original TUI reads and manages native sessions without a second engine", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-original-tui-")))
  const state = path.join(home, ".phins/state")
  await writeFile(path.join(home, "phins.json"), JSON.stringify({ commands: {
    qa_plain: { template: "Review $ARGUMENTS", agent: "build", subtask: false },
    dangerous: { template: "!`touch forbidden-write`" },
  } }))
  const owner = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), "agent-host", "--directory", home, "--nonce", randomUUID()], {
    cwd: home,
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), PHINS_TEST_HOME: home,
      PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"), PHINS_CONFIG_DIR: path.join(home, "config"),
      PHINS_DB: ":memory:", PHINS_DISABLE_MODELS_FETCH: "true",
      PHINS_MODELS_PATH: path.resolve(import.meta.dir, "../../../engine/test/plugin/fixtures/models-dev.json") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  let output = ""
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) return
        output += new TextDecoder().decode(result.value)
      }
    } finally { reader.releaseLock() }
  }
  const logs = Promise.all([read(owner.stdout), read(owner.stderr)])
  let transport: Awaited<ReturnType<typeof createTuiTransport>> | undefined
  let native: Awaited<ReturnType<typeof connectLocalService>> | undefined
  try {
    let registration: { id: string; url: string; pid: number; password: string } | undefined
    const deadline = Date.now() + 8000
    while (!registration && Date.now() < deadline && owner.exitCode === null) {
      registration = await readFile(path.join(state, "agents", createHash("sha256").update(home).digest("hex") + ".json"), "utf8").then(JSON.parse).catch(() => undefined)
      if (!registration) await Bun.sleep(20)
    }
    expect(registration, output).toBeDefined()
    const password = registration!.password
    const connection = { url: registration!.url, generation: registration!.id,
      headers: { authorization: `Basic ${Buffer.from(`phins:${password}`).toString("base64")}` } }
    const opened = await fetch(connection.url + "/api/agent/client/open", {
      method: "POST", headers: { ...connection.headers,
        "x-phins-service-generation": connection.generation,
        "content-type": "application/json" },
      body: JSON.stringify({ kind: "tui" }),
    })
    expect(opened.status).toBe(200)
    const lease = await opened.json() as { clientID: string }
    Object.assign(connection.headers, { "x-phins-agent-client": lease.clientID })
    native = await connectLocalService(connection)
    const commands: Record<string, unknown>[] = []
    let loseAck = true
    transport = await createTuiTransport(connection, home, { recordOnly: true,
      fetch: async (request) => {
        if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/command"))
          return fetch(request)
        commands.push(await request.clone().json())
        const response = await fetch(request)
        if (loseAck && response.ok) {
          loseAck = false
          await response.body?.cancel()
          throw new Error("fixture lost acknowledgement")
        }
        return response
      },
    })
    const client = createPHINsClient({ baseUrl: connection.url, directory: home, fetch: transport.fetch })
    expect((await client.session.list({})).data).toEqual([])
    expect((await client.path.get({})).data?.directory).toBe(home)
    const created = (await client.session.create({ title: "Original TUI fixture" }, { throwOnError: true })).data
    expect((await client.session.get({ sessionID: created.id }, { throwOnError: true })).data).toMatchObject({
      id: created.id, title: "Original TUI fixture", directory: home,
    })
    expect((await client.session.messages({ sessionID: created.id }, { throwOnError: true })).data).toEqual([])
    await client.session.promptAsync({ sessionID: created.id, noReply: true,
      parts: [{ type: "text", text: "Nội dung chỉ ghi nhận" }] }, { throwOnError: true })
    expect((await client.session.messages({ sessionID: created.id }, { throwOnError: true })).data).toMatchObject([
      { info: { role: "user" }, parts: [{ type: "text", text: "Nội dung chỉ ghi nhận" }] },
    ])
    const snapshot = await readSessionSnapshot(connection, { sessionID: created.id })
    expect(snapshot.data.messages.data).toEqual([])
    expect(snapshot.data.runState).toBeUndefined()
    const command = { sessionID: created.id, command: "qa_plain", arguments: "fixture" }
    await expect(client.session.command(command, { throwOnError: true })).rejects.toBeDefined()
    await client.session.command(command, { throwOnError: true })
    expect(commands.slice(0, 2).map((value) => value.id)).toEqual([commands[0]!.id, commands[0]!.id])
    expect(commands[0]!.resume).toBe(false)
    const messages = (await client.session.messages({ sessionID: created.id }, { throwOnError: true })).data
    expect(messages.filter((entry) => entry.parts.some((part) => part.type === "text" && part.text === "Review fixture"))).toHaveLength(1)
    const beforeCommand = (await client.session.get({ sessionID: created.id }, { throwOnError: true })).data.agent
    await expect(client.session.command({ sessionID: created.id, command: "dangerous", agent: "plan" },
      { throwOnError: true })).rejects.toBeDefined()
    expect((await client.session.get({ sessionID: created.id }, { throwOnError: true })).data.agent).toBe(beforeCommand)
    await expect(readFile(path.join(home, "forbidden-write"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await client.session.update({ sessionID: created.id, title: "Renamed" }, { throwOnError: true })).data.title).toBe("Renamed")
    const fork = (await client.session.fork({ sessionID: created.id }, { throwOnError: true })).data
    expect(fork.id).not.toBe(created.id)
    expect(fork.title).toBe("Renamed (fork)")
    await client.session.delete({ sessionID: fork.id }, { throwOnError: true })
    expect((await native.v2.session.list({ directory: home })).data?.data.map((value) => value.id)).toEqual([created.id])
    await transport.dispose()
    transport = undefined
    expect(owner.exitCode).toBeNull()
    expect((await native.v2.service.status({ throwOnError: true })).data).toMatchObject({ id: connection.generation, state: "running" })
  } finally {
    await transport?.dispose()
    owner.kill("SIGTERM")
    await owner.exited
    await logs
    await rm(home, { recursive: true, force: true })
  }
}, 20000)
