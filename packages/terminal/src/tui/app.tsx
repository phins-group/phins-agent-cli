/**
 * Root runtime và application shell của PHINs TUI.
 *
 * Tạo renderer/keymap, mount provider graph, start plugin host,
 * dispatch command theo route và dispose mọi terminal/plugin resource khi thoát.
 * @module
 */
import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import { Flag } from "@phins/engine/runtime/flags"
import { InstallationVersion } from "@phins/engine/runtime/version"

import { ClipboardProvider, useClipboard } from "./state/clipboard"
import { EpilogueProvider, ExitProvider, useExit } from "./state/lifecycle"
import * as Selection from "./platform/selection"
import { MouseButton } from "@opentui/core"
import { NavigationProvider, useNavigation } from "./state/navigation"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
} from "solid-js"
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  useTuiStartup,
} from "./state/environment"
import { DialogProvider, useDialog } from "./components/dialog"
import { ErrorComponent } from "./components/error-screen"
import { PluginRouteMissing } from "./components/missing-route"
import { ProjectProvider, useProject } from "./state/project"
import { EditorContextProvider } from "./state/editor"
import { useEvent } from "./state/event"
import { AgentClientProvider, useAgentClient } from "./state/agent-client"
import { StartupLoading } from "./components/startup-loading"
import { SessionStateProvider, useSessionState } from "./state/sessions"
import { DataProvider } from "./state/location-data"
import { LocationProvider } from "./state/location"
import { PreferencesProvider, usePreferences } from "./state/preferences"
import { ModelPickerDialog } from "./dialogs/model-picker"
import { ProviderSetupDialog } from "./dialogs/provider-setup"
import { HelpDialog } from "./dialogs/help"
import { SessionPickerDialog } from "./dialogs/session-picker"

import { ThemeProvider, useTheme } from "./theme/provider"
import { Home } from "./screens/home/view"
import { HomeSessionDestinationProvider } from "./screens/home/destination"
import { Session } from "./screens/session/view"
import { PromptHistoryProvider } from "./composer/history"
import { FileRankingProvider } from "./composer/file-ranking"
import { PromptStashProvider } from "./composer/stash"
import { DialogAlert } from "./components/dialog-alert"
import { DialogConfirm } from "./components/dialog-confirm"
import { ToastProvider, useToast } from "./components/toast"
import { isDefaultTitle } from "@phins/engine/sessions/title"
import { KVProvider, useKV } from "./state/kv"
import * as Model from "../shared/model-info"
import { ArgsProvider, useArgs, type Args } from "./state/launch-args"
import { PromptRefProvider, usePromptRef } from "./composer/controller"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config/settings"
import { createTuiApiAdapters } from "./extensions/bridge"
import { createTuiApi } from "./extensions/routes"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./extensions/provider"
import { CommandPaletteDialog } from "./components/command-menu"
import {
  COMMAND_PALETTE_COMMAND,
  PHINS_BASE_MODE,
  PHINsKeymapProvider,
  registerPHINsKeymap,
  useBindings,
  usePHINsKeymap,
} from "./state/keymap"

import type { EventSource } from "./state/agent-client"
import { createTuiAttention } from "./platform/attention"
import * as TuiAudio from "./platform/sound"
import { win32FlushInputBuffer, win32WriteConsole } from "./platform/windows"
import { destroyRenderer, openTerminalRenderer } from "./platform/renderer"
import { cliErrorMessage, errorFormat } from "../shared/errors"

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show", "model.list", "agent.cycle",
  "agent.cycle.reverse", "provider.connect", "help.show",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2)
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference) return difference > 0
  }
  if (a.prerelease === b.prerelease) return false
  if (!a.prerelease) return true
  if (!b.prerelease) return false
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) > 0
}

