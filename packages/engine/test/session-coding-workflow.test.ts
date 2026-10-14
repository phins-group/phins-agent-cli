import { expect, test } from "bun:test"
import { make } from "../src/sessions/run/coding-workflow"
const read = { name: "read", input: { path: "src/a.ts" } }
const plan = { name: "todowrite", input: {} }
const edit = { name: "edit", input: { path: "src/a.ts" } }
const check = { name: "bash", input: { command: "node --test" } }
const okay = { type: "json" as const, value: {} }
const testResult = (exitCode: number) => ({ type: "json" as const, value: { exitCode } })
function ready(max = 3) {
  const flow = make(["node --test"], max)
  flow.observe(read, okay)
  flow.observe(plan, { type: "json", value: { todos: [{ content: "Fix bug and validate", status: "in_progress" }] } })
  flow.observe(check, testResult(1))
  return flow
}
test("mutation requires successful inspection, actionable plan and actual baseline", () => {
  const flow = make(["node --test"])
  expect(flow.before(edit)).toContain("Read")
  flow.observe(read, { type: "error", value: "denied" })
  expect(flow.before(edit)).toContain("Read")
  flow.observe(read, okay)
  expect(flow.before(edit)).toContain("todowrite")
  flow.observe(plan, { type: "json", value: { todos: [] } })
  expect(flow.before(edit)).toContain("todowrite")
  flow.observe(plan, { type: "json", value: { todos: [{ content: "Repair" }] } })
  expect(flow.before(edit)).toContain("baseline")
  flow.observe(check, { type: "json", value: { output: "all tests passed" } })
  expect(flow.before(edit)).toContain("baseline")
  flow.observe(check, testResult(1))
  expect(flow.before(edit)).toBeUndefined()
})
test("failed edit is not a mutation; failures permit only bounded corrections", () => {
  const flow = ready(1)
  flow.observe(edit, { type: "error", value: "denied" })
  expect(flow.summary().mutationEpoch).toBe(0)
  flow.observe(edit, okay)
  flow.observe(check, testResult(1))
  expect(flow.before(edit)).toBeUndefined()
  flow.observe(edit, okay)
  flow.observe(check, testResult(1))
  expect(flow.before(edit)).toContain("exhausted")
})
test("passing checks become stale after an edit and never imply independent verification", () => {
  const flow = ready()
  flow.observe(edit, okay)
  flow.observe(check, testResult(0))
  expect(flow.summary().testStatus).toBe("passed-in-agent-loop")
  expect(flow.summary().verification).toBe("requires-independent-receipt")
  flow.observe(edit, okay)
  expect(flow.summary().testStatus).toBe("not-passed")
  expect(flow.summary().changedFiles).toEqual(["src/a.ts"])
})
test("unapproved commands and timeout cannot satisfy the test gate", () => {
  const flow = ready()
  flow.observe(edit, okay)
  flow.observe({ name: "bash", input: { command: "echo passed" } }, testResult(0))
  flow.observe(check, { type: "json", value: { exitCode: 0, timedOut: true } })
  expect(flow.summary().testStatus).toBe("not-passed")
  expect(() => make(["node --test"], Infinity)).toThrow()
})

test("structured tool settlement is used and forged completion fails", () => {
  const flow = make(["node --test"])
  flow.observe(read, { type: "text", value: "source text" }, {})
  flow.observe(plan, { type: "text", value: "human display" }, { todos: [{ content: "Fix" }] })
  flow.observe(check, { type: "text", value: "real compiler error" }, { exitCode: 1 })
  expect(flow.before(edit)).toBeUndefined()
  flow.observe(edit, okay)
  expect(() => flow.finish()).toThrow("without passing")
  flow.observe(check, testResult(1))
  flow.observe(edit, okay)
  expect(flow.summary().correctionAttempts).toBe(1)
  flow.observe(check, testResult(0))
  expect(() => flow.finish()).not.toThrow()
})

test("stale exact edits require a fresh read before another mutation", () => {
  const flow = ready()
  flow.observe(edit, { type: "error", value: "Could not find oldString in the file. It must match exactly." })
  expect(flow.before(edit)).toContain("Read")
  flow.observe(read, okay)
  expect(flow.before(edit)).toBeUndefined()
  flow.observe(edit, { type: "error", value: "File changed after permission approval. Read it again before editing." })
  expect(flow.before(edit)).toContain("Read")
})
