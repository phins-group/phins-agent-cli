/** Hiện thực skill.list từ registry SkillRegistry của location. @module */
import { SkillRegistry } from "../../../agents/skills/registry"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers.handle("skill.list", () => response(SkillRegistry.Service.use((skill) => skill.list()))),
)
