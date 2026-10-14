export * as SkillGuidance from "./guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentRegistry } from "../registry"
import { PermissionPolicy } from "../../security/permissions/service"
import { SkillRegistry } from "./registry"
import { SystemContext } from "../context/system"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) => {
  const lines = [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
  ]
  if (skills.length === 0) {
    lines.push("No skills are currently available.")
    return lines.join("\n")
  }
  lines.push("<available_skills>")
  for (const skill of skills) {
    lines.push("  <skill>")
    lines.push(`    <name>${skill.name}</name>`)
    lines.push(`    <description>${skill.description}</description>`)
    lines.push("  </skill>")
  }
  lines.push("</available_skills>")
  return lines.join("\n")
}

export interface Interface {
  readonly load: (agent: AgentRegistry.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/SkillGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillRegistry.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillRegistry.available(yield* skills.list(), agent)
        if (permitted.length === 0 && PermissionPolicy.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available: Summary[] = []
        for (const skill of permitted) {
          if (skill.description === undefined) continue
          available.push({ name: skill.name, description: skill.description })
        }
        available.sort((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer
