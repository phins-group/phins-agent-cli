import { expect, spyOn, test } from "bun:test"
import { LLM, LLMEvent, Model } from "../src/inference/api"
import * as OpenAIChat from "../src/inference/protocols/openai-chat"
import * as Budget from "../src/sessions/run/budget"

const request = LLM.request({
  model: Model.make({
    id: "fixture",
    provider: "fixture",
    route: OpenAIChat.route,
  }),
  messages: [],
})

test("all runs have finite positive defaults and cannot opt into infinity", () => {
  expect(Budget.createRunBudget().limits).toEqual(Budget.defaults)
  for (const value of [0, -1, Infinity, NaN, 1.1])
    expect(() => Budget.createRunBudget({ max_turns: value })).toThrow()
})
test("provider attempts including retries consume the same turn budget", () => {
  const budget = Budget.createRunBudget({ max_turns: 2 })
  budget.attempt(request)
  budget.attempt(request)
  expect(() => budget.attempt(request)).toThrow("turns budget")
})
test("a shared budget retains its monotonic deadline across continuations", () => {
  const clock = spyOn(performance, "now").mockReturnValue(100)
  try {
    const budget = Budget.createRunBudget({ max_duration_ms: 1000 })
    clock.mockReturnValue(900)
    expect(budget.remainingDurationMs()).toBe(200)
    clock.mockReturnValue(1101)
    expect(budget.remainingDurationMs()).toBe(0)
    expect(() => budget.attempt(request)).toThrow("time budget")
  } finally {
    clock.mockRestore()
  }
})
test("input estimates and live output stop before an unbounded continuation", () => {
  expect(() => Budget.createRunBudget({ max_tokens: 1 }).attempt(request)).toThrow(
    "tokens budget",
  )
  const budget = Budget.createRunBudget({ max_tokens: 10 })
  expect(() =>
    budget.observe(LLMEvent.textDelta({ id: "text", text: "x".repeat(100) })),
  ).toThrow("tokens budget")
})