/** Sở hữu renderer scope và trả quyền điều khiển khi terminal bị destroy. */
export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* AppPaths.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* openTerminalRenderer(!Flag.PHINS_DISABLE_MOUSE && input.config.mouse)
      // H5/6: đăng ký keymap trước khi mount component để command luôn reachable.
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerPHINsKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      let finalOutput: { epilogue?: string; reason?: unknown } = {}
      // OpenTUI emits before its native cleanup finishes. Resume after that stack
      // returns so scope finalizers and the epilogue cannot touch closing handles.
      renderer.once("destroy", () => {
        finalOutput = { epilogue: exit.epilogue, reason: exit.reason }
        queueMicrotask(() => Deferred.doneUnsafe(shutdown, Effect.void))
      })
      const pluginRuntime = createPluginRuntime()

      yield* Effect.tryPromise(async () => {
        // Prewarm palette trước ThemeProvider để theme `system` không chớp màu
        // fallback ở frame đầu.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.PHINS_ROUTE ? JSON.parse(process.env.PHINS_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.PHINS_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <PHINsKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <NavigationProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <PluginRuntimeProvider value={pluginRuntime}>
                                        <AgentClientProvider
                                          url={input.url}
                                          directory={input.directory}
                                          fetch={input.fetch}
                                          headers={input.headers}
                                          events={input.events}
                                        >
                                          <ProjectProvider>
                                            <SessionStateProvider>
                                              <DataProvider>
                                                <ThemeProvider mode={mode}>
                                                  <PreferencesProvider>
                                                    <PromptStashProvider>
                                                      <DialogProvider>
                                                        <FileRankingProvider>
                                                          <PromptHistoryProvider>
                                                            <PromptRefProvider>
                                                              <EditorContextProvider>
                                                                <LocationProvider>
                                                                  <App
                                                                    pluginHost={input.pluginHost}
                                                                  />
                                                                </LocationProvider>
                                                              </EditorContextProvider>
                                                            </PromptRefProvider>
                                                          </PromptHistoryProvider>
                                                        </FileRankingProvider>
                                                      </DialogProvider>
                                                    </PromptStashProvider>
                                                  </PreferencesProvider>
                                                </ThemeProvider>
                                              </DataProvider>
                                            </SessionStateProvider>
                                          </ProjectProvider>
                                        </AgentClientProvider>
                                      </PluginRuntimeProvider>
                                    </TuiConfigProvider>
                                  </NavigationProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </PHINsKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return finalOutput
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined)
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
    if (result.epilogue) {
      const reset = "\x1b[?1049l\x1b[?25h\x1b[0m\x1b[2J\x1b[H"
      if (!win32WriteConsole(reset)) process.stdout.write(reset)
    }
  })
  const epilogue = result.epilogue
  if (epilogue) {
    yield* Effect.promise(() => sleep(1_000))
    yield* Effect.sync(() => {
      if (!win32WriteConsole(epilogue + "\n")) process.stdout.write(epilogue + "\n")
    })
    yield* Effect.promise(() => sleep(1_500))
  }
})

/** Root component nối SDK/event state, command adapters, routes và plugin API. */
function App(props: { pluginHost: TuiPluginHost }) {
  const startup = useTuiStartup()
  const tuiConfig = useTuiConfig()
  const route = useNavigation()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = usePreferences()
  const kv = useKV()
  const keymap = usePHINsKeymap()
  const event = useEvent()
  const sdk = useAgentClient()
  const toast = useToast()
  const themeState = useTheme()
  const { theme } = themeState
  const sync = useSessionState()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  // H6/6: plugin chỉ start sau khi API adapters và reactive runtime đã tồn tại.
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const terminalTitleEnabled = () => kv.get("terminal_title_enabled", true)

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (renderer.isDestroyed) return
    if (!terminalTitleEnabled() || Flag.PHINS_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "session") {
      const session = route.data.sessionID ? sync.session.get(route.data.sessionID) : undefined
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("PHINs Agent")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`PHINs Agent | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`PHINs Agent | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parseModelReference(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  const appCommands = createMemo(() => [
    {
      name: COMMAND_PALETTE_COMMAND,
      title: "Show command palette",
      hidden: true,
      run: () => dialog.replace(() => <CommandPaletteDialog />),
    },
    {
      name: "model.list",
      title: "Switch model",
      category: "Agent",
      slashName: "models",
      run: () => dialog.replace(() => <ModelPickerDialog />),
    },
    {
      name: "session.new",
      title: "New session",
      category: "Session",
      slashName: "new",
      run: () => {
        route.navigate({ type: "session" })
        dialog.clear()
      },
    },
    {
      name: "session.list",
      title: "Switch session",
      category: "Session",
      slashName: "sessions",
      run: () => dialog.replace(() => <SessionPickerDialog />),
    },
    {
      name: "provider.connect",
      title: "Set API key and model",
      category: "Provider",
      slashName: "setup",
      run: () => dialog.replace(() => <ProviderSetupDialog />),
    },
    {
      name: "help.show",
      title: "Help",
      category: "System",
      slashName: "help",
      run: () => dialog.replace(() => <HelpDialog onSelectSkill={(name) => {
        const prompt = promptRef.current
        if (!prompt) return
        const draft = prompt.current
        // Append so existing attachment offsets still refer to the same text.
        prompt.set({ ...draft, input: [draft.input, `Use the ${name} skill.`].filter(Boolean).join("\n") })
      }} />),
    },
    {
      name: "app.exit",
      title: "Exit the app",
      category: "System",
      slashName: "exit",
      run: () => exit(),
    },
    // Navigation shortcuts are internal actions, not extra palette commands.
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `session.quick_switch.${i + 1}`,
      title: `Switch to session in quick slot ${i + 1}`,
      hidden: true,
      run: () => local.session.quickSwitch(i + 1),
    })),
    {
      name: "agent.cycle",
      title: "Next agent",
      hidden: true,
      run: () => local.agent.move(1),
    },
    {
      name: "agent.cycle.reverse",
      title: "Previous agent",
      hidden: true,
      run: () => local.agent.move(-1),
    },
  ].map((command) => ({ namespace: "palette", ...command })))

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: PHINS_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: PHINS_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "session" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !isVersionGreater(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. Would you like to update now?`,
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: `Updating to v${version}...`,
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: "Update Failed",
        message: "Update failed",
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to PHINs v${result.data.version}. Please restart the application.`,
    )

    void exit()
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.PHINS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={Flag.PHINS_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show
                when={route.data.type === "session" && route.data.sessionID}
                fallback={
                  <HomeSessionDestinationProvider>
                    <Session />
                  </HomeSessionDestinationProvider>
                }
              >
                <Session />
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={ready} />
      </Show>
    </box>
  )
}
