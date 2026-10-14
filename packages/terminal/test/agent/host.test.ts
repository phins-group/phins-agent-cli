import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import os from "node:os"
import path from "node:path"
import type { SessionSnapshotResponse } from "@phins/engine/transport/client/generated/types.gen"

async function withHost(
  check: (host: {
    home: string
    url: string
    headers: Record<string, string>
    exited: Promise<number>
    request: (
      pathname: string,
      body?: object,
      clientID?: string,
      extra?: Record<string, string>,
    ) => Promise<Response>
  }) => Promise<void>,
  setup?: (home: string) => Promise<void>,
) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "phins-host-fence-")))
  await setup?.(home)
  const nonce = randomUUID()
  const child = Bun.spawn([
    process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"),
    "agent-host", "--directory", home, "--nonce", nonce,
  ], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      PHINS_TEST_HOME: home,
      PHINS_DB: path.join(home, "runtime.db"),
      PHINS_DISABLE_MODELS_FETCH: "true",
      PHINS_MODELS_PATH: path.resolve(
        import.meta.dir, "../../../engine/test/plugin/fixtures/models-dev.json",
      ),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  try {
    const reader = child.stdout.getReader()
    const ready = await Promise.race([
      reader.read().then(({ value }) => JSON.parse(new TextDecoder().decode(value))),
      child.exited.then(async (code) => {
        throw new Error(`QA host exited ${code}: ${await stderr}`)
      }),
      Bun.sleep(15_000).then(() => { throw new Error("QA host not ready") }),
    ])
    expect(ready.nonce).toBe(nonce)
    const key = createHash("sha256").update(home).digest("hex")
    const registration = JSON.parse(await readFile(
      path.join(home, ".phins/state/agents", `${key}.json`), "utf8",
    ))
    const headers = {
      authorization: `Basic ${Buffer.from(`phins:${registration.password}`).toString("base64")}`,
      "x-phins-service-generation": registration.id,
      "content-type": "application/json",
    }
    await check({
      home, url: registration.url, headers, exited: child.exited,
      request: (pathname, body, clientID, extra) => fetch(registration.url + pathname, {
        method: body ? "POST" : "GET",
        headers: {
          ...headers, ...extra,
          ...(clientID ? { "x-phins-agent-client": clientID } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      }),
    })
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await child.exited
    await stderr
    await rm(home, { recursive: true, force: true })
  }
}

test("project scope validates every selector and denies browser/removed clients", () =>
  withHost(async ({ home, url, request }) => {
    const foreign = path.join(home, "foreign")
    const alias = path.join(home, "alias")
    await mkdir(foreign)
    await symlink(home, alias, "dir")
    const preflight = await fetch(url + "/api/session", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization,content-type,x-phins-service-generation,x-phins-agent-client,x-phins-directory",
      },
    })
    expect(preflight.status).toBe(401)
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    expect((await request("/api/session", undefined, undefined, {
      origin: "tauri://localhost",
    })).status).toBe(403)
    for (const kind of ["desktop", "remote"])
      expect((await request("/api/agent/client/open", { kind })).status).toBe(400)
    const owner = await (await request("/api/agent/client/open", { kind: "headless" }))
      .json() as { clientID: string }
    for (const pathname of ["/api/node/account", "/api/agent/connector/start"])
      expect((await request(pathname, {}, owner.clientID)).status).toBe(404)
    const created = await request("/api/session", {
      location: { directory: alias }, title: "Scope fixture",
    }, owner.clientID, { "x-phins-directory": encodeURIComponent(alias) })
    expect(created.status).toBe(200)
    const session = (await created.json() as {
      data: { id: string; location: { directory: string } }
    }).data
    expect(session.location.directory).toBe(home)
    expect((await request("/api/session", {
      id: session.id, location: { directory: home },
    }, owner.clientID)).status).toBe(200)
    const second = (await (await request("/api/session", {
      location: { directory: home }, title: "Foreign scope fixture",
    }, owner.clientID)).json() as { data: { id: string } }).data
    const database = new Database(path.join(home, "runtime.db"))
    try {
      database.query("UPDATE session SET directory = ? WHERE id = ?")
        .run(foreign, second.id)
    } finally {
      database.close()
    }
    expect((await request("/api/session", {
      id: second.id, location: { directory: home },
    }, owner.clientID)).status).toBe(403)
    for (const query of [
      `location[directory]=${encodeURIComponent(home)}&directory=${encodeURIComponent(foreign)}`,
      `directory=${encodeURIComponent(home)}&directory=${encodeURIComponent(foreign)}`,
      `location[directory]=${encodeURIComponent(home)}&location[directory]=${encodeURIComponent(foreign)}`,
    ]) expect((await request(`/api/session?${query}`)).status).toBe(403)
    for (const value of [foreign, encodeURIComponent(foreign)])
      expect((await request("/api/session", undefined, undefined, {
        "x-phins-directory": value,
      })).status).toBe(403)
    const listed = await request("/api/session", undefined, undefined, {
      "x-phins-directory": encodeURIComponent(alias),
    })
    expect(listed.status).toBe(200)
    const page = await listed.json() as { cursor: { next: string } }
    const cursor = JSON.parse(Buffer.from(page.cursor.next, "base64url").toString())
    for (const scope of [{ directory: foreign }, { directory: undefined }]) {
      const value = Buffer.from(JSON.stringify({ ...cursor, ...scope })).toString("base64url")
      expect((await request(`/api/session?cursor=${encodeURIComponent(value)}`)).status).toBe(403)
    }
    expect((await request(`/api/session?cursor=${encodeURIComponent(page.cursor.next)}`))
      .status).toBe(200)
    expect((await request("/api/session?cursor=not-valid-base64!"))
      .status).not.toBe(200)
    await request("/api/agent/client/close", { background: false }, owner.clientID)
  }), 25_000)

