/**
 * Tập capability được plugin Effect nhận khi setup; các domain có `reload`
 * phải tái đọc contribution sau khi registration thay đổi.
 */
import type { PluginOptions } from "../options.js"
import type { AgentHooks } from "./agent.js"

import type { CatalogHooks } from "./catalog.js"
import type { CommandHooks } from "./command.js"
import type { IntegrationHooks } from "./integration.js"
import type { PluginDomain } from "./plugin.js"
import type { ReferenceHooks } from "./reference.js"
import type { SkillHooks } from "./skill.js"
import type { Reload } from "./registration.js"
import type { ToolHooks } from "./tool.js"

export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: AgentHooks & Reload
  readonly catalog: CatalogHooks & Reload
  readonly command: CommandHooks & Reload
  readonly integration: IntegrationHooks & Reload
  readonly plugin: PluginDomain
  readonly reference: ReferenceHooks & Reload
  readonly skill: SkillHooks & Reload
  readonly tool: ToolHooks
}
