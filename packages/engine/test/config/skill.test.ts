import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../../src/settings/config"
import { ConfigSkillPlugin } from "../../src/settings/plugins/skill"
import { AppPaths } from "../../src/runtime/paths"
import { Location } from "../../src/workspace/location"
import { AbsolutePath } from "../../src/shared/schema"
import { SkillRegistry } from "../../src/agents/skills/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillRegistry.Source[] = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillRegistry.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source) => {
            sources.push(source)
          },
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        const dispose = Effect.sync(() => {
          sources.length = 0
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })

      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(AppPaths.Service, AppPaths.Service.of({ ...AppPaths.resolvePaths(), home: "/home/test" })),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.phins") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillRegistry.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.phins", "skill")),
        }),
        SkillRegistry.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.phins", "skills")),
        }),
        SkillRegistry.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        SkillRegistry.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillRegistry.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillRegistry.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )
})