test("a streamed request cannot admit a prompt after its client closes", () =>
  withHost(async ({ home, url, headers, request }) => {
    const owner = await (await request("/api/agent/client/open", { kind: "tui" }))
      .json() as { clientID: string }
    const created = await request("/api/session", {
      location: { directory: home }, title: "Exit fixture",
    }, owner.clientID)
    const session = (await created.json() as { data: { id: string } }).data
    const body = JSON.stringify({ prompt: { text: "must not be admitted" }, resume: false })
    const target = new URL(url)
    const socket = createConnection({ host: target.hostname, port: Number(target.port) })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      let reply = ""
      const completed = new Promise<string>((resolve, reject) => {
        socket.on("data", (chunk) => { reply += chunk.toString() })
        socket.once("end", () => resolve(reply))
        socket.once("error", reject)
      })
      socket.write([
        `POST /api/session/${session.id}/prompt HTTP/1.1`, `Host: ${target.host}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        `x-phins-agent-client: ${owner.clientID}`,
        `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body.slice(0, 5),
      ].join("\r\n"))
      await Bun.sleep(20)
      expect((await request("/api/agent/client/close", { background: false }, owner.clientID))
        .status).toBe(200)
      socket.write(body.slice(5))
      const response = await Promise.race([
        completed,
        Bun.sleep(3000).then(() => { throw new Error("streamed request not settled") }),
      ])
      expect(response).toStartWith("HTTP/1.1 409 ")
      expect(response).toContain("mất kết nối")
      const status = await (await request("/api/agent/status")).json() as { owners: unknown[] }
      expect(status.owners).toEqual([])
      const snapshot = await (await request(`/api/session/${session.id}/snapshot`))
        .json() as { data: { messages: { data: unknown[] } } }
      expect(snapshot.data.messages.data).toEqual([])
    } finally {
      socket.destroy()
    }
  }), 25_000)

test("exact-client close retries ACK without restoring work or background permission", () =>
  withHost(async ({ home, request }) => {
    const owner = await (await request("/api/agent/client/open", { kind: "tui" }))
      .json() as { clientID: string }
    const observer = await (await request("/api/agent/client/open", { kind: "headless" }))
      .json() as { clientID: string }
    expect((await request("/api/session", {
      location: { directory: home }, title: "Surviving owner",
    }, observer.clientID)).status).toBe(200)
    for (const background of [false, false, true])
      expect((await request("/api/agent/client/close", { background }, owner.clientID))
        .status).toBe(200)
    for (const [action, body] of [
      ["heartbeat", {}], ["background", { confirmed: true }],
    ] as const)
      expect((await request(`/api/agent/client/${action}`, body, owner.clientID))
        .status).toBe(409)
    expect((await request("/api/session", {
      location: { directory: home }, title: "Must not be admitted",
    }, owner.clientID)).status).toBe(409)
    expect((await request("/api/agent/client/close", {}, owner.clientID)).status)
      .toBe(400)
    expect((await request("/api/agent/client/close", { background: false })).status)
      .toBe(401)
    const status = await (await request("/api/agent/status")).json() as { owners: unknown[] }
    expect(status.owners).toEqual([])
    expect((await request("/api/agent/client/heartbeat", {}, observer.clientID)).status)
      .toBe(200)
    await request("/api/agent/client/close", { background: false }, observer.clientID)
  }), 25_000)

