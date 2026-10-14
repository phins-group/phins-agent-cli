import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentRegistry } from "../../src/agents/registry"
import { FileAccess } from "../../src/workspace/files/access"
import { SkillPlugin } from "../../src/extensions/skills"
import { SkillRegistry } from "../../src/agents/skills/registry"
import { SkillDiscovery } from "../../src/agents/skills/discovery"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(
  SkillRegistry.layer.pipe(
    Layer.provide(FileAccess.defaultLayer),
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provideMerge(AgentRegistry.locationLayer),
  ),
)

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-phins skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillRegistry.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-phins",
          description: expect.stringContaining("phins's own configuration"),
        }),
      )
    }),
  )
})
