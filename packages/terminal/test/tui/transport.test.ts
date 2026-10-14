import { CatalogModel } from "@phins/engine/inference/catalog/model"
import { CatalogProvider } from "@phins/engine/inference/catalog/provider"
import { expect, test } from "bun:test"
import { expand as commandPrompt } from "@phins/engine/sessions/actions/command-template"
import { modelAvailable, modelInfo, modelPricing, stateTranscript, transcript } from "../../src/tui/transport/mapping"
import type { SessionClientState } from "@phins/engine/transport/client/session-state"
import { contextUsage } from "../../src/tui/render/context-usage"
import { compactionText } from "@phins/engine/sessions/run/messages"
import { Token } from "@phins/engine/shared/token"

const session: SessionClientState["snapshot"]["session"] = {
  id: "ses_fixture", projectID: "project_fixture", title: "Fixture",
  location: { directory: "/fixture" }, agent: "build",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  model: { id: "alpha", providerID: "fixture" }, time: { created: 1, updated: 2 },
}
const messages: SessionClientState["snapshot"]["messages"]["data"] = [
  { id: "msg_user", type: "user", text: "Xin chào", time: { created: 1 } },
  { id: "msg_assistant", type: "assistant", agent: "build", model: { id: "alpha", providerID: "fixture" },
    content: [{ id: "text", type: "text", text: "Chào" }, { id: "reasoning", type: "reasoning", text: "Suy nghĩ" }],
    time: { created: 2 } },
]

test("native presentation preserves message identity, parents and transient text without mutating history", () => {
  const entries = transcript(session, messages)
  expect(entries[0]?.parts[0]).toMatchObject({ type: "text", text: "Xin chào" })
  expect(entries[1]?.info).toMatchObject({ id: "msg_assistant", parentID: "msg_user", role: "assistant" })
  const state: SessionClientState = { snapshot: { session, after: 1,
    messages: { data: messages.toReversed(), cursor: {} } }, catchingUp: false, reason: "delta",
    drafts: [{ kind: "text", assistantMessageID: "msg_assistant", partID: "text", text: " bạn", partial: true }] }
  const live = stateTranscript(state)
  expect(live[1]?.parts[0]).toMatchObject({ id: entries[1]!.parts[0]!.id, text: "Chào bạn" })
  expect(messages[1]).toMatchObject({ content: [{ text: "Chào" }, { text: "Suy nghĩ" }] })
  expect(stateTranscript({ ...state, catchingUp: true })[1]?.parts[0]).toMatchObject({ text: "Chào" })
  expect(entries[1]!.parts.toSorted((a, b) => a.id.localeCompare(b.id)).map((part) => part.type))
    .toEqual(["text", "reasoning"])
})

test("commands preserve quoted positional and multiline arguments", () => {
  expect(commandPrompt("First $1; rest $2", 'one "two words" three')).toBe("First one; rest two words three")
  expect(commandPrompt("Review $ARGUMENTS", "first\nsecond")).toBe("Review first\nsecond")
  expect(commandPrompt("Review", "first\nsecond")).toBe("Review\n\nfirst\nsecond")
})

test("committed compaction resets displayed usage across live updates and reopened history", () => {
  const assistant = { ...messages[1]!, tokens: { input: 96000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } } }
  const checkpoint = { id: "msg_compaction", type: "compaction" as const, reason: "manual" as const,
    summary: "Preserve validation; run the affected tests next.", recent: "r".repeat(4000), time: { created: 3 } }
  const usage = (native: typeof messages) => {
    const entries = transcript(session, native)
    return contextUsage(entries.map((entry) => entry.info), Object.fromEntries(entries.map((entry) => [entry.info.id, entry.parts])))
  }
  expect(usage([assistant])).toMatchObject({ tokens: 98000, estimated: false })
  const compacted = usage([...messages, assistant, checkpoint])
  expect(compacted).toEqual({ tokens: Token.estimate(compactionText(checkpoint)), estimated: true })
  expect(compacted.tokens).toBeLessThan(2000)
  expect(usage(structuredClone([...messages, assistant, checkpoint]))).toEqual(compacted)
  const [entry] = transcript(session, [checkpoint])
  expect(entry!.parts).toContainEqual(expect.objectContaining({ type: "compaction", auto: false }))
  expect(entry!.parts.filter((part) => part.type === "text").every((part) => part.synthetic)).toBe(true)
  // A new request adds context before the next model usage measurement arrives.
  const request = { ...messages[0]!, id: "msg_next_user", text: "New details ".repeat(100) }
  expect(usage([assistant, checkpoint, request]).tokens).toBeGreaterThan(compacted.tokens)
  expect(usage([assistant, checkpoint, { ...assistant, id: "msg_next_assistant",
    tokens: { input: 2100, output: 50, reasoning: 0, cache: { read: 400, write: 0 } },
  }])).toMatchObject({ tokens: 2550, estimated: false, model: { providerID: "fixture", modelID: "alpha" } })
  expect(usage([assistant, checkpoint, { ...checkpoint, id: "msg_second", recent: "" }]).tokens)
    .toBe(Token.estimate(compactionText({ ...checkpoint, recent: "" })))
})


test("native model presentation preserves unknown, free and tiered pricing", () => {
  const model = CatalogModel.Info.empty(CatalogProvider.ID.make("fixture"), CatalogModel.ID.make("model"))
  const unknown = modelInfo(model)
  expect(modelPricing(unknown)).toEqual([])
  const cost = [
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
    { input: 2, output: 6, cache: { read: 0.5, write: 3 }, tier: { type: "context" as const, size: 200000 } },
  ]
  expect(modelPricing(modelInfo({ ...model, cost }))).toEqual(cost)
})

test("model recommendations preserve provider availability through the TUI adapter", () => {
  const model = CatalogModel.Info.empty(CatalogProvider.ID.make("nebius"), CatalogModel.ID.make("nvidia/nemotron"))
  const available = modelInfo({ ...model, enabled: true })
  expect(modelAvailable(available)).toBe(true)
  expect(modelAvailable(modelInfo({ ...model, enabled: false }))).toBe(false)
  expect(modelAvailable({ ...available, status: "deprecated" })).toBe(false)
  const unknown = { ...available, enabled: undefined }
  expect(modelAvailable(unknown)).toBe(false)
})
