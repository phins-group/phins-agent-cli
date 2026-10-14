import { createCliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { Deferred, Effect } from "effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import type { ProviderSetupPrompts, SelectedModel } from "../../shared/provider-setup"
import { Dialog } from "../components/dialog"
import { ModelSelect } from "../components/model-select"
import { resolve, TuiConfigProvider } from "../config/settings"
import { TuiPathsProvider, TuiTerminalEnvironmentProvider } from "../state/environment"
import { PHINsKeymapProvider, registerPHINsKeymap } from "../state/keymap"
import { KVProvider } from "../state/kv"
import { ThemeProvider } from "../theme/provider"
import { destroyRenderer } from "../platform/renderer"
import { win32DisableProcessedInput } from "../platform/windows"

/** Briefly owns the terminal after the CLI password prompt has released it. */
export const promptSetupModel: ProviderSetupPrompts<never>["model"] = (options) => Effect.scoped(
  Effect.gen(function* () {
    const result = yield* Deferred.make<SelectedModel, Error>()
    const cancel = () => Deferred.doneUnsafe(result, Effect.fail(new Error("Model selection cancelled. The saved API key is retained.")))
    const renderer = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createCliRenderer({
        screenMode: "alternate-screen", externalOutputMode: "passthrough",
        exitOnCtrlC: false, autoFocus: false, openConsoleOnError: false, useKittyKeyboard: {},
      })),
      (value) => Effect.sync(() => destroyRenderer(value)),
    )
    win32DisableProcessedInput()
    renderer.once("destroy", cancel)
    const config = resolve({})
    const keymap = createDefaultOpenTuiKeymap(renderer)
    yield* Effect.acquireRelease(
      Effect.sync(() => registerPHINsKeymap(keymap, renderer, config)),
      (off) => Effect.sync(off),
    )
    yield* Effect.tryPromise(() => render(() => (
      <TuiPathsProvider value={{ cwd: process.cwd(), home: AppPaths.directories.home,
        state: AppPaths.directories.state, worktree: AppPaths.directories.data + "/worktree" }}>
        <TuiTerminalEnvironmentProvider value={{ platform: process.platform }}>
          <PHINsKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <Dialog size="model" onClose={cancel}>
                    <ModelSelect options={options.choices} subtitle={options.message}
                      initial={options.choices[0]?.value} onCancel={cancel}
                      onSelect={(model) => Deferred.doneUnsafe(result, Effect.succeed(model))} />
                  </Dialog>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </PHINsKeymapProvider>
        </TuiTerminalEnvironmentProvider>
      </TuiPathsProvider>
    ), renderer))
    return yield* Deferred.await(result)
  }),
)
