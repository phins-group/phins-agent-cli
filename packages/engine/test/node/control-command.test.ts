import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeIdentity from "../../src/execution/identity"
import type * as ControlCommand from "../../src/execution/control/command"

const owner = {
  nodeId: "70000000-0000-4000-8000-000000000001",
  userId: "70000000-0000-4000-8000-000000000002",
  workspaceId: "70000000-0000-4000-8000-000000000003",
}
const expected: ControlCommand.Expected = {
  id: "70000000-0000-4000-8000-000000000005",
  revision: 1,
  action: "prompt",
  scope: {
    source: "web",
    granteeUserId: "70000000-0000-4000-8000-000000000006",
    projectId: "global",
    targetSessionId: "ses_remote_fixture",
    directory: "/qa/project",
    syncWorkspaceId: null,
  },
  attempt: {
    kind: "jobs",
    id: "70000000-0000-4000-8000-000000000007",
    leaseId: "70000000-0000-4000-8000-000000000008",
  },
}
const identity = () => ({
  ...owner,
  version: 1,
  sessionId: "70000000-0000-4000-8000-000000000004",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
})
const command = (text = "Read from the server queue") => ({
  version: "phins.node-control.v1",
  id: expected.attempt.id,
  action: "prompt",
  delivery: "queue",
  payload: { text },
  payloadHash: createHash("sha256")
    .update(JSON.stringify({ text }))
    .digest("hex"),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
})
const proof = () => ({
  ...expected,
  version: 1,
  nodeId: owner.nodeId,
  ownerUserId: owner.userId,
  workspaceId: owner.workspaceId,
  loginSessionId: identity().sessionId,
  actions: ["prompt"],
  rules: [],
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  command: command(),
})
const signal = () => new AbortController().signal
const options: NodeIdentity.Options = {
  baseUrl: "https://platform.example.test",
  expected: owner,
  token: async () => "fixture-token",
  fetch: async (url) =>
    Response.json(url.endsWith("/identity") ? identity() : proof()),
}

describe("native prompt command adapter", () => {
  test("explicit record and verify use different private methods with no payload supplied by the client", async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url, init) => {
          requests.push({ url, init })
          return options.fetch!(url, init)
        },
      },
      signal(),
    )
    const recorded = await node.recordCommand(expected, signal())
    const verified = await node.verifyCommand(expected, signal())
    expect(verified.command.payload.text).toBe("Read from the server queue")
    for (const value of [
      recorded,
      recorded.command,
      recorded.command.payload,
      verified.attempt,
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(
      requests.map(({ url, init }) => [new URL(url).pathname, init.method]),
    ).toEqual([
      ["/v1/agent/node/identity", "POST"],
      ["/v1/agent/node/identity", "POST"],
      [
        `/v1/agent/node/control/grants/${expected.id}/commands/${expected.attempt.id}`,
        "PUT",
      ],
      ["/v1/agent/node/identity", "POST"],
      [
        `/v1/agent/node/control/grants/${expected.id}/commands/${expected.attempt.id}/verify`,
        "POST",
      ],
    ])
    for (const index of [2, 4]) {
      expect(JSON.parse(String(requests[index].init.body))).toEqual({
        deviceId: owner.nodeId,
        workspaceId: owner.workspaceId,
        sessionId: identity().sessionId,
        revision: expected.revision,
        action: expected.action,
        scope: expected.scope,
        attempt: expected.attempt,
      })
    }
  })

  test("unsupported actions/kinds and client payload/authority are rejected before credential access", async () => {
    let calls = 0
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        token: async () => {
          calls++
          return "fixture"
        },
      },
      signal(),
    )
    for (const input of [
      { ...expected, action: "resume" },
      { ...expected, attempt: { ...expected.attempt, kind: "patch" } },
      { ...expected, payload: { text: "spoofed" } },
      { ...expected, origin: {} },
      { ...expected, revision: 0 },
    ]) {
      await expect(
        node.recordCommand(input as ControlCommand.Expected, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
      await expect(
        node.verifyCommand(input as ControlCommand.Expected, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    }
    expect(calls).toBe(1)
  })

  test("a native task needs its own matching attempt proof and cannot borrow a job proof", async () => {
    const task: ControlCommand.Expected = {
      ...expected,
      attempt: { ...expected.attempt, kind: "tasks" },
    }
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) =>
          Response.json(
            url.endsWith("/identity")
              ? identity()
              : { ...proof(), attempt: task.attempt },
          ),
      },
      signal(),
    )
    expect((await node.recordCommand(task, signal())).attempt.kind).toBe(
      "tasks",
    )
    expect((await node.verifyCommand(task, signal())).attempt.kind).toBe(
      "tasks",
    )
    const old = await NodeIdentity.authenticate(options, signal())
    await expect(old.verifyCommand(task, signal())).rejects.toBeInstanceOf(
      NodeIdentity.IdentityError,
    )
  })

  test("rejects swapped command IDs, hashes, protocols, deadlines, fields, delivery and payload size", async () => {
    const base = command()
    for (const value of [
      { ...base, id: expected.id },
      { ...base, payloadHash: "0".repeat(64) },
      { ...base, payload: { text: "tampered" } },
      { ...base, version: "other" },
      { ...base, action: "interrupt" },
      { ...base, delivery: "steer" },
      { ...base, expiresAt: new Date(Date.now() - 1).toISOString() },
      { ...base, expiresAt: new Date(Date.now() + 10_000).toISOString() },
      { ...base, authority: true },
      command("x".repeat(8001)),
      command("\u0001".repeat(8000)),
      command(" "),
      command("hello\0world"),
      { ...base, payload: { ...base.payload, files: [] } },
    ]) {
      const node = await NodeIdentity.authenticate(
        {
          ...options,
          fetch: async (url) =>
            Response.json(
              url.endsWith("/identity")
                ? identity()
                : { ...proof(), command: value },
            ),
        },
        signal(),
      )
      await expect(
        node.verifyCommand(expected, signal()),
      ).rejects.toBeInstanceOf(NodeIdentity.IdentityError)
    }
  })

  test("verification errors never create, retry or fall back to an attempt proof", async () => {
    const requests: string[] = []
    const node = await NodeIdentity.authenticate(
      {
        ...options,
        fetch: async (url) => {
          requests.push(url)
          return url.endsWith("/identity")
            ? Response.json(identity())
            : new Response("SECRET", { status: 409 })
        },
      },
      signal(),
    )
    await expect(node.verifyCommand(expected, signal())).rejects.toMatchObject({
      status: 409,
    })
    expect(requests).toHaveLength(3)
    expect(requests.at(-1)).toEndWith("/verify")
    expect(requests.some((url) => url.endsWith("/verify-attempt"))).toBe(false)
  })
})
