/** @jsxImportSource @opentui/solid */
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ModelSelect, modelGroup, type ModelSelectProps } from "../../../../src/tui/components/model-select"
import { Dialog } from "../../../../src/tui/components/dialog"
import { TuiConfigProvider } from "../../../../src/tui/config/settings"
import type { TuiKeybind } from "../../../../src/tui/config/keybindings"
import { PHINsKeymapProvider, registerPHINsKeymap } from "../../../../src/tui/state/keymap"
import { KVProvider } from "../../../../src/tui/state/kv"
import { ThemeProvider } from "../../../../src/tui/theme/provider"
import type { ModelChoice } from "../../../../src/shared/model-info"
import type { SelectedModel } from "../../../../src/shared/provider-setup"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Rendering data only; no claims about a live provider's current inventory.
const ids = ["MiniMaxAI/MiniMax-M3", "nvidia/nemotron-3-super", "nvidia/nemotron-3-nano", "nvidia/nemotron-ultra",
  "Qwen/Qwen-Next-80B", "Qwen/Qwen3-Coder", "Qwen/Qwen3-32B", "deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V3",
  "moonshotai/Kimi-K2.6", "moonshotai/Kimi-K2", "openai/gpt-oss-120b", "openbmb/MiniCPM", "z-ai/GLM", "google/Gemma"]
const options: ModelChoice[] = ids.map((id) => ({
  value: { providerID: "nebius", modelID: id }, title: id, providerName: "Nebius Token Factory",
  supportsTools: true,
}))

async function mount(root: string, props: Partial<ModelSelectProps> = {}, config: {
  width?: number; height?: number; mode?: "dark" | "light"; kitty?: boolean; keybinds?: Partial<TuiKeybind.Keybinds>
} = {}) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const selected: SelectedModel[] = []
  let cancelled = 0
  const [choices, setChoices] = createSignal(props.options ?? options)
  const favorites: SelectedModel[] = []
  const initial = { current: options[1]!.value, onSelect: (value: SelectedModel) => { selected.push(value) },
    onCancel: () => { cancelled++ }, onFavorite: (value: SelectedModel) => {
      favorites.push(value)
      setChoices((list) => list.map((item) => item.value.modelID === value.modelID
        ? { ...item, favorite: !item.favorite } : item))
    }, ...props }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolved = createTuiResolvedConfig({ keybinds: config.keybinds })
    const off = registerPHINsKeymap(keymap, renderer, resolved)
    onCleanup(off)
    return <TestTuiContexts paths={{ home: root, state }}>
      <PHINsKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolved}>
          <KVProvider><ThemeProvider mode={config.mode ?? "dark"}>
            <Dialog size="model" onClose={() => { cancelled++ }}>
              <ModelSelect {...initial} options={choices()} />
            </Dialog>
          </ThemeProvider></KVProvider>
        </TuiConfigProvider>
      </PHINsKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, {
    width: config.width ?? 120, height: config.height ?? 44, kittyKeyboard: config.kitty ?? true,
  })
  async function frame(needle = "Select model") {
    for (let i = 0; i < 100; i++) {
      await app.renderOnce()
      if (app.captureCharFrame().includes(needle) && app.renderer.currentFocusedRenderable?.id === "model-search") {
        await Bun.sleep(5)
        await app.renderOnce()
        return app.captureCharFrame()
      }
      await Bun.sleep(10)
    }
    throw new Error(`Missing ${needle}:\n${app.captureCharFrame()}`)
  }
  return { ...app, frame, selected, favorites, setChoices, cancelled: () => cancelled }
}

async function capture(app: Awaited<ReturnType<typeof mount>>, name: string) {
  const output = process.env.PHINS_MODEL_SELECT_CAPTURE
  if (!output) return
  await mkdir(output, { recursive: true })
  const frame = app.captureSpans()
  const color = (value: { r: number; g: number; b: number; a: number }) => [value.r, value.g, value.b, value.a]
  const cursor = app.renderer.getCursorState()
  await writeFile(path.join(output, `${name}.json`), JSON.stringify({
    ...frame, cursor: { ...cursor, color: color(cursor.color) },
    lines: frame.lines.map((line) => ({ ...line, spans: line.spans.map((span) => ({
      ...span, fg: color(span.fg), bg: color(span.bg),
    })) })),
  }))
  await writeFile(path.join(output, `${name}.txt`), app.captureCharFrame())
}