test("an observer cannot approve another client's shell, and closing its owner cancels the permission", () =>
  withHost(async ({ home, request }) => {
    const owner = await (await request("/api/agent/client/open", { kind: "headless" }))
      .json() as { clientID: string }
    const observer = await (await request("/api/agent/client/open", { kind: "tui" }))
      .json() as { clientID: string }
    const created = await request("/api/session", {
      location: { directory: home }, title: "Pending permission fixture",
    }, owner.clientID)
    const session = (await created.json() as { data: { id: string } }).data
    // The command is never approved, so no process or provider is invoked.
    const shell = request(`/api/session/${session.id}/shell`, {
      command: "pwd", resume: false,
    }, owner.clientID)
    let pending: string | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      const permissions = await (await request(`/api/session/${session.id}/permission`))
        .json() as { data: { id: string }[] }
      if (permissions.data.length) { pending = permissions.data[0]!.id; break }
      await Bun.sleep(10)
    }
    expect(pending).toBeDefined()
    expect((await request(`/api/session/${session.id}/permission/${pending}/reply`, {
      reply: "once",
    }, observer.clientID)).status).toBe(409)
    const unchanged = await (await request(`/api/session/${session.id}/permission`))
      .json() as { data: { id: string }[] }
    expect(unchanged.data.map((permission) => permission.id)).toEqual([pending!])
    const closes = await Promise.all([
      request("/api/agent/client/close", { background: false }, owner.clientID),
      request("/api/agent/client/close", { background: false }, owner.clientID),
    ])
    expect(closes.map((response) => response.status)).toEqual([200, 200])
    expect((await shell).status).not.toBe(204)
    const permissions = await (await request(`/api/session/${session.id}/permission`))
      .json() as { data: unknown[] }
    expect(permissions.data).toEqual([])
    const status = await (await request("/api/agent/status")).json() as { owners: unknown[] }
    expect(status.owners).toEqual([])
    expect((await request("/api/agent/client/heartbeat", {}, observer.clientID)).status).toBe(200)
    await request("/api/agent/client/close", { background: false }, observer.clientID)
  }, async (home) => {
    await writeFile(path.join(home, "phins.json"), JSON.stringify({
      agents: { build: { permissions: [{ action: "*", resource: "*", effect: "ask" }] } },
    }), { mode: 0o600 })
  }), 25_000)

