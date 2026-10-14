import { describe, expect, test } from "bun:test"
import * as NodeIdentity from "../../src/execution/identity"
import * as Resources from "../../src/agents/resources/client"
import { ResourceError } from "../../src/agents/resources/error"

const expected = {
  nodeId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  workspaceId: "10000000-0000-4000-8000-000000000003",
}
const proof = (change: object = {}) => ({
  ...expected,
  version: 1,
  sessionId: "10000000-0000-4000-8000-000000000004",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...change,
})
const options: NodeIdentity.Options = {
  baseUrl: "https://platform.example.test",
  expected,
  token: async () => "fixture-secret",
  fetch: async () => Response.json(proof()),
}
const execution = {
  kind: "jobs" as const,
  id: "10000000-0000-4000-8000-000000000005",
  leaseId: "10000000-0000-4000-8000-000000000006",
  directory: "/fixture/project",
}
const manifest = {
  project: {
    deviceId: expected.nodeId,
    workspaceId: expected.workspaceId,
    directory: execution.directory,
  },
  revision: "a".repeat(64),
  items: [],
}
const signal = () => new AbortController().signal

describe("authenticated Node identity", () => {
  test("rejects unsafe transport and malformed expected identities before reading credentials", async () => {
    let calls = 0
    const checked = {
      ...options,
      token: async () => {
        calls++
        return "fixture-secret"
      },
    }
    for (const baseUrl of [
      "http://platform.example.test",
      "https://user:secret@example.test",
      "https://example.test?secret=fixture",
      "https://example.test#secret",
      "https://example.test/prefix",
      "ftp://example.test",
      "not-a-url",
    ])
      await expect(
        NodeIdentity.authenticate({ ...checked, baseUrl }, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    for (const identity of [
      { ...expected, nodeId: "self-declared-worker" },
      { ...expected, userId: "invalid" },
      { ...expected, workspaceId: "invalid" },
      { ...expected, grant: "write" },
    ])
      await expect(
        NodeIdentity.authenticate({ ...checked, expected: identity }, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    expect(calls).toBe(0)
    for (const baseUrl of [
      "http://localhost:5184",
      "http://127.0.0.1:5184",
      "http://[::1]:5184",
    ])
      expect(
        (await NodeIdentity.authenticate({ ...options, baseUrl }, signal()))
          .identity.nodeId,
      ).toBe(expected.nodeId)
  })

  test("captures routing and callbacks, returns only frozen proof metadata and never a remote grant", async () => {
    const configured = { ...options, expected: { ...expected } }
    const requests: { url: string; init: RequestInit }[] = []
    configured.fetch = async (url, init) => {
      requests.push({ url, init })
      return Response.json(proof())
    }
    const node = await NodeIdentity.authenticate(configured, signal())
    configured.expected.nodeId = "20000000-0000-4000-8000-000000000001"
    configured.token = async () => "changed-secret"
    configured.fetch = async () => {
      throw new Error("Changed transport must not be used")
    }
    await node.verify(signal())
    expect(Object.isFrozen(node.identity)).toBe(true)
    expect(Object.keys(node.identity).sort()).toEqual([
      "expiresAt",
      "nodeId",
      "sessionId",
      "userId",
      "version",
      "workspaceId",
    ])
    expect(JSON.stringify(node)).not.toContain("fixture-secret")
    expect(node).not.toHaveProperty("prompt")
    expect(node).not.toHaveProperty("claim")
    expect(requests).toHaveLength(2)
    for (const { url, init } of requests) {
      expect(url).toBe(`${options.baseUrl}/v1/agent/node/identity`)
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        redirect: "error",
      })
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer fixture-secret",
      )
      expect(JSON.parse(String(init.body))).toEqual({
        deviceId: expected.nodeId,
        workspaceId: expected.workspaceId,
      })
    }
  })

  test("rechecks every action, permits token rotation within one login and rejects another login", async () => {
    let calls = 0
    let credentials = 0
    let changed = false
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => `fixture-${++credentials}`,
        fetch: async (_url, init) => {
          expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer fixture-${++calls}`,
          )
          return Response.json(
            proof(changed ? { sessionId: execution.id } : {}),
          )
        },
      },
      signal(),
    )
    await node.verify(signal())
    await node.verify(signal())
    changed = true
    await expect(node.verify(signal())).rejects.toMatchObject({
      message: "Node login changed; a new binding is required",
    })
    expect(calls).toBe(4)
    expect(credentials).toBe(4)
  })

  test("rejects other owners, Nodes, workspaces, malformed proofs, extra grants and expiry", async () => {
    for (const body of [
      proof({ nodeId: execution.id }),
      proof({ userId: execution.id }),
      proof({ workspaceId: execution.id }),
      proof({ version: 2 }),
      proof({ sessionId: "not-a-login" }),
      proof({ expiresAt: "invalid" }),
      proof({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      proof({ grant: { submit: true } }),
      null,
    ])
      await expect(
        NodeIdentity.authenticate(
          {
            ...options,
            fetch: async () => Response.json(body),
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
  })

  test("rejects invalid credentials without HTTP and never exposes callback exceptions", async () => {
    let calls = 0
    for (const token of [
      "",
      "with space",
      "fixture\nsecret",
      "x".repeat(16385),
    ]) {
      await expect(
        NodeIdentity.authenticate(
          {
            ...options,
            token: async () => token,
            fetch: async () => {
              calls++
              return Response.json(proof())
            },
          },
          signal(),
        ),
      ).rejects.toMatchObject({ message: "No valid Node credential" })
    }
    expect(calls).toBe(0)
    for (const change of [
      {
        token: async () => {
          throw new Error("fixture-secret callback data")
        },
      },
      {
        fetch: async () => {
          throw new Error("fixture-secret transport data")
        },
      },
    ])
      await expect(
        NodeIdentity.authenticate({ ...options, ...change }, signal()),
      ).rejects.toMatchObject({ message: "Could not verify Node identity" })
  })

  test("denies upstream errors without disclosing response bodies or retaining their streams", async () => {
    for (const status of [301, 401, 403, 409, 500]) {
      let cancelled = false
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("fixture-secret PRIVATE_BODY"),
            )
          },
          cancel() {
            cancelled = true
          },
        }),
        { status },
      )
      await expect(
        NodeIdentity.authenticate(
          {
            ...options,
            fetch: async () => response,
          },
          signal(),
        ),
      ).rejects.toMatchObject({
        message: "Node identity is unavailable or no longer authorized",
        status,
      })
      expect(cancelled).toBe(true)
    }
  })

  test("bounds responses and fails closed on invalid UTF-8 or JSON", async () => {
    for (const bytes of [
      new Uint8Array(16 * 1024 + 1),
      new Uint8Array([255]),
      new TextEncoder().encode("fixture-secret not-json"),
    ]) {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      )
      await expect(
        NodeIdentity.authenticate(
          {
            ...options,
            fetch: async () => response,
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      // A closed stream is already released; an oversized pending one is cancelled below.
      expect(response.body?.locked).toBe(false)
    }
    let cancelled = false
    await expect(
      NodeIdentity.authenticate(
        {
          ...options,
          fetch: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(16 * 1024 + 1))
                },
                cancel() {
                  cancelled = true
                },
              }),
            ),
        },
        signal(),
      ),
    ).rejects.toMatchObject({
      message: "Node identity response exceeds the 16 KiB limit",
    })
    expect(cancelled).toBe(true)
  })

  test("honors cancellation before credentials, while credentials wait and while reading a stalled stream", async () => {
    const aborted = new AbortController()
    aborted.abort()
    let calls = 0
    await expect(
      NodeIdentity.authenticate(
        {
          ...options,
          token: async () => {
            calls++
            return "fixture-secret"
          },
        },
        aborted.signal,
      ),
    ).rejects.toMatchObject({
      message: "Node identity request cancelled or timed out",
    })
    expect(calls).toBe(0)

    const pending = new AbortController()
    const credential = NodeIdentity.authenticate(
      {
        ...options,
        token: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("fixture-secret aborted")),
              { once: true },
            )
          }),
      },
      pending.signal,
    )
    pending.abort()
    await expect(credential).rejects.toMatchObject({
      message: "Node identity request cancelled or timed out",
    })

    const reading = new AbortController()
    let cancelled = false
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const body = NodeIdentity.authenticate(
      {
        ...options,
        fetch: async () => {
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
      reading.signal,
    )
    await started
    reading.abort()
    await expect(body).rejects.toMatchObject({
      message: "Node identity request cancelled or timed out",
    })
    expect(cancelled).toBe(true)
  })
})

describe("authenticated resource adapter", () => {
  test("never falls back to legacy resources when strict admission is unavailable or revokes after identity proof", async () => {
    for (const status of [301, 401, 403, 404, 409, 500]) {
      for (const receipt of [false, true]) {
        const paths: string[] = []
        const node = await NodeIdentity.authenticate(
          {
            ...options,
            fetch: async (url) => {
              const path = new URL(url).pathname
              paths.push(path)
              if (path.endsWith("/identity")) return Response.json(proof())
              if (receipt && !path.endsWith("/received"))
                return Response.json(manifest)
              return Response.json(
                { error: "PRIVATE_UPSTREAM_CONTENT" },
                { status },
              )
            },
          },
          signal(),
        )
        const resources = Resources.create(node.resources(execution))
        await expect(resources.load(signal())).rejects.toMatchObject({
          _tag: "AgentResources.Error",
          status,
        })
        expect(paths).toEqual([
          "/v1/agent/node/identity",
          "/v1/agent/node/identity",
          `/v1/agent/node/jobs/${execution.id}/resources`,
          ...(receipt
            ? [`/v1/agent/node/jobs/${execution.id}/resources/received`]
            : []),
        ])
      }
    }
  })

  test("uses real loopback HTTP and stops resource admission when Node authorization is revoked", async () => {
    const paths: string[] = []
    let revoked = false
    let credential = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        expect(request.method).toBe("POST")
        expect(request.headers.get("content-type")).toBe("application/json")
        const authorization = request.headers.get("authorization")
        expect(authorization).toMatch(/^Bearer loopback-fixture-\d+$/)
        const input = await request.json()
        if (path === "/v1/agent/node/identity") {
          expect(input).toEqual({
            deviceId: expected.nodeId,
            workspaceId: expected.workspaceId,
          })
          return revoked
            ? Response.json(
                { error: "loopback-fixture-secret" },
                { status: 403 },
              )
            : Response.json(proof())
        }
        expect(authorization).toBe(`Bearer loopback-fixture-${credential}`)
        expect(input).toEqual({
          deviceId: expected.nodeId,
          leaseId: execution.leaseId,
          workspaceId: expected.workspaceId,
          sessionId: proof().sessionId,
          ...(path.endsWith("/received")
            ? { revision: manifest.revision }
            : {}),
        })
        return Response.json(
          path.endsWith("/received") ? { ok: true } : manifest,
        )
      },
    })
    try {
      const node = await NodeIdentity.authenticate(
        {
          baseUrl: `http://127.0.0.1:${server.port}`,
          expected,
          token: async () => `loopback-fixture-${++credential}`,
        },
        signal(),
      )
      const resources = Resources.create(node.resources(execution))
      expect(await resources.load(signal())).toEqual(manifest)
      expect(await resources.load(signal())).toEqual(manifest)
      expect(paths).toHaveLength(7)
      revoked = true
      await expect(resources.load(signal())).rejects.toMatchObject({
        status: 403,
      })
      expect(paths).toHaveLength(8)
      expect(paths.at(-1)).toBe("/v1/agent/node/identity")
      expect(credential).toBe(4)
    } finally {
      await server.stop(true)
    }
  })

  test("verifies the Node after permission then uses one credential for identity, manifest and receipt", async () => {
    const requests: { path: string; credential: string | null }[] = []
    let credentials = 0
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => `fixture-${++credentials}`,
        fetch: async (url, init) => {
          const path = new URL(url).pathname
          requests.push({
            path,
            credential: new Headers(init.headers).get("authorization"),
          })
          return Response.json(
            path.endsWith("/identity")
              ? proof()
              : path.endsWith("/received")
                ? { ok: true }
                : manifest,
          )
        },
      },
      signal(),
    )
    const config = node.resources(execution)
    expect(config.project).toEqual(manifest.project)
    expect(config.nodeSessionId).toBe(proof().sessionId)
    expect(requests).toHaveLength(1)
    const client = Resources.create(config)
    expect(requests).toHaveLength(1)
    expect(await client.load(signal())).toEqual(manifest)
    expect(await client.load(signal())).toEqual(manifest)
    expect(credentials).toBe(3)
    expect(requests.map((item) => item.credential)).toEqual([
      "Bearer fixture-1",
      "Bearer fixture-2",
      "Bearer fixture-2",
      "Bearer fixture-2",
      "Bearer fixture-3",
      "Bearer fixture-3",
      "Bearer fixture-3",
    ])
    expect(requests.map((item) => item.path)).toEqual([
      "/v1/agent/node/identity",
      "/v1/agent/node/identity",
      `/v1/agent/node/jobs/${execution.id}/resources`,
      `/v1/agent/node/jobs/${execution.id}/resources/received`,
      "/v1/agent/node/identity",
      `/v1/agent/node/jobs/${execution.id}/resources`,
      `/v1/agent/node/jobs/${execution.id}/resources/received`,
    ])
  })

  test("rejects revoked or substituted identity before any resource call, with no stale fallback", async () => {
    for (const response of [
      Response.json({ error: "fixture-secret" }, { status: 401 }),
      Response.json({ error: "fixture-secret" }, { status: 403 }),
      Response.json(proof({ nodeId: execution.id })),
      Response.json(proof({ userId: execution.id })),
      Response.json(proof({ workspaceId: execution.id })),
      Response.json(proof({ sessionId: execution.id })),
      Response.json(proof({ expiresAt: "2000-01-01T00:00:00Z" })),
    ]) {
      let calls = 0
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) => {
            expect(url).toEndWith("/identity")
            return ++calls === 1 ? Response.json(proof()) : response
          },
        },
        signal(),
      )
      await expect(
        Resources.create(node.resources(execution)).load(signal()),
      ).rejects.toBeInstanceOf(ResourceError)
      expect(calls).toBe(2)
    }
  })

  test("identity never substitutes for the resource lease, access or receipt checks", async () => {
    for (const denied of ["resources", "received"]) {
      const requests: string[] = []
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) => {
            requests.push(url)
            return url.endsWith("/identity")
              ? Response.json(proof())
              : url.endsWith(`/${denied}`)
                ? Response.json({ error: "PRIVATE_BODY" }, { status: 409 })
                : url.endsWith("/received")
                  ? Response.json({ ok: true })
                  : Response.json(manifest)
          },
        },
        signal(),
      )
      await expect(
        Resources.create(node.resources(execution)).load(signal()),
      ).rejects.toMatchObject({ status: 409 })
      expect(requests.at(-1)).toEndWith(`/${denied}`)
    }
  })
})
