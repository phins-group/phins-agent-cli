import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CommandRegistry } from "../../src/agents/commands"
import { Config } from "../../src/settings/config"
import { ConfigCommandPlugin } from "../../src/settings/plugins/command"
import { FileAccess } from "../../src/workspace/files/access"
import { CatalogModel } from "../../src/inference/catalog/model"
import { CatalogProvider } from "../../src/inference/catalog/provider"
import { AbsolutePath } from "../../src/shared/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.mergeAll(CommandRegistry.locationLayer, FileAccess.defaultLayer))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* CommandRegistry.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandRegistry.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: CatalogProvider.ID.make("anthropic"),
                id: CatalogModel.ID.make("claude"),
                variant: CatalogModel.VariantID.make("high"),
              },
              subtask: true,
            }),
            CommandRegistry.Info.make({ name: "empty", template: "" }),
            CommandRegistry.Info.make({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )
})