test("TUI and headless CLI share HTTP history without concurrent claims or Stop transferring ownership", async () => {
  const calls: string[] = []
  const held: (() => void)[] = []
  let hold = true
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer client-fixture")
      calls.push(JSON.stringify(await request.json()))
      const response = [
        { choices: [{ delta: { role: "assistant", content: "Shared result" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(hold ? new ReadableStream<Uint8Array>({
        start(controller) {
          held.push(() => {
            controller.enqueue(new TextEncoder().encode(response))
            controller.close()
          })
        },
      }) : response, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await withHost(async ({ home, request }) => {
      const open = async (kind: "tui" | "headless") =>
        (await (await request("/api/agent/client/open", { kind })).json() as {
          clientID: string
        }).clientID
      const tui = await open("tui"), headless = await open("headless")
      const observer = await open("tui")
      const create = async (title: string) =>
        (await (await request("/api/session", {
          location: { directory: home }, title,
        }, tui)).json() as { data: { id: string } }).data.id
      const session = await create("Shared TUI/headless CLI fixture")
      const other = await create("Independent local fixture")
      const snapshot = async (id: string, clientID = observer) => {
        const response = await request(`/api/session/${id}/snapshot`, undefined, clientID)
        expect(response.status).toBe(200)
        return (await response.json() as SessionSnapshotResponse).data
      }
      const until = async (read: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 250; attempt++) {
          if (await read()) return
          await Bun.sleep(10)
        }
        throw new Error("Shared client fixture did not settle")
      }
      const prompt = (id: string, clientID: string, text: string) =>
        request(`/api/session/${id}/prompt`, { prompt: { text }, resume: true }, clientID)
      const simultaneous = await Promise.all([
        prompt(session, tui, "TUI_FIRST"),
        prompt(session, headless, "HEADLESS_FIRST"),
      ])
      expect(simultaneous.map((response) => response.status).sort()).toEqual([200, 409])
      const winner = simultaneous[0]!.status === 200 ? tui : headless
      const loser = winner === tui ? headless : tui
      await until(async () => calls.length === 1)
      const busy = await snapshot(session)
      expect(busy.runState?.status).toBe("busy")
      expect((await snapshot(session, tui)).messages).toEqual(busy.messages)
      expect((await snapshot(session, headless)).messages).toEqual(busy.messages)
      expect(calls[0]).toContain(winner === tui ? "TUI_FIRST" : "HEADLESS_FIRST")
      expect(calls[0]).not.toContain(winner === tui ? "HEADLESS_FIRST" : "TUI_FIRST")

      expect((await request(`/api/session/${session}/interrupt`, {}, loser)).status).toBe(204)
      expect((await snapshot(session)).runState?.status).toBe("interrupted")
      // Stop is allowed to an observer but it does not release an open local owner.
      expect((await prompt(session, loser, "MUST_NOT_TAKE_OVER")).status).toBe(409)
      expect(calls).toHaveLength(1)
      expect((await prompt(other, loser, "INDEPENDENT_LOCAL_RUN")).status).toBe(200)
      await until(async () => calls.length === 2)
      expect((await prompt(session, winner, "OWNER_CONTINUES")).status).toBe(200)
      await until(async () => calls.length === 3)
      const neighbour = await snapshot(other)
      expect(neighbour.runState?.status).toBe("busy")

      expect((await request("/api/agent/client/close", { background: false }, observer)).status).toBe(200)
      expect((await snapshot(session, winner)).runState?.status).toBe("busy")
      expect((await request("/api/agent/client/close", { background: false }, winner)).status).toBe(200)
      expect((await snapshot(session, loser)).runState?.status).toBe("interrupted")
      expect((await snapshot(other, loser)).runState).toEqual(neighbour.runState)
      held[1]!()
      await until(async () => (await snapshot(other, loser)).runState?.status === "idle")
      expect(JSON.stringify((await snapshot(other, loser)).messages.data)).toContain("Shared result")

      // Only the explicit owner close makes this same durable session available.
      hold = false
      expect((await prompt(session, loser, "EXPLICIT_SUCCESSOR")).status).toBe(200)
      await until(async () => (await snapshot(session, loser)).runState?.status === "idle")
      expect(calls).toHaveLength(4)
      const history = JSON.stringify((await snapshot(session, loser)).messages.data)
      expect(history).toContain(winner === tui ? "TUI_FIRST" : "HEADLESS_FIRST")
      expect(history).toContain("EXPLICIT_SUCCESSOR")
      expect(history).not.toContain("MUST_NOT_TAKE_OVER")
      expect((await request("/api/agent/client/close", { background: false }, loser)).status).toBe(200)
    }, async (home) => {
      await writeFile(path.join(home, "phins.json"), JSON.stringify({
        model: "fixture/fixture", snapshots: false,
        providers: {
          fixture: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
            request: { body: { apiKey: "client-fixture" } },
            models: { fixture: {
              capabilities: { tools: false, input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 128 },
            } },
          },
        },
      }), { mode: 0o600 })
    })
  } finally {
    provider.stop(true)
  }
}, 25_000)

test("close-idle fences a successor before acknowledging shutdown", () =>
  withHost(async ({ request, exited, url, headers }) => {
    const owner = await (await request("/api/agent/client/open", { kind: "tui" }))
      .json() as { clientID: string }
    await request("/api/agent/client/close", { background: false }, owner.clientID)
    const target = new URL(url)
    const socket = createConnection({ host: target.hostname, port: Number(target.port) })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      let reply = ""
      const completed = new Promise<string>((resolve, reject) => {
        socket.on("data", (chunk) => { reply += chunk.toString() })
        socket.once("end", () => resolve(reply))
        socket.once("error", reject)
      })
      const body = JSON.stringify({ kind: "headless" })
      socket.write([
        "POST /api/agent/client/open HTTP/1.1", `Host: ${target.host}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body.slice(0, 5),
      ].join("\r\n"))
      await Bun.sleep(20)
      const closing = await request("/api/agent/close-idle", {}, owner.clientID)
      expect(closing.status).toBe(202)
      expect(await closing.json()).toEqual({ closed: true })
      socket.write(body.slice(5))
      expect(await completed).toStartWith("HTTP/1.1 503 ")
      expect((await request("/api/agent/client/open", { kind: "headless" })).status)
        .toBe(503)
      expect(await Promise.race([
        exited,
        Bun.sleep(3000).then(() => { throw new Error("reserved shutdown did not exit") }),
      ])).toBe(0)
    } finally {
      socket.destroy()
    }
  }), 25_000)
