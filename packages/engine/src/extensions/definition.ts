import type { PluginContext } from "./api"
import type { Effect, Scope } from "effect"

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (
    context: PluginContext,
  ) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}
