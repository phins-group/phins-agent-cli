import type { TuiDialogSelectOption, TuiPluginApi, TuiSlotProps } from "./contracts"
import type { TuiConfig } from "../config/settings"
import type { useEvent } from "../state/event"
import type { useNavigation } from "../state/navigation"
import type { useAgentClient } from "../state/agent-client"
import type { useSessionState } from "../state/sessions"
import type { useTheme } from "../theme/provider"
import { Dialog as DialogUI, type useDialog } from "../components/dialog"
import type { usePHINsKeymap } from "../state/keymap"
import type { useKV } from "../state/kv"
import { DialogAlert } from "../components/dialog-alert"
import { DialogConfirm } from "../components/dialog-confirm"
import { DialogPrompt } from "../components/dialog-prompt"
import { DialogSelect, type DialogSelectOption as SelectOption } from "../components/dialog-select"
import { Prompt } from "../composer/input"
import type { useToast } from "../components/toast"
import * as Keymap from "../state/keymap"
import { createCommandShim } from "./legacy-commands"
import type { PluginRoutes } from "./routes"
export type { RouteMap } from "./routes"
export { createPluginRoutes, createTuiApi } from "./routes"

type Input = {
  version: string
  tuiConfig: TuiConfig.Resolved
  dialog: ReturnType<typeof useDialog>
  keymap: ReturnType<typeof usePHINsKeymap>
  kv: ReturnType<typeof useKV>
  route: ReturnType<typeof useNavigation>
  routes: PluginRoutes
  event: ReturnType<typeof useEvent>
  sdk: ReturnType<typeof useAgentClient>
  sync: ReturnType<typeof useSessionState>
  theme: ReturnType<typeof useTheme>
  toast: ReturnType<typeof useToast>
  renderer: TuiPluginApi["renderer"]
  attention: TuiPluginApi["attention"]
  Slot: TuiPluginApi["ui"]["Slot"]
}

function routeNavigate(route: ReturnType<typeof useNavigation>, name: string, params?: Record<string, unknown>) {
  if (name === "home") {
    route.navigate({ type: "home" })
    return
  }

  if (name === "session") {
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string") return
    route.navigate({ type: "session", sessionID })
    return
  }

  route.navigate({ type: "plugin", id: name, data: params })
}

function routeCurrent(route: ReturnType<typeof useNavigation>): TuiPluginApi["route"]["current"] {
  if (route.data.type === "home") return { name: "home" }
  if (route.data.type === "session") {
    return {
      name: "session",
      params: {
        sessionID: route.data.sessionID,
        prompt: route.data.prompt,
      },
    }
  }

  return {
    name: route.data.id,
    params: route.data.data,
  }
}

function mapOption<Value>(item: TuiDialogSelectOption<Value>): SelectOption<Value> {
  return {
    ...item,
    onSelect: () => item.onSelect?.(),
  }
}

function pickOption<Value>(item: SelectOption<Value>): TuiDialogSelectOption<Value> {
  return {
    title: item.title,
    value: item.value,
    description: item.description,
    footer: item.footer,
    category: item.category,
    disabled: item.disabled,
  }
}

function mapOptionCb<Value>(cb?: (item: TuiDialogSelectOption<Value>) => void) {
  if (!cb) return
  return (item: SelectOption<Value>) => cb(pickOption(item))
}

function stateApi(sync: ReturnType<typeof useSessionState>): TuiPluginApi["state"] {
  return {
    get ready() {
      return sync.ready
    },
    get config() {
      return sync.data.config
    },
    get provider() {
      return sync.data.provider
    },
    get path() {
      return sync.path
    },
    get vcs() {
      if (!sync.data.vcs) return
      return {
        branch: sync.data.vcs.branch,
        default_branch: sync.data.vcs.default_branch,
      }
    },
    session: {
      count() {
        return sync.data.session.length
      },
      get(sessionID) {
        return sync.session.get(sessionID)
      },
      diff(sessionID) {
        return (sync.data.session_diff[sessionID] ?? []).flatMap((item) =>
          item.file === undefined ? [] : [{ ...item, file: item.file }],
        )
      },
      todo(sessionID) {
        return sync.data.todo[sessionID] ?? []
      },
      messages(sessionID) {
        return sync.data.message[sessionID] ?? []
      },
      status(sessionID) {
        return sync.data.session_status[sessionID]
      },
      permission(sessionID) {
        return sync.data.permission[sessionID] ?? []
      },
      question(sessionID) {
        return sync.data.question[sessionID] ?? []
      },
    },
    part(messageID) {
      return sync.data.part[messageID] ?? []
    },
    mcp() {
      return Object.entries(sync.data.mcp)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          status: item.status,
          error: item.status === "failed" ? item.error : undefined,
        }))
    },
  }
}