for (const [width, height, mode, kitty] of [
  [120, 44, "dark", true], [120, 44, "light", true], [80, 24, "dark", false], [40, 24, "dark", true],
] as const) {
  test(`model dialog fits ${width}x${height} ${mode} and keeps its input cursor in the field`, async () => {
    await using tmp = await tmpdir()
    const app = await mount(tmp.path, {}, { width, height, mode, kitty })
    try {
      const frame = await app.frame()
      const panel = app.renderer.root.findDescendantById("model-select")!
      expect(panel.x).toBeGreaterThanOrEqual(0)
      expect(panel.y).toBeGreaterThanOrEqual(0)
      expect(panel.x + panel.width).toBeLessThanOrEqual(width)
      expect(panel.y + panel.height).toBeLessThanOrEqual(height)
      expect(frame).toContain("Select")
      expect(frame).toContain("Search")
      expect(frame).toContain("Navigate")
      expect(frame).toContain("> ●")
      expect(frame).toContain("Nemotron · Nebius")
      const cursor = app.renderer.getCursorState()
      const input = app.renderer.root.findDescendantById("model-search")!
      expect(cursor.visible).toBe(true)
      expect(cursor.x - 1).toBe(input.x)
      expect(cursor.y - 1).toBe(input.y)
      await capture(app, `models-${width}x${height}-${mode}`)
      // Secondary models stay discoverable through their collapsed group.
      app.mockInput.pressKey("END")
      app.mockInput.pressEnter()
      await app.frame("MiniMaxAI")
      app.mockInput.pressKey("END")
      await app.frame("Gemma")
      app.mockInput.pressEnter()
      expect(app.selected).toEqual([options.at(-1)!.value])
      app.mockInput.pressKey("HOME")
      await app.frame("Nemotron · Nebius")
    } finally { app.renderer.destroy() }
  })
}

test("search filters counts, preserves provider IDs and accepts namespace slashes", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await app.frame()
    await app.mockInput.typeText("nvidia/")
    let frame = await app.frame("nvidia/")
    expect(frame).toContain("[3]")
    expect(frame).not.toContain("Kimi-K2")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    expect(app.selected).toEqual([options[2]!.value])
    await app.mockInput.typeText("does-not-exist")
    frame = await app.frame("No models match")
    app.mockInput.pressEnter()
    expect(app.selected).toHaveLength(1)
    await capture(app, "models-empty")
    app.mockInput.pressEscape()
    expect(app.cancelled()).toBe(1)
  } finally { app.renderer.destroy() }
})

test("groups reopen by keyboard, favorites keep focus and metadata refresh preserves selection", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await app.frame()
    app.mockInput.pressArrow("left")
    let frame = await app.frame()
    expect(frame).not.toContain("nvidia/nemotron")
    expect(frame).toContain("▸ NVIDIA")
    await capture(app, "models-collapsed")
    app.mockInput.pressArrow("right")
    await app.frame("nvidia/nemotron-3-super")
    app.mockInput.pressKey("f", { ctrl: true })
    await app.frame("★")
    expect(app.favorites).toEqual([options[1]!.value])
    app.setChoices((list) => [...list, { title: "New API model", providerName: "Nebius Token Factory",
      value: { providerID: "nebius", modelID: "new-model" } }])
    await app.frame()
    app.mockInput.pressEnter()
    expect(app.selected).toEqual([options[1]!.value])
    app.mockInput.pressKey("c", { ctrl: true })
    expect(app.cancelled()).toBe(1)
  } finally { app.renderer.destroy() }
})

test("setup highlights recommended model independently of current and respects submit rebinding", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path, { current: options[0]!.value, initial: options[1]!.value,
    subtitle: "Default model (API key saved locally)", onFavorite: undefined,
    options: [ { ...options[1]!, recommended: true }, options[0]!, options[2]! ] },
  { keybinds: { "dialog.select.submit": "ctrl+y" } })
  try {
    await app.frame("(recommended)")
    await capture(app, "setup-models")
    app.mockInput.pressEnter()
    expect(app.selected).toHaveLength(0)
    app.mockInput.pressKey("y", { ctrl: true })
    expect(app.selected).toEqual([options[1]!.value])
  } finally { app.renderer.destroy() }
})

