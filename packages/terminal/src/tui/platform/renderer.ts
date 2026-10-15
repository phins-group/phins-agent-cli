import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { Effect } from "effect"
import { win32DisableProcessedInput } from "./windows"

/** Own the terminal resource; callers own the application mounted inside it. */
export const openTerminalRenderer = Effect.fn("Terminal.open")(function* (mouse: boolean) {
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise(() => createCliRenderer({
      externalOutputMode: "passthrough",
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
      useMouse: mouse,
      consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] },
    })),
    (value) => Effect.sync(() => destroyRenderer(value)),
  )
  win32DisableProcessedInput()
  const onHangup = () => destroyRenderer(renderer)
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("SIGHUP", onHangup)),
    () => Effect.sync(() => process.off("SIGHUP", onHangup)),
  )
  return renderer
})

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  if (renderer.isDestroyed) return
  try {
    renderer.setTerminalTitle("")
  } finally {
    renderer.destroy()
  }
}