function appApi(version: string): TuiPluginApi["app"] {
  return {
    get version() {
      return version
    },
  }
}

export function createTuiApiAdapters(input: Input): Omit<TuiPluginApi, "lifecycle"> {
  return {
    app: appApi(input.version),
    attention: input.attention,
    // Keep deprecated `api.command` working for v1 plugins; remove in v2.
    command: createCommandShim(input.keymap, input.dialog, input.tuiConfig.keybinds),
    keys: {
      formatSequence(parts) {
        return Keymap.formatKeySequence(parts, input.tuiConfig)
      },
      formatBindings(bindings) {
        return Keymap.formatKeyBindings(bindings, input.tuiConfig)
      },
    },
    keymap: input.keymap,
    mode: {
      current() {
        return Keymap.getPHINsModeStack(input.keymap).current()
      },
      push(mode) {
        return Keymap.getPHINsModeStack(input.keymap).push(mode)
      },
    },
    route: {
      register(list) {
        return input.routes.register(list)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {
      Dialog(props) {
        return (
          <DialogUI size={props.size} onClose={props.onClose}>
            {props.children}
          </DialogUI>
        )
      },
      DialogAlert(props) {
        return <DialogAlert {...props} />
      },
      DialogConfirm(props) {
        return <DialogConfirm {...props} />
      },
      DialogPrompt(props) {
        return <DialogPrompt {...props} description={props.description} />
      },
      DialogSelect(props) {
        return (
          <DialogSelect
            title={props.title}
            placeholder={props.placeholder}
            options={props.options.map(mapOption)}
            flat={props.flat}
            onMove={mapOptionCb(props.onMove)}
            onFilter={props.onFilter}
            onSelect={mapOptionCb(props.onSelect)}
            skipFilter={props.skipFilter}
            current={props.current}
          />
        )
      },
      Slot<Name extends string>(props: TuiSlotProps<Name>) {
        return <input.Slot {...props} />
      },
      Prompt(props) {
        return (
          <Prompt
            sessionID={props.sessionID}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.onSubmit}
            ref={props.ref}
            hint={props.hint}
            right={props.right}
            showPlaceholder={props.showPlaceholder}
            placeholders={props.placeholders}
          />
        )
      },
      toast(inputToast) {
        input.toast.show({
          title: inputToast.title,
          message: inputToast.message,
          variant: inputToast.variant ?? "info",
          duration: inputToast.duration,
        })
      },
      dialog: {
        replace(render, onClose) {
          input.dialog.replace(render, onClose)
        },
        clear() {
          input.dialog.clear()
        },
        setSize(size) {
          input.dialog.setSize(size)
        },
        get size() {
          return input.dialog.size === "model" ? "large" : input.dialog.size
        },
        get depth() {
          return input.dialog.stack.length
        },
        get open() {
          return input.dialog.stack.length > 0
        },
      },
    },
    get tuiConfig() {
      return input.tuiConfig
    },
    kv: {
      get(key, fallback) {
        return input.kv.get(key, fallback)
      },
      set(key, value) {
        input.kv.set(key, value)
      },
      get ready() {
        return input.kv.ready
      },
    },
    state: stateApi(input.sync),
    get client() {
      return input.sdk.client
    },
    event: input.event,
    renderer: input.renderer,
    slots: {
      register() {
        throw new Error("slots.register is only available in plugin context")
      },
    },
    plugins: {
      list() {
        return []
      },
      async activate() {
        return false
      },
      async deactivate() {
        return false
      },
      async add() {
        return false
      },
      async install() {
        return {
          ok: false,
          message: "plugins.install is only available in plugin context",
        }
      },
    },
    theme: {
      get current() {
        return input.theme.theme
      },
      get selected() {
        return input.theme.selected
      },
      has(name) {
        return input.theme.has(name)
      },
      set(name) {
        return input.theme.set(name)
      },
      async install(_jsonPath) {
        throw new Error("theme.install is only available in plugin context")
      },
      mode() {
        return input.theme.mode()
      },
      get ready() {
        return input.theme.ready
      },
    },
  }
}
