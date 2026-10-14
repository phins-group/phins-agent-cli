import { describe, expect, test } from "bun:test"
import { modelPriority, parseModelReference, preferredNebiusModel, type ModelChoice } from "../../../src/shared/model-info"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parseModelReference("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parseModelReference("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("prioritizes Nemotron on Nebius before other NVIDIA, Nebius and other providers", () => {
    const values = ["custom/own-model", "nebius/Qwen/Qwen3", "nebius/nvidia/other-model", "nebius/nvidia/nemotron-3-super"]
      .map(parseModelReference)
    expect([...values].sort((a, b) => modelPriority(a) - modelPriority(b))).toEqual(values.toReversed())
    expect(modelPriority({ providerID: "custom", modelID: "nvidia/nemotron-3-super" })).toBe(3)
  })

  test("recommends only supplied tool-capable Nebius Nemotron models and prefers the preset", () => {
    const choice = (id: string, providerID = "nebius", supportsTools = true): ModelChoice => ({
      title: id, value: { providerID, modelID: id }, providerName: providerID, supportsTools,
    })
    const nano = choice("nvidia/nemotron-3-nano-30b-a3b")
    const superModel = choice("nvidia/nemotron-3-super-120b-a12b")
    const unavailable = { ...superModel, supportsTools: false }
    expect(preferredNebiusModel([nano, superModel])).toBe(superModel)
    expect(preferredNebiusModel([unavailable, nano])).toBe(nano)
    expect(preferredNebiusModel([unavailable, choice(superModel.value.modelID, "other"), choice("Qwen/Qwen3")])).toBeUndefined()
    expect(preferredNebiusModel([{ ...superModel, supportsTools: undefined }])).toBeUndefined()
    expect(preferredNebiusModel([])).toBeUndefined()
  })
})
