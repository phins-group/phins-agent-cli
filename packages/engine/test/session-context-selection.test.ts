import { expect, test } from "bun:test"
import { Message } from "../src/inference/schema/messages"
import { selectContext } from "../src/sessions/context/selection"
const body = "source line with useful context\n".repeat(100)
const read = (id: string, value = body, path = "src/a.ts") => [
  Message.assistant({ type: "tool-call", id, name: "read", input: { path, offset: 1 } }),
  Message.tool({ id, name: "read", result: { type: "text", value } }),
]
test("identical large reads shrink a request while full source and history remain", () => {
  const messages = [...read("one"), ...read("two")]
  const before = JSON.stringify(messages)
  const selected = selectContext(messages)
  expect(selected.duplicateReads).toBe(1)
  expect(selected.removedBytes).toBeGreaterThan(2800)
  expect(JSON.stringify(selected.messages)).toContain("Identical read result to tool call one")
  expect(JSON.stringify(selected.messages)).toContain(JSON.stringify(body).slice(1, -1))
  expect(JSON.stringify(messages)).toBe(before)
  console.log(JSON.stringify({ metric: "context-fixture", beforeBytes: Buffer.byteLength(before),
    afterBytes: Buffer.byteLength(JSON.stringify(selected.messages)), duplicateReads: selected.duplicateReads }))
})
test("edited content, another path and a compacted-away result never reuse a cache", () => {
  expect(selectContext([...read("one"), ...read("two", body + "edit")]).duplicateReads).toBe(0)
  expect(selectContext([...read("one"), ...read("two", body, "src/b.ts")]).duplicateReads).toBe(0)
  expect(selectContext(read("two")).duplicateReads).toBe(0)
})
test("errors and short reads are retained verbatim", () => {
  const messages = [...read("one", "small"), ...read("two", "small"), Message.tool({ id: "three", name: "read", result: { type: "error", value: body } })]
  expect(selectContext(messages).messages).toEqual(messages)
})
