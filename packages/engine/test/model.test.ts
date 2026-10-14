import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CatalogModel } from "../src/inference/catalog/model"
import { CatalogProvider } from "../src/inference/catalog/provider"

const decode = Schema.decodeUnknownSync(CatalogModel.Ref)

describe("ModelV2.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic" })).toEqual({
      id: CatalogModel.ID.make("claude-sonnet"),
      providerID: CatalogProvider.ID.make("anthropic"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic", variant: "high" })).toEqual({
      id: CatalogModel.ID.make("claude-sonnet"),
      providerID: CatalogProvider.ID.make("anthropic"),
      variant: CatalogModel.VariantID.make("high"),
    })
  })
})
