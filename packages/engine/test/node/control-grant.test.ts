import { describe, expect, test } from "bun:test"
import * as NodeIdentity from "../../src/execution/identity"
import type * as ControlGrant from "../../src/execution/control/grant"

const owner = {
  nodeId: "60000000-0000-4000-8000-000000000001",
  userId: "60000000-0000-4000-8000-000000000002",
  workspaceId: "60000000-0000-4000-8000-000000000003",
}
const loginId = "60000000-0000-4000-8000-000000000004"
const other = "60000000-0000-4000-8000-000000000009"
const expected: ControlGrant.Expected = {
  id: "60000000-0000-4000-8000-000000000005",
  revision: 1,
  action: "prompt",
  scope: {
    source: "web",
    granteeUserId: "60000000-0000-4000-8000-000000000006",
    projectId: "opaque-local-project",
    targetSessionId: "ses_opaque",
    directory: "/qa/project with space ",
    syncWorkspaceId: null,
  },
}
const attempt: ControlGrant.Attempt = {
  kind: "jobs",
  id: "60000000-0000-4000-8000-000000000007",
  leaseId: "60000000-0000-4000-8000-000000000008",
}
const identity = () => ({
  ...owner,
  version: 1 as const,
  sessionId: loginId,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
})
const proof = (change: object = {}) => ({
  ...expected,
  version: 1 as const,
  ownerUserId: owner.userId,
  nodeId: owner.nodeId,
  workspaceId: owner.workspaceId,
  loginSessionId: loginId,
  actions: ["prompt", "view"],
  rules: [
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "**/.env", effect: "deny" },
  ],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...change,
})
const signal = () => new AbortController().signal
const options: NodeIdentity.Options = {
  baseUrl: "https://platform.example.test",
  expected: owner,
  token: async () => "fixture-credential",
  fetch: async (url) =>
    Response.json(
      url.endsWith("/identity")
        ? identity()
        : proof(url.endsWith("/verify-attempt") ? { attempt } : {}),
    ),
}

