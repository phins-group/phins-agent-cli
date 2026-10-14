import { expect, test } from "bun:test"
import { summarizeTools, type ToolEvidence } from "../../src/shared/coding-report"
import { renderTranscriptSummary } from "../../src/tui/screens/session/transcript-summary"
import type { Part } from "@phins/engine/transport/client/create"
const tool = (name: string, output = {}, status = "completed"): ToolEvidence => ({ name, status,
  input: name === "bash" ? { command: "node --test" } : { path: "src/fix.ts" }, output })
test("failed/pending edits never count as changed files", () => {
  expect(summarizeTools([tool("edit", {}, "error"), tool("write", {}, "pending")])).toMatchObject({
    edits: 0, changedFiles: [], failedTools: 1, verification: "unverified",
  })
})
test("actual exit codes and corrections stay distinct from independent verification", () => {
  const evidence = summarizeTools([tool("edit"), tool("bash", { exitCode: 1 }), tool("edit"), tool("bash", { exitCode: 0 })])
  expect(evidence).toMatchObject({ edits: 2, changedFiles: ["src/fix.ts"], correctionAttempts: 1, verification: "unverified" })
  expect(evidence.commands.map((c) => c.afterLatestEdit)).toEqual([false, true])
})
test("a later edit invalidates the earlier passing command", () => {
  expect(summarizeTools([tool("edit"), tool("bash", { exitCode: 0 }), tool("edit")]).commands[0]!.afterLatestEdit).toBe(false)
})
test("TUI shows denied edit as failure and completed edit as unverified", () => {
  const part = (status: "error" | "completed"): Part => ({ type: "tool", tool: "edit", id: "tool_1", sessionID: "ses_1", messageID: "msg_1", callID: "call_1",
    state: status === "error" ? { status, input: { path: "src/a.ts" }, error: "denied", time: { start: 0, end: 1 } }
      : { status, input: { path: "src/a.ts" }, metadata: {}, title: "edit", output: "changed", time: { start: 0, end: 1 } } })
  expect(renderTranscriptSummary({ parts: [part("error")] })).toMatchObject({ kind: "failed", label: "Tool failed" })
  expect(renderTranscriptSummary({ parts: [part("completed")] })).toMatchObject({ kind: "unverified", label: "Updated 1 file" })
})

test("a confirmed interruption is reported as stopped, not a successful result", () => {
  expect(renderTranscriptSummary({ parts: [], error: { name: "MessageAbortedError" } }))
    .toMatchObject({ kind: "unverified", label: "Stopped" })
})
