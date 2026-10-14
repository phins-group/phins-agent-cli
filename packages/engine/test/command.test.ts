import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommandRegistry } from "../src/agents/commands"
import { CatalogModel } from "../src/inference/catalog/model"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(CommandRegistry.locationLayer)

describe("CommandV2", () => {
  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandRegistry.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: CatalogModel.ID.make("claude"),
            providerID: CatalogProvider.ID.make("anthropic"),
            variant: CatalogModel.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        CommandRegistry.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: CatalogModel.ID.make("claude"),
            providerID: CatalogProvider.ID.make("anthropic"),
            variant: CatalogModel.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        CommandRegistry.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: CatalogModel.ID.make("claude"),
            providerID: CatalogProvider.ID.make("anthropic"),
            variant: CatalogModel.VariantID.make("high"),
          },
        }),
      ])
    }),
  )
})
