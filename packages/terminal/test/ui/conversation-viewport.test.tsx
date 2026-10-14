/** @jsxImportSource @opentui/solid */
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { type ScrollBoxRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ConversationViewport } from "../../src/tui/components/conversation-viewport"
import { TuiConfigProvider } from "../../src/tui/config/settings"
import { PHINsKeymapProvider, registerPHINsKeymap } from "../../src/tui/state/keymap"
import { KVProvider } from "../../src/tui/state/kv"
import { ThemeProvider } from "../../src/tui/theme/provider"
import { tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("feed follows new output, preserves manual reading and clears its banner when history fits", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state)
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [lines, setLines] = createSignal(40)
  let feed: ScrollBoxRenderable
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerPHINsKeymap(keymap, renderer, config))
    return <TestTuiContexts paths={{ home: tmp.path, state }}>
      <PHINsKeymapProvider keymap={keymap}><TuiConfigProvider config={config}>
        <KVProvider><ThemeProvider mode="dark">
          <box height="100%">
            <ConversationViewport ref={(value) => { feed = value }}>
              <text>{Array.from({ length: lines() }, (_, n) => `History line ${n}`).join("\n")}</text>
            </ConversationViewport>
            <text>COMPOSER</text>
          </box>
        </ThemeProvider></KVProvider>
      </TuiConfigProvider></PHINsKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  async function frame(matches: (text: string) => boolean) {
    for (let n = 0; n < 100; n++) {
      await app.renderOnce()
      const text = app.captureCharFrame()
      if (matches(text)) return text
      await Bun.sleep(5)
    }
    throw new Error(JSON.stringify({ top: feed!.scrollTop, height: feed!.scrollHeight,
      viewport: feed!.viewport.height, content: feed!.content.height }) + "\n" + app.captureCharFrame())
  }
  try {
    await frame((text) => text.includes("History line 39"))
    setLines(45)
    await frame((text) => text.includes("History line 44"))
    feed!.scrollTo(0)
    await frame((text) => text.includes("Back to latest"))
    setLines(50)
    await frame((text) => text.includes("History line 0"))
    expect(feed!.scrollTop).toBe(0)
    setLines(2)
    await frame((text) => text.includes("History line 1") && !text.includes("Back to latest"))
    setLines(30)
    await frame(() => feed!.scrollHeight === 30)
    feed!.scrollTo(0)
    await frame((text) => text.includes("Back to latest"))
    app.resize(80, 40)
    await frame((text) => text.includes("History line 29") && !text.includes("Back to latest"))
    expect(app.captureCharFrame()).toContain("COMPOSER")
  } finally { app.renderer.destroy() }
})
