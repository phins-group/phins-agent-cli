/// <reference path="../runtime/markdown.d.ts" />

export * as SkillPlugin from "./skills"

import { define } from "./definition"
import { Effect } from "effect"
import { AbsolutePath } from "../shared/schema"
import { SkillRegistry } from "../agents/skills/registry"
import customizePHINsContent from "./skills/customize-phins.md" with { type: "text" }

export const CustomizePHINsContent = customizePHINsContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillRegistry.EmbeddedSource.make({
          type: "embedded",
          skill: SkillRegistry.Info.make({
            name: "customize-phins",
            description:
              "Use ONLY when the user is editing or creating phins's own configuration: phins.json, phins.jsonc, files under .phins/, or files under ~/.phins/config/. Also use when creating or fixing phins agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring phins itself.",
            location: AbsolutePath.make("/builtin/customize-phins.md"),
            content: CustomizePHINsContent,
          }),
        }),
      )
    })
  }),
})
