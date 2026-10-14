import { expect, test } from "bun:test"
import { ToolFailure } from "../../src/inference/api"
import { ToolFailure as LeafFailure } from "../../src/inference/tools/failure"
import { Schema } from "effect"

test("the leaf ToolFailure export retains the existing class and codec", () => {
  expect(LeafFailure).toBe(ToolFailure)
  const failure = new LeafFailure({
    message: "Expected failure",
    metadata: { tool: "fixture" },
  })
  expect(failure).toBeInstanceOf(ToolFailure)
  expect(Schema.encodeSync(ToolFailure)(failure)).toMatchObject({
    _tag: "LLM.ToolFailure",
    message: "Expected failure",
    metadata: { tool: "fixture" },
  })
})
