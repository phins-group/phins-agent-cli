export * as Tools from "./registration"

import { Context, Effect, Scope } from "effect"
import { Tool } from "./definition"

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
}

/** Narrow registration-only Location capability. */
export class Service extends Context.Service<Service, Interface>()("@phins/v2/Tools") {}
