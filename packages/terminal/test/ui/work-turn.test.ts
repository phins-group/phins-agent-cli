import { expect, test } from "bun:test"
import type { Message, Part } from "@phins/engine/transport/client/create"
import { groupWorkMessages, groupWorkParts } from "../../src/tui/screens/session/work-turn"

const request = (id: string) => ({ id, role: "user" }) as Message
const reply = (id: string, parentID: string) => ({ id, role: "assistant", parentID }) as Message
const tool = (id: string, tool: string, status: string) => ({ id, type: "tool", tool, state: { status } }) as Part

test("groups adjacent replies while preserving queued requests and parent boundaries", () => {
  const messages = [request("u1"), reply("a1", "u1"), reply("a2", "u1"), request("u2"),
    reply("a3", "u1"), reply("a4", "u2"), reply("a5", "u2")]
  expect(groupWorkMessages(messages).map((group) => group.messageIDs)).toEqual([
    ["u1"], ["a1", "a2"], ["u2"], ["a3"], ["a4", "a5"],
  ])
  expect(groupWorkMessages([...messages, reply("a6", "u2")]).at(-1)?.id).toBe("a4")
  expect(groupWorkMessages([reply("orphan", "missing")])[0]?.messageIDs).toEqual(["orphan"])
})

test("only coalesces successful adjacent exploration, never failures, edits or pending permission", () => {
  const parts = [tool("read", "read", "completed"), tool("search", "grep", "completed"),
    tool("wait", "read", "running"), tool("failed", "read", "error"),
    tool("edit", "edit", "completed"), tool("next", "glob", "completed"),
    { id: "text", type: "text", text: "A new explanation" } as Part, tool("last", "read", "completed")]
  expect(groupWorkParts(parts).map((group) => group.partIDs)).toEqual([
    ["read", "search"], ["wait"], ["failed"], ["edit"], ["next"], ["text"], ["last"],
  ])
  expect(groupWorkParts(parts).filter((group) => group.exploration).map((group) => group.id)).toEqual(["read", "next", "last"])
})
