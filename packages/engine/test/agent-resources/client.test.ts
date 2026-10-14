import { describe, expect, test } from "bun:test"
import * as Client from "../../src/agents/resources/client"
import { Manifest } from "../../src/agents/resources/contract"
import { ResourceError } from "../../src/agents/resources/error"

const project = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  deviceId: "fixture-node",
  directory: "/fixture/project",
}
const options: Client.Options = {
  baseUrl: "https://platform.example.test",
  token: async () => "fixture-secret",
  kind: "jobs",
  id: "00000000-0000-4000-8000-000000000002",
  leaseId: "00000000-0000-4000-8000-000000000003",
  project,
}
const item = {
  id: "00000000-0000-4000-8000-000000000004",
  revision: "a".repeat(64),
  kind: "knowledge" as const,
  title: "Internal notes",
  description: "",
  provenance: "QA source",
  content: "PRIVATE_FIXTURE_CONTENT",
  source: null,
  enabled: true as const,
  archived: false as const,
  updatedAt: "2026-10-04T00:00:00Z",
}
const manifest = { project, revision: "b".repeat(64), items: [item] }
const signal = () => new AbortController().signal

describe("fenced resource transport", () => {
  test("pins native routing and login, requiring UUIDs without reading credentials on invalid bindings", async () => {
    let credentials = 0
    const configured = {
      ...options,
      project: { ...project, deviceId: options.id },
      nodeSessionId: options.leaseId,
      token: async () => {
        credentials++
        return "native-fixture-secret"
      },
    }
    for (const change of [
      { nodeSessionId: "" },
      { nodeSessionId: "invalid" },
      { project },
    ])
      expect(() => Client.create({ ...configured, ...change })).toThrow(
        ResourceError,
      )
    expect(credentials).toBe(0)
    const nativeManifest = { ...manifest, project: { ...configured.project } }
    const paths: string[] = []
    const bodies: unknown[] = []
    const client = Client.create({
      ...configured,
      fetch: async (url, init) => {
        paths.push(new URL(url).pathname)
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(
          url.endsWith("/received") ? { ok: true } : nativeManifest,
        )
      },
    })
    configured.nodeSessionId = options.id
    configured.project.deviceId = options.leaseId
    expect(await client.load(signal())).toEqual(nativeManifest)
    expect(paths).toEqual([
      `/v1/agent/node/jobs/${options.id}/resources`,
      `/v1/agent/node/jobs/${options.id}/resources/received`,
    ])
    expect(bodies).toEqual([
      {
        deviceId: options.id,
        workspaceId: project.workspaceId,
        sessionId: options.leaseId,
        leaseId: options.leaseId,
      },
      {
        deviceId: options.id,
        workspaceId: project.workspaceId,
        sessionId: options.leaseId,
        leaseId: options.leaseId,
        revision: manifest.revision,
      },
    ])
    expect(credentials).toBe(1)
  })

  test("rejects unsafe origins, invalid identities and leases before credentials or requests", () => {
    let calls = 0
    const checked = {
      ...options,
      token: async () => {
        calls++
        return "secret"
      },
    }
    for (const baseUrl of [
      "http://platform.example.test",
      "https://user:password@example.test",
      "https://example.test?token=secret",
      "https://example.test#secret",
      "https://example.test/prefix",
      "ftp://example.test",
      "not-a-url",
    ])
      expect(() => Client.create({ ...checked, baseUrl })).toThrow(
        ResourceError,
      )
    for (const change of [
      { kind: "unknown" },
      { id: "../job" },
      { leaseId: "" },
      { project: { ...project, workspaceId: "invalid" } },
      { project: { ...project, deviceId: "" } },
      { project: { ...project, directory: "/bad\0project" } },
    ])
      expect(() =>
        Client.create({ ...checked, ...change } as Client.Options),
      ).toThrow(ResourceError)
    for (const baseUrl of [
      "http://127.0.0.1:5184",
      "http://localhost:5184",
      "http://[::1]:5184",
    ])
      expect(Client.create({ ...checked, baseUrl })).toHaveProperty("load")
    expect(calls).toBe(0)
  })

  test("captures immutable routing and one credential per read/receipt, and never caches", async () => {
    const routing = { ...options, project: { ...project } }
    const calls: { url: string; token: string | null; body: unknown }[] = []
    let credentials = 0
    const client = Client.create({
      ...routing,
      token: async () => `fixture-${++credentials}`,
      fetch: async (url, init) => {
        expect(init?.redirect).toBe("error")
        expect(init?.cache).toBe("no-store")
        calls.push({
          url: String(url),
          token: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json(
          String(url).endsWith("/received") ? { ok: true } : manifest,
        )
      },
    })
    routing.project.deviceId = "other-node"
    routing.leaseId = "00000000-0000-4000-8000-000000000009"
    expect(await client.load(signal())).toEqual(manifest)
    expect(await client.load(signal())).toEqual(manifest)
    expect(calls).toHaveLength(4)
    expect(calls.map((call) => call.token)).toEqual([
      "Bearer fixture-1",
      "Bearer fixture-1",
      "Bearer fixture-2",
      "Bearer fixture-2",
    ])
    expect(calls[0].url).toBe(
      `${options.baseUrl}/v1/channels/agent/jobs/${options.id}/resources`,
    )
    expect(calls[1].body).toEqual({
      deviceId: project.deviceId,
      leaseId: options.leaseId,
      revision: manifest.revision,
    })
    expect(credentials).toBe(2)
  })

  test("rejects malformed or mismatched manifests without acknowledging them", async () => {
    for (const body of [
      { ...manifest, project: { ...project, deviceId: "other" } },
      { ...manifest, project: { ...project, directory: "/other" } },
      {
        ...manifest,
        project: {
          ...project,
          workspaceId: "00000000-0000-4000-8000-000000000009",
        },
      },
      { ...manifest, revision: "invalid" },
      { ...manifest, items: [{ ...item, enabled: false }] },
      { ...manifest, items: [{ ...item, archived: true }] },
      { ...manifest, items: [item, item] },
      { ...manifest, items: [{ ...item, provenance: "" }] },
      { ...manifest, items: [{ ...item, content: "a".repeat(16001) }] },
    ]) {
      let calls = 0
      const client = Client.create({
        ...options,
        fetch: async () => {
          calls++
          return Response.json(body)
        },
      })
      await expect(client.load(signal())).rejects.toBeInstanceOf(ResourceError)
      expect(calls).toBe(1)
    }
  })

  test("shares strict source shape without allowing folder traversal or arbitrary MCP URLs", () => {
    for (const source of [
      { type: "folder", target: "../secrets" },
      { type: "folder", target: "/etc" },
      { type: "mcp", target: "https://example.test" },
    ])
      expect(
        Manifest.safeParse({
          ...manifest,
          items: [{ ...item, kind: "source", content: "", source }],
        }).success,
      ).toBe(false)
  })

  test("rejects stale or unconfirmed receipts and never returns content after an authorization error", async () => {
    for (const status of [401, 403, 409, 500]) {
      for (const failReceipt of [false, true]) {
        let calls = 0
        const client = Client.create({
          ...options,
          fetch: async () => {
            calls++
            return calls === (failReceipt ? 2 : 1)
              ? Response.json(
                  { error: "fixture-secret PRIVATE_FIXTURE_CONTENT" },
                  { status },
                )
              : Response.json(manifest)
          },
        })
        try {
          await client.load(signal())
          throw new Error("Expected request failure")
        } catch (error) {
          expect(error).toBeInstanceOf(ResourceError)
          expect(error).toHaveProperty("status", status)
          expect(JSON.stringify(error)).not.toMatch(
            /fixture-secret|PRIVATE_FIXTURE_CONTENT/,
          )
          expect(error).not.toHaveProperty("cause")
        }
        expect(calls).toBe(failReceipt ? 2 : 1)
      }
    }
    for (const receipt of [{}, null, { ok: false }]) {
      const client = Client.create({
        ...options,
        fetch: async (url) =>
          Response.json(String(url).endsWith("/received") ? receipt : manifest),
      })
      await expect(client.load(signal())).rejects.toThrow(
        "receipt was not confirmed",
      )
    }
  })

  test("cancels oversized and invalid UTF-8 streams without leaking payloads", async () => {
    for (const bytes of [
      new Uint8Array(4 * 1024 * 1024 + 1),
      Uint8Array.from([0xff]),
    ]) {
      let cancelled = false
      let calls = 0
      const client = Client.create({
        ...options,
        fetch: async () => {
          calls++
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes)
                if (bytes.length === 1) controller.close()
              },
              cancel() {
                cancelled = true
              },
            }),
          )
        },
      })
      await expect(client.load(signal())).rejects.toBeInstanceOf(ResourceError)
      expect(calls).toBe(1)
      if (bytes.length > 1) expect(cancelled).toBe(true)
    }
  })

  test("rejects invalid JSON, upstream exceptions and bad credentials with safe errors", async () => {
    for (const transport of [
      async () => {
        throw new Error("fixture-secret")
      },
      async () => new Response("PRIVATE_FIXTURE_CONTENT"),
    ]) {
      const client = Client.create({ ...options, fetch: transport })
      await expect(client.load(signal())).rejects.toThrow(
        "Could not load authorized project resources",
      )
    }
    for (const token of ["", "secret\nheader", "a".repeat(16385)]) {
      let requests = 0
      const client = Client.create({
        ...options,
        token: async () => token,
        fetch: async () => {
          requests++
          return Response.json(manifest)
        },
      })
      await expect(client.load(signal())).rejects.toThrow(
        "No valid resource credential",
      )
      expect(requests).toBe(0)
    }
  })

  test("aborts pending response streams and pre-aborted reads before fetching credentials", async () => {
    let credentials = 0
    const controller = new AbortController()
    controller.abort(new Error("fixture-secret"))
    const client = Client.create({
      ...options,
      token: async () => {
        credentials++
        return "secret"
      },
    })
    await expect(client.load(controller.signal)).rejects.toThrow("cancelled")
    expect(credentials).toBe(0)
    const pending = new AbortController()
    let cancelled = false
    let ready!: () => void
    const entered = new Promise<void>((resolve) => {
      ready = resolve
    })
    const streaming = Client.create({
      ...options,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              ready()
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })
    const reading = streaming.load(pending.signal)
    await entered
    pending.abort(new Error("fixture-secret"))
    await expect(reading).rejects.toThrow("cancelled")
    expect(cancelled).toBe(true)
  })
})
