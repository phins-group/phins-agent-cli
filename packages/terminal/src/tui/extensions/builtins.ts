/** Registry built-in TUI plugins theo thứ tự mount ổn định. @module */
import type { TuiPlugin, TuiPluginModule } from "./contracts"
import HomeFooter from "../features/home-footer"
import SidebarContext from "../features/sidebar/context"
import SidebarFiles from "../features/sidebar/files"
import SidebarFooter from "../features/sidebar/footer"
import SidebarMcp from "../features/sidebar/mcp"
import SidebarTodo from "../features/sidebar/todo"
import Notifications from "../features/notifications"

import WhichKey from "../features/shortcut-hints"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

/** Host quyết định enabled state và lifecycle của các contribution này. */
export const builtinPlugins: readonly BuiltinTuiPlugin[] = [
  HomeFooter,
  SidebarContext,
  SidebarMcp,
  SidebarTodo,
  SidebarFiles,
  SidebarFooter,
  Notifications,
  WhichKey,
]