test("mouse group toggles retain search focus and resizing reveals the selected model", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await app.frame()
    const header = () => app.renderer.root.findDescendantById(`model-group-${modelGroup(options[1]!).id}`)!
    await app.mockMouse.click(header().x + 3, header().y)
    expect(await app.frame()).not.toContain("nvidia/nemotron")
    await app.mockMouse.click(header().x + 3, header().y)
    await app.frame("nvidia/nemotron-3-super")
    app.mockInput.pressKey("END")
    app.mockInput.pressEnter()
    await app.frame("MiniMaxAI")
    app.mockInput.pressKey("END")
    await app.frame("google/Gemma")
    app.resize(40, 24)
    await app.frame("google/Gemma")
    const panel = app.renderer.root.findDescendantById("model-select")!
    expect(panel.y).toBeGreaterThanOrEqual(0)
    expect(panel.y + panel.height).toBeLessThanOrEqual(24)
    app.mockInput.pressEnter()
    expect(app.selected).toEqual([options.at(-1)!.value])
  } finally { app.renderer.destroy() }
})

test("model grouping does not invent providers or merge the same maker across providers", () => {
  expect(modelGroup(options[1]!).title).toBe("NVIDIA Nemotron · Nebius")
  const custom = { ...options[1]!, value: { providerID: "private", modelID: "custom-model" }, providerName: "Private provider" }
  expect(modelGroup(custom).title).toBe("Private provider")
  expect(modelGroup({ ...options[1]!, value: { ...options[1]!.value, providerID: "other" } }).id)
    .not.toBe(modelGroup(options[1]!).id)
})

test("Nebius NVIDIA groups lead; other providers and favorites remain reachable without duplicates", async () => {
  await using tmp = await tmpdir()
  const external: ModelChoice = { title: "NVIDIA Nemotron (provider fixture)", providerName: "Other provider",
    value: { providerID: "other", modelID: "nvidia/nemotron-fixture" }, supportsTools: true, favorite: true }
  const otherNvidia: ModelChoice = { ...options[1]!, title: "NVIDIA alternate (fixture)",
    value: { providerID: "nebius", modelID: "nvidia/alternate-fixture" } }
  const app = await mount(tmp.path, { options: [external, { ...options[0]!, favorite: true }, ...options.slice(1), otherNvidia] })
  try {
    const frame = await app.frame()
    const labels = ["NVIDIA Nemotron · Nebius", "Other NVIDIA · Nebius", "Other models · Nebius", "Other provider"]
    expect(labels.map((label) => frame.indexOf(label))).toEqual(labels.map((label) => frame.indexOf(label)).toSorted((a, b) => a - b))
    for (const label of labels) expect(frame).toContain(label)
    expect(frame).toContain("▸ Other models · Nebius")
    expect(frame).toContain("▸ Other provider")
    expect(frame).not.toContain("MiniMaxAI/MiniMax-M3")
    expect(frame).not.toContain("Favorites")
    expect(frame).not.toContain("Recent")
    await capture(app, "priority-groups")
    await app.mockInput.typeText("Other provider")
    const filtered = await app.frame("NVIDIA Nemotron (provider fixture)")
    expect(filtered).toContain("★")
    expect(filtered).not.toContain("(recommended)")
    app.mockInput.pressEnter()
    expect(app.selected).toEqual([external.value])
  } finally { app.renderer.destroy() }
})

test("an existing non-NVIDIA model remains current and its group opens automatically", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path, { current: options[0]!.value })
  try {
    const frame = await app.frame("MiniMaxAI")
    expect(frame).toContain("▾ Other models · Nebius")
    expect(frame).toContain("> ● MiniMaxAI/MiniMax-M3")
    app.mockInput.pressEnter()
    expect(app.selected).toEqual([options[0]!.value])
  } finally { app.renderer.destroy() }
})
