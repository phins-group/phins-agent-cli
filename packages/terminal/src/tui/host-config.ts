import { Context } from "effect"
import type { TuiInput } from "./app"

export type TuiSetup = Pick<TuiInput, "config" | "pluginHost">
export type TuiHostLoader = (directory: string) => Promise<TuiSetup>

/** Agent supplies its original config and plugin host lazily. */
export const TuiHost = Context.Reference<TuiHostLoader | undefined>("cli.TuiHost", {
  defaultValue: () => undefined,
})
