import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createPHINsClient } from "@phins/engine/transport/client/create"

test("the existing CLI hosts its project without starting Node Service", async () => {
  const home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "phins-agent-host-")),
  )
  const nonce = randomUUID()
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "agent-host",
      "--directory",
      home,
      "--nonce",
      nonce,
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        PHINS_TEST_HOME: home,
        PHINS_DB: path.join(home, "runtime.db"),
        PHINS_DISABLE_MODELS_FETCH: "true",
        PHINS_MODELS_PATH: path.resolve(
          import.meta.dir,
          "../../../engine/test/plugin/fixtures/models-dev.json",
        ),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stderr = new Response(child.stderr).text()
  try {
    const reader = child.stdout.getReader()
    const ready = await Promise.race([
      reader
        .read()
        .then(({ value }) => JSON.parse(new TextDecoder().decode(value))),
      child.exited.then(async (code) => {
        throw new Error(`Host exited ${code}: ${await stderr}`)
      }),
      Bun.sleep(15_000).then(() => {
        throw new Error("Host did not become ready")
      }),
    ])
    expect(ready).toMatchObject({
      kind: "phins-agent-ready",
      nonce,
      directory: home,
    })
    const { createHash } = await import("node:crypto")
    const { readFile, access } = await import("node:fs/promises")
    const key = createHash("sha256").update(home).digest("hex")
    const value = JSON.parse(
      await readFile(
        path.join(home, ".phins/state/agents", `${key}.json`),
        "utf8",
      ),
    )
    await expect(
      access(path.join(home, ".phins/state/server.json")),
    ).rejects.toThrow()
    const headers = {
      authorization: `Basic ${Buffer.from(`phins:${value.password}`).toString("base64")}`,
      "x-phins-service-generation": value.id,
    }
    const unauthenticated = "Kết nối Agent local không được xác thực.",
      forbidden = "Origin không được phép.",
      untrusted = "https://untrusted.example"
    for (const [extra, status, message] of [
      [{ authorization: "" }, 401, unauthenticated],
      [{ authorization: "Basic invalid" }, 401, unauthenticated],
      [
        { authorization: headers.authorization.slice(0, -1) + "!" },
        401,
        unauthenticated,
      ],
      [{ origin: untrusted }, 403, forbidden],
      [{ cookie: "session=untrusted" }, 403, forbidden],
      [
        { "x-phins-service-generation": randomUUID() },
        409,
        "The service generation has changed",
      ],
      [{ authorization: "", origin: untrusted }, 401, unauthenticated],
    ] as const) {
      const response = await fetch(value.url + "/api/agent/status", {
        headers: { ...headers, ...extra },
      })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ message })
    }
    const desktopStatus = await fetch(value.url + "/api/agent/status", {
      headers: { ...headers, origin: "tauri://localhost" },
    })
    expect(desktopStatus.status).toBe(403)
    expect(desktopStatus.headers.get("access-control-allow-origin")).toBeNull()
    const request = async (
      pathname: string,
      body?: object,
      clientID?: string,
    ) =>
      fetch(value.url + pathname, {
        method: body ? "POST" : "GET",
        headers: {
          ...headers,
          "content-type": "application/json",
          ...(clientID ? { "x-phins-agent-client": clientID } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const owner = (await (
      await request("/api/agent/client/open", { kind: "tui" })
    ).json()) as { clientID: string }
    expect(
      (await request("/api/agent/client/heartbeat", {}, owner.clientID)).status,
    ).toBe(200)
    const client = createPHINsClient({
      baseUrl: value.url,
      headers: { ...headers, "x-phins-agent-client": owner.clientID },
      throwOnError: true,
    })
    const session = (
      await client.v2.session.create({
        location: { directory: home },
        title: "Existing CLI runtime",
      })
    ).data!.data
    expect(session.location.directory).toBe(home)
    expect(
      (await client.v2.session.get({ sessionID: session.id })).data!.data.id,
    ).toBe(session.id)
    const alias = path.join(home, "project-alias")
    await symlink(home, alias, "dir")
    const throughAlias = (await client.v2.session.create({
      location: { directory: alias }, title: "Same canonical project",
    })).data!.data
    expect(throughAlias.location.directory).toBe(home)
    const listed = await request(`/api/session?directory=${encodeURIComponent(alias)}`)
    expect(listed.status).toBe(200)
    expect((await listed.json() as { data: { id: string }[] }).data.map((entry) => entry.id))
      .toContain(throughAlias.id)
    expect(
      (await request("/api/session?directory=%2Fnot-this-project")).status,
    ).toBe(403)
    expect((await fetch(value.url + "/api/agent/status")).status).toBe(401)
    expect(
      (
        await request(
          "/api/agent/client/close",
          { background: false },
          owner.clientID,
        )
      ).status,
    ).toBe(200)
  } finally {
    child.kill("SIGTERM")
    await child.exited
    const errors = await stderr
    await rm(home, { recursive: true, force: true })
    expect(errors).not.toContain("Service not found")
  }
}, 25_000)
