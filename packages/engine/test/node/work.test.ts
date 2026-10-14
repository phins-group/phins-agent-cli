import { describe, expect, test } from "bun:test"
import * as NodeIdentity from "../../src/execution/identity"

const expected = {
  nodeId: "50000000-0000-4000-8000-000000000001",
  userId: "50000000-0000-4000-8000-000000000002",
  workspaceId: "50000000-0000-4000-8000-000000000003",
}
const identity = () => ({
  ...expected,
  version: 1 as const,
  sessionId: "50000000-0000-4000-8000-000000000004",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
})
const execution = {
  kind: "jobs" as const,
  id: "50000000-0000-4000-8000-000000000005",
  leaseId: "50000000-0000-4000-8000-000000000006",
  directory: "/fixture/project with space ",
}
const proof = (change: object = {}) => ({
  ...identity(),
  ...execution,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...change,
})
const signal = () => new AbortController().signal
const options: NodeIdentity.Options = {
  baseUrl: "https://platform.example.test",
  expected,
  token: async () => "fixture-credential",
  fetch: async (url) =>
    Response.json(url.endsWith("/identity") ? identity() : proof()),
}

describe("native Node work verification", () => {
  test("an already cancelled check does not read credentials or send a request", async () => {
    let calls = 0
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => {
          calls++
          return "fixture-credential"
        },
      },
      signal(),
    )
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      node.verifyWork(execution, aborted.signal),
    ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    expect(calls).toBe(1)
  })

  test("revalidates identity for every attempt check, with exact scope and no heartbeat or legacy fallback", async () => {
    const requests: { url: string; init: RequestInit }[] = []
    let credentials = 0
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => `fixture-${++credentials}`,
        fetch: async (url, init) => {
          requests.push({ url, init })
          return Response.json(url.endsWith("/identity") ? identity() : proof())
        },
      },
      signal(),
    )
    for (let i = 0; i < 2; i++) {
      const result = await node.verifyWork(execution, signal())
      expect(result).toMatchObject({
        ...expected,
        ...execution,
        version: 1,
        sessionId: identity().sessionId,
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.keys(result).sort()).toEqual([
        "directory",
        "expiresAt",
        "id",
        "kind",
        "leaseId",
        "nodeId",
        "sessionId",
        "userId",
        "version",
        "workspaceId",
      ])
    }
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/agent/node/identity",
      "/v1/agent/node/identity",
      `/v1/agent/node/jobs/${execution.id}/verify`,
      "/v1/agent/node/identity",
      `/v1/agent/node/jobs/${execution.id}/verify`,
    ])
    for (const { url, init } of requests.filter(({ url }) =>
      url.endsWith("/verify"),
    )) {
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        cache: "no-store",
      })
      expect(JSON.parse(String(init.body))).toEqual({
        deviceId: expected.nodeId,
        workspaceId: expected.workspaceId,
        sessionId: identity().sessionId,
        leaseId: execution.leaseId,
        directory: execution.directory,
      })
      const index = requests.findIndex(
        (request) => request.url === url && request.init === init,
      )
      expect(new Headers(init.headers).get("authorization")).toBe(
        new Headers(requests[index - 1].init.headers).get("authorization"),
      )
    }
    expect(credentials).toBe(3)
    expect(JSON.stringify(node)).not.toContain("fixture-")
    expect(node).not.toHaveProperty("prompt")
    expect(node).not.toHaveProperty("claim")
  })

  test("rejects malformed expectations before credentials and snapshots inputs before await", async () => {
    let calls = 0
    let release!: () => void
    let block = false
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let body: unknown
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => {
          calls++
          if (block) await pending
          return "fixture-credential"
        },
        fetch: async (url, init) => {
          if (url.endsWith("/verify")) body = JSON.parse(String(init.body))
          return Response.json(url.endsWith("/identity") ? identity() : proof())
        },
      },
      signal(),
    )
    for (const value of [
      { ...execution, kind: "commands" },
      { ...execution, id: "invalid" },
      { ...execution, leaseId: "invalid" },
      { ...execution, directory: " " },
      { ...execution, directory: "x".repeat(2001) },
      { ...execution, directory: "/qa\0private" },
      { ...execution, grant: "write" },
    ])
      await expect(
        node.verifyWork(value as typeof execution, signal()),
      ).rejects.toMatchObject({
        message: "Invalid expected Node work",
      })
    expect(calls).toBe(1)
    block = true
    const input = { ...execution }
    const verifying = node.verifyWork(input, signal())
    input.id = expected.nodeId
    input.leaseId = expected.userId
    input.directory = "/mutated/project"
    release()
    await verifying
    expect(body).toMatchObject({
      leaseId: execution.leaseId,
      directory: execution.directory,
    })
  })

  test("requires every binding and a live, bounded proof, without accepting grants or payloads", async () => {
    for (const body of [
      proof({ nodeId: execution.id }),
      proof({ userId: execution.id }),
      proof({ workspaceId: execution.id }),
      proof({ sessionId: execution.id }),
      proof({ kind: "tasks" }),
      proof({ id: expected.nodeId }),
      proof({ leaseId: expected.nodeId }),
      proof({ directory: "/other" }),
      proof({ version: 2 }),
      proof({ grant: { submit: true } }),
      proof({ messageText: "PRIVATE_PROMPT" }),
      proof({ expiresAt: "invalid" }),
      proof({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      proof({ expiresAt: new Date(Date.now() + 180_000).toISOString() }),
      null,
    ]) {
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) =>
            Response.json(url.endsWith("/identity") ? identity() : body),
        },
        signal(),
      )
      await expect(node.verifyWork(execution, signal())).rejects.toBeInstanceOf(
        NodeIdentity.IdentityError,
      )
    }
  })

  test("login changes or revoked identity prevent a work request", async () => {
    for (const changed of [true, false]) {
      let calls = 0
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async () => {
            calls++
            if (calls === 1) return Response.json(identity())
            return changed
              ? Response.json({ ...identity(), sessionId: execution.id })
              : Response.json({ error: "PRIVATE_AUTH_DATA" }, { status: 403 })
          },
        },
        signal(),
      )
      await expect(node.verifyWork(execution, signal())).rejects.toBeInstanceOf(
        NodeIdentity.IdentityError,
      )
      expect(calls).toBe(2)
    }
  })

  test("denies missing/failed native APIs without fallback or leaking their bodies", async () => {
    for (const status of [301, 401, 403, 404, 409, 500]) {
      let cancelled = false
      const paths: string[] = []
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) => {
            paths.push(new URL(url).pathname)
            if (url.endsWith("/identity")) return Response.json(identity())
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("PRIVATE_RESPONSE"),
                  )
                },
                cancel() {
                  cancelled = true
                },
              }),
              { status },
            )
          },
        },
        signal(),
      )
      await expect(node.verifyWork(execution, signal())).rejects.toMatchObject({
        message: "Node work is unavailable or no longer authorized",
        status,
      })
      expect(cancelled).toBe(true)
      expect(paths).toHaveLength(3)
      expect(paths.at(-1)).toBe(`/v1/agent/node/jobs/${execution.id}/verify`)
    }
  })

  test("bounds response data, redacts unexpected failures and cancels stalled reads", async () => {
    for (const bytes of [
      new Uint8Array(16 * 1024 + 1),
      new Uint8Array([255]),
      new TextEncoder().encode("PRIVATE_INVALID_JSON"),
    ]) {
      const response = new Response(bytes)
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) =>
            url.endsWith("/identity") ? Response.json(identity()) : response,
        },
        signal(),
      )
      await expect(node.verifyWork(execution, signal())).rejects.toBeInstanceOf(
        NodeIdentity.IdentityError,
      )
      expect(response.body?.locked).toBe(false)
    }
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) => {
          if (url.endsWith("/identity")) return Response.json(identity())
          throw new Error("PRIVATE_TRANSPORT_FAILURE")
        },
      },
      signal(),
    )
    await expect(node.verifyWork(execution, signal())).rejects.toMatchObject({
      message: "Could not verify Node work",
    })
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let cancelled = false
    const controller = new AbortController()
    const stalled = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) => {
          if (url.endsWith("/identity")) return Response.json(identity())
          ready()
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              },
            }),
          )
        },
      },
      signal(),
    )
    const verifying = stalled.verifyWork(execution, controller.signal)
    await started
    controller.abort()
    await expect(verifying).rejects.toMatchObject({
      message: "Node work request cancelled or timed out",
    })
    expect(cancelled).toBe(true)
  })

  test("real loopback transport checks each task attempt and stops after revocation", async () => {
    let revoked = false
    const paths: string[] = []
    const task = { ...execution, kind: "tasks" as const }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        expect(request.method).toBe("POST")
        expect(request.headers.get("authorization")).toBe(
          "Bearer fixture-credential",
        )
        if (path.endsWith("/identity")) return Response.json(identity())
        expect(path).toBe(`/v1/agent/node/tasks/${task.id}/verify`)
        expect(await request.json()).toEqual({
          deviceId: expected.nodeId,
          workspaceId: expected.workspaceId,
          sessionId: identity().sessionId,
          leaseId: task.leaseId,
          directory: task.directory,
        })
        return revoked
          ? Response.json({ error: "PRIVATE_REVOKED" }, { status: 409 })
          : Response.json(proof({ kind: "tasks" }))
      },
    })
    try {
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          baseUrl: `http://127.0.0.1:${server.port}`,
          fetch: undefined,
        },
        signal(),
      )
      expect(await node.verifyWork(task, signal())).toMatchObject(task)
      revoked = true
      await expect(node.verifyWork(task, signal())).rejects.toMatchObject({
        status: 409,
      })
      expect(paths).toHaveLength(5)
    } finally {
      await server.stop(true)
    }
  })
})
