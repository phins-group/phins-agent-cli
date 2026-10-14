export * as ConfigAgent from "./agents"

import { Schema } from "effect"
import { Permission } from "../contracts/security/permission"
import { ConfigProvider } from "./providers"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}
