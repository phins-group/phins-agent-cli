/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@phins/engine/transport/client/create"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("snapshot ordering matches binary search for mixed-case request IDs", async () => {
    await using tmp = await tmpdir()
    const { app, emit, sync } = await mount((url) => url.pathname === "/permission" ? json(
      ["per_a", "per_Z"].map((id) => ({ id, sessionID: "session-a", permission: "read", patterns: [], metadata: {}, always: [] })),
    ) : undefined, tmp.path)
    try {
      expect(sync.data.permission["session-a"].map((request) => request.id)).toEqual(["per_Z", "per_a"])
      emit({ directory, project: "proj_test", payload: {
        id: "evt_cancel_upper", type: "permission.cancelled", properties: { sessionID: "session-a", requestID: "per_Z" },
      } })
      await wait(() => sync.data.permission["session-a"].length === 1)
      expect(sync.data.permission["session-a"][0].id).toBe("per_a")
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconnect snapshot removes missed cancellations without undoing newer events", async () => {
    await using tmp = await tmpdir()
    let snapshot: Promise<Response> | undefined
    let reads = 0
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname !== "/permission") return
      reads++
      return snapshot ?? json([])
    }, tmp.path)
    const request = (id: string) => ({ id, sessionID: "session-a", permission: "skill", patterns: [], metadata: {}, always: [] })
    const send = (payload: GlobalEvent["payload"]) => emit({ directory, project: "proj_test", payload })
    try {
      send({ id: "evt_old", type: "permission.asked", properties: request("perm-old") })
      emit({ directory: "/tmp/other-project", project: "proj_test", workspace: "ws_other", payload: {
        id: "evt_other", type: "permission.asked", properties: { ...request("perm-other"), sessionID: "session-other" },
      } })
      await wait(() => sync.data.permission["session-a"]?.length === 1)
      const response = Promise.withResolvers<Response>()
      snapshot = response.promise
      const before = reads
      send({ id: "evt_connect", type: "server.connected", properties: {} })
      await wait(() => reads > before)
      send({ id: "evt_cancel", type: "permission.cancelled", properties: { sessionID: "session-a", requestID: "perm-cancel" } })
      send({ id: "evt_new", type: "permission.asked", properties: request("perm-new") })
      await wait(() => sync.data.permission["session-a"]?.some((x) => x.id === "perm-new") === true)
      response.resolve(json([request("perm-cancel"), request("perm-keep")]))
      await wait(() => sync.data.permission["session-a"]?.some((x) => x.id === "perm-keep") === true)
      expect(sync.data.permission["session-a"].map((x) => x.id)).toEqual(["perm-keep", "perm-new"])
      expect(sync.data.permission["session-other"].map((x) => x.id)).toEqual(["perm-other"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("cancelled permission is removed without clearing other requests", async () => {
    await using tmp = await tmpdir()
    const { app, emit, sync } = await mount(undefined, tmp.path)
    try {
      for (const [sessionID, id] of [["session-a", "perm-a"], ["session-a", "perm-b"], ["session-b", "perm-c"]]) {
        emit({ directory, project: "proj_test", payload: {
          id: `event-${id}`, type: "permission.asked",
          properties: { id, sessionID, permission: "skill", patterns: ["probe"], metadata: {}, always: [] },
        } })
      }
      await wait(() => sync.data.permission["session-a"]?.length === 2 && sync.data.permission["session-b"]?.length === 1)
      emit({ directory, project: "proj_test", payload: {
        id: "event-cancel", type: "permission.cancelled",
        properties: { sessionID: "session-a", requestID: "perm-a" },
      } })
      await wait(() => sync.data.permission["session-a"]?.length === 1)
      expect(sync.data.permission["session-a"].map((request) => request.id)).toEqual(["perm-b"])
      expect(sync.data.permission["session-b"].map((request) => request.id)).toEqual(["perm-c"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/terminal")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})