describe("native Node grant and joined control snapshots", () => {
  test("rechecks each request with one credential, preserving ordered rules and immutable owner/actor/scope", async () => {
    const requests: { url: string; init: RequestInit }[] = []
    let credentials = 0
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => `fixture-${++credentials}`,
        fetch: async (url, init) => {
          requests.push({ url, init })
          return options.fetch!(url, init)
        },
      },
      signal(),
    )
    const grant = await node.verifyGrant(expected, signal())
    const control = await node.verifyControl({ ...expected, attempt }, signal())
    expect(grant.ownerUserId).toBe(owner.userId)
    expect(grant.scope.granteeUserId).not.toBe(grant.ownerUserId)
    expect(grant.scope.directory).toBe(expected.scope.directory)
    expect(grant.scope.syncWorkspaceId).toBeNull()
    expect(grant.rules.map((rule) => rule.effect)).toEqual(["allow", "deny"])
    for (const value of [
      grant,
      grant.scope,
      grant.actions,
      grant.rules,
      ...grant.rules,
      control,
      control.attempt,
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/agent/node/identity",
      "/v1/agent/node/identity",
      `/v1/agent/node/control/grants/${expected.id}/verify`,
      "/v1/agent/node/identity",
      `/v1/agent/node/control/grants/${expected.id}/verify-attempt`,
    ])
    for (const index of [2, 4]) {
      const { init } = requests[index]
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        redirect: "error",
      })
      expect(new Headers(init.headers).get("authorization")).toBe(
        new Headers(requests[index - 1].init.headers).get("authorization"),
      )
      expect(JSON.parse(String(init.body))).toEqual({
        deviceId: owner.nodeId,
        workspaceId: owner.workspaceId,
        sessionId: loginId,
        revision: 1,
        action: "prompt",
        scope: expected.scope,
        ...(index === 4 ? { attempt } : {}),
      })
    }
    expect(credentials).toBe(3)
    expect(node).not.toHaveProperty("prompt")
    expect(node).not.toHaveProperty("claim")
    expect(JSON.stringify(node)).not.toContain("fixture-")
    expect(grant).not.toHaveProperty("attempt")
  })

  test("input validation and cancellation happen before reading credentials or sending HTTP", async () => {
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
    for (const input of [
      null,
      {},
      { ...expected, id: "invalid" },
      { ...expected, revision: 0 },
      { ...expected, revision: "1" },
      { ...expected, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...expected, revision: 1.5 },
      { ...expected, action: "shell" },
      { ...expected, authority: "owner" },
      { ...expected, scope: { ...expected.scope, source: "cli" } },
      { ...expected, scope: { ...expected.scope, directory: " " } },
      {
        ...expected,
        scope: { ...expected.scope, directory: "x".repeat(2001) },
      },
      { ...expected, scope: { ...expected.scope, directory: "x\0" } },
      { ...expected, scope: { ...expected.scope, syncWorkspaceId: undefined } },
      { ...expected, scope: { ...expected.scope, grant: "allow" } },
    ])
      await expect(
        node.verifyGrant(input as ControlGrant.Expected, signal()),
      ).rejects.toMatchObject({ message: "Invalid expected Node grant" })
    for (const input of [
      { ...expected },
      { ...expected, attempt: { ...attempt, kind: "commands" } },
      { ...expected, attempt: { ...attempt, leaseId: "legacy" } },
      { ...expected, attempt: { ...attempt, actorUserId: owner.userId } },
    ])
      await expect(
        node.verifyControl(input as ControlGrant.ExpectedControl, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      node.verifyGrant(expected, aborted.signal),
    ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    await expect(
      node.verifyControl({ ...expected, attempt }, aborted.signal),
    ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    expect(calls).toBe(1)
  })

  test("snapshots all bindings, nested scope and attempt before asynchronous authentication", async () => {
    for (const joined of [false, true]) {
      let blocked = false,
        release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      let body: unknown
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          token: async () => {
            if (blocked) await waiting
            return "fixture-credential"
          },
          fetch: async (url, init) => {
            if (!url.endsWith("/identity")) body = JSON.parse(String(init.body))
            return options.fetch!(url, init)
          },
        },
        signal(),
      )
      const input = { ...structuredClone(expected), attempt: { ...attempt } }
      blocked = true
      const pending = joined
        ? node.verifyControl(input, signal())
        : node.verifyGrant(
            {
              id: input.id,
              revision: input.revision,
              action: input.action,
              scope: input.scope,
            },
            signal(),
          )
      input.id = other
      input.revision = 9
      input.action = "interrupt"
      Object.assign(input.scope, {
        source: "channel",
        granteeUserId: other,
        projectId: "other-project",
        targetSessionId: "ses_other",
        directory: "/other",
        syncWorkspaceId: "other",
      })
      Object.assign(input.attempt, {
        kind: "tasks",
        id: other,
        leaseId: other,
      })
      release()
      await pending
      expect(body).toMatchObject({
        revision: 1,
        action: "prompt",
        scope: expected.scope,
      })
      if (joined) expect(body).toHaveProperty("attempt", attempt)
    }
  })

  test("rejects every changed grant/scope/owner/action binding, stale expiry and unsupported tool rules", async () => {
    for (const body of [
      null,
      proof({ id: other }),
      proof({ revision: 2 }),
      proof({ revision: Number.MAX_SAFE_INTEGER + 1 }),
      proof({ ownerUserId: expected.scope.granteeUserId }),
      proof({ nodeId: other }),
      proof({ workspaceId: other }),
      proof({ loginSessionId: other }),
      proof({ action: "resume" }),
      proof({ actions: ["view"] }),
      proof({ actions: ["prompt", "prompt"] }),
      proof({ rules: [{ action: "read", resource: "*", effect: "ask" }] }),
      proof({
        rules: Array.from({ length: 65 }, () => ({
          action: "read",
          resource: "*",
          effect: "allow",
        })),
      }),
      proof({ version: 2 }),
      proof({ authority: "allow" }),
      proof({ attempt }),
      proof({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      proof({ expiresAt: new Date(Date.now() + 180_000).toISOString() }),
      proof({ expiresAt: "2026-02-30T00:00:00.000Z" }),
      ...[
        { source: "channel" },
        { granteeUserId: owner.userId },
        { projectId: "other" },
        { targetSessionId: loginId },
        { directory: expected.scope.directory.trim() },
        { syncWorkspaceId: owner.workspaceId },
      ].map((change) => proof({ scope: { ...expected.scope, ...change } })),
    ]) {
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) =>
            Response.json(url.endsWith("/identity") ? identity() : body),
        },
        signal(),
      )
      await expect(node.verifyGrant(expected, signal())).rejects.toBeInstanceOf(
        NodeIdentity.IdentityError,
      )
    }
  })

  test("joined proofs require the exact native attempt; they cannot fall back to separate snapshots", async () => {
    for (const value of [
      undefined,
      { ...attempt, kind: "tasks" },
      { ...attempt, id: other },
      { ...attempt, leaseId: other },
      { ...attempt, actorUserId: expected.scope.granteeUserId },
    ]) {
      const paths: string[] = []
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) => {
            paths.push(new URL(url).pathname)
            return Response.json(
              url.endsWith("/identity")
                ? identity()
                : proof(value ? { attempt: value } : {}),
            )
          },
        },
        signal(),
      )
      await expect(
        node.verifyControl({ ...expected, attempt }, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      expect(paths).toHaveLength(3)
      expect(paths.at(-1)).toEndWith("/verify-attempt")
    }
  })

  test("login changes and identity revocation stop before the grant endpoint", async () => {
    for (const changed of [true, false]) {
      let calls = 0
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async () =>
            ++calls === 1
              ? Response.json(identity())
              : changed
                ? Response.json({ ...identity(), sessionId: other })
                : Response.json(
                    { error: "PRIVATE_AUTH_RESPONSE" },
                    { status: 403 },
                  ),
        },
        signal(),
      )
      await expect(
        node.verifyControl({ ...expected, attempt }, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      expect(calls).toBe(2)
    }
  })

  test("denies missing native endpoints/status errors, releases their body and never exposes upstream secrets", async () => {
    for (const joined of [false, true])
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
                      new TextEncoder().encode("PRIVATE_RESPONSE_TOKEN"),
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
        const request = joined
          ? node.verifyControl({ ...expected, attempt }, signal())
          : node.verifyGrant(expected, signal())
        await expect(request).rejects.toMatchObject({
          message: "Node grant is unavailable or no longer authorized",
          status,
        })
        expect(cancelled).toBe(true)
        expect(paths).toHaveLength(3)
      }
  })

  test("accepts bounded grants larger than a work proof and rejects over-limit, bad UTF-8 or malformed JSON", async () => {
    const large = proof({
      rules: Array.from({ length: 32 }, () => ({
        action: "read",
        resource: "x".repeat(1024),
        effect: "allow",
      })),
    })
    expect(
      new TextEncoder().encode(JSON.stringify(large)).length,
    ).toBeGreaterThan(16 * 1024)
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) =>
          Response.json(url.endsWith("/identity") ? identity() : large),
      },
      signal(),
    )
    expect((await node.verifyGrant(expected, signal())).rules).toHaveLength(32)
    for (const bytes of [
      new Uint8Array(80 * 1024 + 1),
      new Uint8Array([255]),
      new TextEncoder().encode("PRIVATE_SECRET bad-json"),
    ]) {
      let cancelled = false
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            if (bytes.length <= 80 * 1024) controller.close()
          },
          cancel() {
            cancelled = true
          },
        }),
      )
      const checked = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) =>
            url.endsWith("/identity") ? Response.json(identity()) : response,
        },
        signal(),
      )
      await expect(
        checked.verifyGrant(expected, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      expect(response.body?.locked).toBe(false)
      if (bytes.length > 80 * 1024) expect(cancelled).toBe(true)
    }
  })

  test("abort cancels only the proof stream, releases its reader and sends no other action", async () => {
    const controller = new AbortController()
    let started!: () => void,
      cancelled = false
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            started()
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      ),
    )
    const paths: string[] = []
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) => {
          paths.push(new URL(url).pathname)
          return url.endsWith("/identity")
            ? Response.json(identity())
            : response
        },
      },
      signal(),
    )
    const pending = node.verifyControl(
      { ...expected, attempt },
      controller.signal,
    )
    await reading
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      message: "Node grant request cancelled or timed out",
    })
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
    expect(paths).toHaveLength(3)
  })

  test("callback/transport failures are redacted, empty rules stay empty and safe integer revisions round-trip", async () => {
    let failed = false
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => {
          if (failed) throw new Error("PRIVATE_CALLBACK_SECRET")
          return "fixture-credential"
        },
        fetch: async (url) =>
          Response.json(
            url.endsWith("/identity")
              ? identity()
              : proof({ rules: [], revision: Number.MAX_SAFE_INTEGER }),
          ),
      },
      signal(),
    )
    expect(
      (
        await node.verifyGrant(
          { ...expected, revision: Number.MAX_SAFE_INTEGER },
          signal(),
        )
      ).rules,
    ).toEqual([])
    failed = true
    await expect(node.verifyGrant(expected, signal())).rejects.toMatchObject({
      message: "Could not verify Node identity",
    })
    const broken = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) => {
          if (!url.endsWith("/identity"))
            throw new Error("PRIVATE_TRANSPORT_SECRET")
          return Response.json(identity())
        },
      },
      signal(),
    )
    await expect(broken.verifyGrant(expected, signal())).rejects.toMatchObject({
      message: "Could not verify Node grant",
    })
  })

  test("loopback HTTP validates joined proof once and rechecks revision without dispatching work", async () => {
    let revision = 1
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        requests.push(path)
        expect(req.method).toBe("POST")
        expect(req.headers.get("authorization")).toBe(
          "Bearer fixture-credential",
        )
        if (path.endsWith("/identity")) return Response.json(identity())
        expect(path).toBe(
          `/v1/agent/node/control/grants/${expected.id}/verify-attempt`,
        )
        expect(await req.json()).toEqual({
          deviceId: owner.nodeId,
          workspaceId: owner.workspaceId,
          sessionId: loginId,
          revision: 1,
          action: "prompt",
          scope: expected.scope,
          attempt,
        })
        return Response.json(proof({ attempt, revision }))
      },
    })
    try {
      const node = await NodeIdentity.authenticate(
        { ...options, baseUrl: server.url.origin, fetch: globalThis.fetch },
        signal(),
      )
      expect(
        (await node.verifyControl({ ...expected, attempt }, signal())).attempt,
      ).toEqual(attempt)
      revision = 2
      await expect(
        node.verifyControl({ ...expected, attempt }, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      expect(requests).toHaveLength(5)
    } finally {
      server.stop(true)
    }
  })
})
