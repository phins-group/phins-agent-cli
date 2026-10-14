/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProviderKeyInput } from "../../../../src/tui/dialogs/provider-setup"
import { TuiConfigProvider } from "../../../../src/tui/config/settings"
import { KVProvider } from "../../../../src/tui/state/kv"
import { ThemeProvider } from "../../../../src/tui/theme/provider"
import { Dialog } from "../../../../src/tui/components/dialog"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

for (const [mode, kittyKeyboard] of [["dark", false], ["dark", true], ["light", false]] as const) {
  test(`provider key keeps focus and masking (${mode}, kitty=${kittyKeyboard})`, async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state)
    await Bun.write(path.join(state, "kv.json"), "{}")
    const values: string[] = []
    const secret = "synthetic-api-key-for-render-test"
    const app = await testRender(() => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode={mode}>
              <Dialog size="large" onClose={() => {}}>
                <ProviderKeyInput options={{
                  message: "Nebius API key",
                  validate: (value) => value.trim() ? Effect.succeed(value.trim()) : Effect.fail("Required"),
                }} onSubmit={(key) => values.push(key)} />
              </Dialog>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ), { width: 120, height: 32, kittyKeyboard })
    async function waitForFrame(matches: (frame: string) => boolean) {
      let frame = ""
      for (let i = 0; i < 100; i++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (matches(frame)) return frame
        await Bun.sleep(10)
      }
      throw new Error(`Frame did not match:\n${frame}`)
    }
    function expectCursorAt(text: string, offset = 0) {
      const lines = app.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const cursor = app.renderer.getCursorState()
      expect(cursor.visible).toBe(true)
      // Terminal cursor coordinates are 1-based; frame cells are 0-based.
      expect(cursor.x - 1).toBe(lines[row]!.indexOf(text) + offset)
      expect(cursor.y - 1).toBe(row)
    }
    async function capture(name: string) {
      const output = process.env.PHINS_KEY_INPUT_CAPTURE
      if (!output) return
      await mkdir(output, { recursive: true })
      const frame = app.captureSpans()
      const color = (c: { r: number; g: number; b: number; a: number }) => [c.r, c.g, c.b, c.a]
      const cursor = app.renderer.getCursorState()
      await writeFile(`${output}/${name}-${mode}-${kittyKeyboard}.json`, JSON.stringify({
        ...frame, cursor: { ...cursor, color: color(cursor.color) },
        lines: frame.lines.map((line) => ({ ...line, spans: line.spans.map((span) => ({
          ...span, fg: color(span.fg), bg: color(span.bg),
        })) })),
      }))
    }
    try {
      await waitForFrame((frame) => frame.includes("Type or paste API key"))
      const field = app.renderer.root.findDescendantById("provider-api-key")!
      const emptyCursor = app.renderer.getCursorState()
      expect(field.focused).toBe(true)
      expect(emptyCursor.visible).toBe(true)
      expect(emptyCursor.style).toBe("block")
      expect(emptyCursor.x).toBeGreaterThan(field.x)
      await capture("empty")
      expectCursorAt("Type or paste API key")
      field.blur()
      await app.renderOnce()
      expect(app.renderer.getCursorState().visible).toBe(false)
      await app.mockMouse.click(field.x + 2, field.y + 1)
      await app.renderOnce()
      expect(field.focused).toBe(true)
      expect(app.renderer.getCursorState().visible).toBe(true)
      expectCursorAt("Type or paste API key")
      app.mockInput.pressEnter()
      await waitForFrame((frame) => frame.includes("Enter a non-empty"))
      expect(values).toEqual([])
      expectCursorAt("Type or paste API key")

      await app.mockInput.typeText(secret)
      let frame = await waitForFrame((frame) => frame.includes("*".repeat(secret.length)))
      expect(frame).not.toContain(secret)
      expect(frame).not.toContain("synthetic")
      expect(app.renderer.getCursorState().x).toBe(emptyCursor.x + secret.length)
      expectCursorAt("*".repeat(secret.length), secret.length)
      await capture("masked")
      app.resize(40, 20)
      await app.renderOnce()
      const narrowCursor = app.renderer.getCursorState()
      const maskedRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("***"))
      expect(narrowCursor.y - 1).toBe(maskedRow)
      expect(narrowCursor.x - 1).toBeGreaterThan(field.x)
      expect(narrowCursor.x - 1).toBeLessThan(field.x + field.width - 1)
      await capture("narrow")
      app.resize(120, 32)
      await app.renderOnce()
      expectCursorAt("*".repeat(secret.length), secret.length)
      app.mockInput.pressKey("u", { ctrl: true })
      await waitForFrame((frame) => frame.includes("Type or paste API key"))
      expect(app.renderer.getCursorState().x).toBe(emptyCursor.x)
      expectCursorAt("Type or paste API key")

      await app.mockInput.pasteBracketedText("broken\nkey")
      await waitForFrame((frame) => frame.includes("Enter a single-line API key"))
      expect(values).toEqual([])
      await app.mockInput.pasteBracketedText(` ${secret}x\n`)
      app.mockInput.pressBackspace()
      frame = await waitForFrame((frame) => frame.includes("*".repeat(secret.length)))
      expect(frame).not.toContain(secret)
      expect(frame).not.toContain("synthetic")
      app.mockInput.pressEnter()
      expect(values).toEqual([secret])
      await waitForFrame((frame) => frame.includes("Type or paste API key"))
      app.mockInput.pressEnter()
      expect(values).toEqual([secret])
    } finally {
      app.renderer.destroy()
    }
  })
}
