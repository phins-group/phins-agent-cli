import { resolve, type Info, type Resolved } from "../../../src/tui/config/settings"
import { TuiKeybind } from "../../../src/tui/config/keybindings"

type ResolvedInput = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention?: Partial<Resolved["attention"]>
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader_timeout?: number
}

export function createTuiResolvedConfig(input: ResolvedInput = {}) {
  return resolve(input)
}
