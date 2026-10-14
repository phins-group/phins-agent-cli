import { expect, mock, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { createTestRenderer } from "@opentui/core/testing"
import { MarkdownRenderable, ScrollBoxRenderable, type BaseRenderable } from "@opentui/core"
import { Effect } from "effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import { compactionText } from "@phins/engine/sessions/run/messages"
import type { AssistantMessage, ToolPart } from "@phins/engine/transport/client/create"
import type { TuiPluginApi } from "../../src/tui/extensions/contracts"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

// Local rendering fixture only. These messages are never used by the product
// or offered as model-inference / benchmark evidence.
test("agent layout keeps the conversation, draft and controls visible on resize", async () => {
  const setup = await createTestRenderer({ width: 160, height: 48, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const time = Date.UTC(2026, 9, 13, 3, 25)
  const sessionID = "ses_layout"
  const session = { id: sessionID, title: "Layout fixture", slug: "layout", projectID: "proj_test",
    directory, version: "0.1.0", cost: 0.0123, time: { created: time, updated: time } }
  const model = { id: "fixture-model", name: "NVIDIA model (UI fixture)", providerID: "fixture",
    limit: { context: 32000, output: 4096 }, cost: { input: 2, output: 6 }, variants: {},
    capabilities: { attachment: false, reasoning: false, temperature: true, toolcall: true,
      input: { text: true }, output: { text: true } }, api: { id: "fixture-model", npm: "fixture" } }
  const provider = { id: "fixture", name: "Local fixture", models: { [model.id]: model } }
  const todos = [
    { id: "one", content: "Inspect repository and locate the failing test", status: "completed", priority: "high" },
    { id: "two", content: "Apply a targeted correction", status: "in_progress", priority: "high" },
    { id: "three", content: "Run affected tests and review the diff", status: "pending", priority: "high" },
  ]
  const tool = (id: string, name: string, input: Record<string, unknown>, metadata: Record<string, unknown>, output = ""): ToolPart => ({
    id, type: "tool", sessionID, messageID: "msg_02", callID: id, tool: name,
    state: { status: "completed", title: name, input, metadata, output, time: { start: time, end: time + 100 } },
  })
  const assistant: AssistantMessage = { id: "msg_02", sessionID, parentID: "msg_01", role: "assistant", agent: "build", mode: "build",
    modelID: model.id, providerID: provider.id, path: { cwd: directory, root: directory }, cost: 0.0123,
    tokens: { input: 2000, output: 240, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: time + 1000, completed: time + 2000 }, finish: "tool-calls" }
  const messages = [
    { info: { id: "msg_01", sessionID, role: "user", agent: "build",
        model: { providerID: provider.id, modelID: model.id }, time: { created: time } },
      parts: [{ id: "prt_01", sessionID, messageID: "msg_01", type: "text",
        text: "Fix the retry limit bug and verify the change with the existing tests." }] },
    { info: assistant, parts: [
      { id: "prt_02", sessionID, messageID: "msg_02", type: "text",
        text: "### Task\nInspect the retry logic, make a focused fix, then verify the result." },
      tool("prt_03", "todowrite", { todos }, { todos }),
      tool("prt_04", "read", { path: `${directory}/src/retry.ts` }, { preview: "retry implementation" }),
      tool("prt_05", "bash", { command: "bun test test/retry.test.ts" }, { output: "1 pass\n0 fail\n1 test in 1 file (UI fixture output)" }),
    ] },
  ]
  let compactCalls = 0
  let compact = () => Promise.resolve(json(false))
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { fixture: model.id } })
    if (url.pathname === "/provider") return json({ all: [provider], connected: [provider.id], default: { fixture: model.id } })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/skill") return json([{ name: "fixture-skill", description: "Local project skill",
      location: `${directory}/.phins/skills/fixture-skill/SKILL.md` }])
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json(messages)
    if (url.pathname === `/session/${sessionID}/todo`) return json(todos)
    if (url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/session/${sessionID}/summarize`) { compactCalls++; return compact() }
    return undefined
  }, events)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let task: Promise<unknown> | undefined
  const renderUntil = async (needle: string) => {
    for (let n = 0; n < 100; n++) {
      await setup.renderOnce()
      if (setup.captureCharFrame().includes(needle)) return setup.captureCharFrame()
      await Bun.sleep(10)
    }
    throw new Error(`Layout never rendered ${needle}:\n${setup.captureCharFrame()}`)
  }
  const displayOption = async (index: number) => {
    api?.keymap.dispatchCommand("help.show")
    await renderUntil("PHINs Agent help")
    setup.mockInput.pressKey("t", { ctrl: true })
    await renderUntil("Display options")
    for (let n = 0; n < index; n++) setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    // Legacy terminals defer a lone Esc to distinguish it from Alt sequences.
    // The draft is visible behind dialogs, so its text cannot prove dismissal.
    for (let n = 0; n < 100; n++) {
      await setup.renderOnce()
      if (!api?.ui.dialog.open && setup.renderer.currentFocusedEditor) break
      await Bun.sleep(10)
    }
    expect(api?.ui.dialog.open).toBe(false)
    expect(setup.renderer.currentFocusedEditor).toBeTruthy()
    await renderUntil("Keep this local draft")
  }
  const textColor = (label: string) => {
    const span = setup.captureSpans().lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes(label))
    expect(span).toBeDefined()
    return [span!.fg.r, span!.fg.g, span!.fg.b]
  }
  const expectDistinctLabels = () => {
    expect(textColor("You")).not.toEqual(textColor("PHINs"))
    expect(textColor(model.name)).not.toEqual(textColor("Local fixture"))
    expect(textColor(model.name)).not.toEqual(textColor("build"))
  }
  const capture = async (name: string) => {
    const output = process.env.PHINS_LAYOUT_CAPTURE
    if (!output) return
    // Markdown highlighting updates asynchronously after a theme change.
    for (let n = 0; n < 4; n++) { await Bun.sleep(20); await setup.renderOnce() }
    await mkdir(output, { recursive: true })
    const frame = setup.captureSpans()
    const color = (c: { r: number; g: number; b: number; a: number }) => [c.r, c.g, c.b, c.a]
    const cursor = setup.renderer.getCursorState()
    await writeFile(`${output}/${name}.json`, JSON.stringify({ ...frame,
      cursor: { ...cursor, color: color(cursor.color) },
      lines: frame.lines.map((line) => ({ ...line, spans: line.spans.map((span) => ({
        ...span, fg: color(span.fg), bg: color(span.bg),
      })) })),
    }))
    await writeFile(`${output}/${name}.txt`, setup.captureCharFrame())
  }
  try {
    const { run } = await import("../../src/tui/app")
    task = Effect.runPromise(run({
      url: "http://test", directory,
      config: createTuiResolvedConfig({ theme: "phins", plugin_enabled: {} }),
      fetch: calls.fetch, events: events.source, args: {},
      pluginHost: {
        async start(input) { api = input.api; input.runtime.setupSlots(input.api); started() },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppPaths.defaultLayer)))
    await ready
    await renderUntil("Ask Phins")
    expect(setup.captureCharFrame()).toContain("Hi! I’m")
    await capture("empty-160x48")
    api?.route.navigate("session", { sessionID })
    await renderUntil("UI fixture output")
    let frame = setup.captureCharFrame()
    expect(frame).toContain("PHINs Agent")
    expect(frame).toContain("TỪ Ý TƯỞNG ĐẾN CÔNG VIỆC HOÀN THÀNH")
    expect(frame).toContain("Local fixture")
    expect(frame).toContain("% Context: 7%")
    expect(frame).toContain("$ Cost: ~0.0123")
    expect(frame).toContain("Plan")
    expect(frame).toContain("Actions")
    expect(frame).toContain("Read src/retry.ts")
    expect(frame).toContain("Output")
    expectDistinctLabels()
    await capture("conversation-160x48")
    setup.resize(160, 40)
    frame = await renderUntil("UI fixture output")
    const rows = frame.split("\n")
    const row = (text: string) => rows.find((line) => line.includes(text))!
    const bodyColumn = row("Fix the retry limit bug").indexOf("Fix the retry limit bug")
    // Content sits two cells inside the role label after the owner's spacing
    // revision; section titles still share an axis within each message.
    expect(bodyColumn).toBe(row("You").indexOf("You") + 2)
    expect(frame).not.toContain("Hi! I’m")
    for (const title of ["Task", "Plan", "Actions", "Output"])
      expect(row(title).indexOf(title)).toBe(bodyColumn + 4)
    expect(rows.indexOf(row("Inspect the retry logic"))).toBe(rows.indexOf(row("◎")) + 1)
    expect(rows.indexOf(row("Inspect repository and locate"))).toBe(rows.indexOf(row("▤  Plan")) + 1)
    expect(row("Output")).toContain("─")
    expect(frame).toContain("○ Run affected tests")
    expect(frame).not.toContain("Tip:")
    await capture("comparison-160x40")
    setup.resize(160, 48)
    setup.mockInput.typeText("Keep this local draft")
    await renderUntil("Keep this local draft")
    for (const [width, height] of [[120, 36], [80, 24], [40, 24], [160, 48]]) {
      setup.resize(width!, height!)
      const frame = await renderUntil("Keep this local draft")
      expect(frame).toContain("Keep this local draft")
      expect(frame).toContain("PHINs Agent")
      expect(frame.split("\n").at(-3)).toContain("Ready")
      const input = setup.renderer.currentFocusedEditor!
      const cursor = setup.renderer.getCursorState()
      expect(cursor.visible).toBe(true)
      expect(cursor.x - 1).toBe(input.x + Bun.stringWidth("Keep this local draft"))
      expect(cursor.y - 1).toBe(input.y)
      await capture(`draft-${width}x${height}`)
    }
    await displayOption(1)
    expect(api?.theme.mode()).toBe("light")
    expectDistinctLabels()
    await capture("conversation-light-160x48")
    await displayOption(1)
    expect(api?.theme.mode()).toBe("dark")
    await displayOption(6)
    frame = await renderUntil("FROM IDEAS to IMPACT")
    expect(frame).not.toContain("TỪ Ý TƯỞNG")
    expect(frame).toContain("Keep this local draft")
    await capture("conversation-english-160x48")
    await displayOption(6)
    await renderUntil("TỪ Ý TƯỞNG ĐẾN CÔNG VIỆC HOÀN THÀNH")
    const emit = (payload: Parameters<typeof events.emit>[0]["payload"]) => events.emit({ directory, project: "proj_test", payload })
    session.title = "Fix the retry limit bug and verify the change with the existing tests."
    emit({ id: "evt_title", type: "session.updated", properties: { sessionID, info: session } })
    api?.keymap.dispatchCommand("session.list")
    frame = await renderUntil("pin/unpin")
    expect(frame).toContain("Fix the retry limit bug")
    await capture("sessions-titled-160x48")
    setup.mockInput.pressEscape()
    for (let n = 0; n < 100 && api?.ui.dialog.open; n++) {
      await Bun.sleep(10)
      await setup.renderOnce()
    }
    expect(api?.ui.dialog.open).toBe(false)
    session.title = "Layout fixture"
    emit({ id: "evt_restore_title", type: "session.updated", properties: { sessionID, info: session } })
    emit({ id: "evt_usage", type: "message.updated", properties: { sessionID, info: { ...assistant,
      cost: 0, tokens: { input: 9600, output: 0, reasoning: 400, cache: { read: 0, write: 0 } },
    } } })
    frame = await renderUntil("$ Cost: ~0.0216")
    expect(frame).toContain("% Context: 31%")
    expect(frame).toContain("# Tokens: 10.0K")
    await capture("usage-updated-160x48")
    emit({ id: "evt_unknown_usage", type: "message.updated", properties: { sessionID, info: { ...assistant,
      modelID: "unknown-model", cost: 0,
    } } })
    frame = await renderUntil("$ Cost: —")
    expect(frame).toContain("% Context: —")
    expect(frame).not.toContain("$ Cost: ~0.0000")
    emit({ id: "evt_restore_usage", type: "message.updated", properties: { sessionID, info: assistant } })
    await renderUntil("$ Cost: ~0.0123")
    // Current tools send `path`; old persisted messages can still have
    // `filePath`. A finished tool must display its file, never "Preparing...".
    for (const field of ["path", "filePath"]) {
      for (const name of ["read", "edit", "write"]) {
        emit({ id: `evt_${field}_${name}`, type: "message.part.updated", properties: {
          sessionID, time,
          part: tool("prt_04", name, { [field]: `${directory}/src/retry.ts` }, {}),
        } })
        frame = await renderUntil(`${name[0]!.toUpperCase()}${name.slice(1)} src/retry.ts`)
        expect(frame).not.toContain("Preparing")
        expect(frame).not.toContain("Reading file...")
        expect(frame).not.toContain("[path=")
      }
    }
    emit({ id: "evt_restore_read", type: "message.part.updated", properties: {
      sessionID, time,
      part: tool("prt_04", "read", { path: `${directory}/src/retry.ts` }, {}),
    } })
    await renderUntil("Read src/retry.ts")
    emit({ id: "evt_busy", type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    await renderUntil("×2 stop")
    await capture("running-160x48")
    setup.resize(80, 24)
    emit({ id: "evt_retry", type: "session.status", properties: { sessionID,
      status: { type: "retry", attempt: 1, message: "Provider rate limit. The agent will retry within the configured limit.", next: Date.now() + 10000 } } })
    frame = await renderUntil("Retrying")
    expect(frame).toContain("×2 stop")
    expect(frame).toContain("Keep this local draft")
    await capture("retry-80x24")
    emit({ id: "evt_idle", type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    emit({ id: "evt_permission", type: "permission.asked", properties: { id: "per_layout", sessionID, permission: "bash",
      tool: { messageID: "msg_02", callID: "prt_05" },
      patterns: ["bun test *"], always: ["bun test *"], metadata: {} } })
    frame = await renderUntil("Needs input")
    expect(frame).not.toContain("Keep this local draft")
    expect(frame).toContain("enter confirm")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    await capture("permission-80x24")
    emit({ id: "evt_reply", type: "permission.replied", properties: { sessionID, requestID: "per_layout", reply: "once" } })
    await renderUntil("Keep this local draft")
    api?.keymap.dispatchCommand("session.first")
    await renderUntil("Fix the retry limit bug")
    expect(setup.captureCharFrame()).toContain("Keep this local draft")
    api?.keymap.dispatchCommand("session.last")
    await renderUntil("UI fixture output")
    setup.resize(160, 48)
    await displayOption(4)
    expect(api?.kv.get<string>("sidebar")).toBe("auto")
    await renderUntil("Layout fixture")
    await capture("inspector-160x48")
    setup.resize(80, 24)
    frame = await renderUntil("Keep this local draft")
    expect(frame).not.toContain("Layout fixture")
    await displayOption(4)
    expect(api?.kv.get<string>("sidebar")).toBe("hide")
    emit({ id: "evt_error", type: "message.updated", properties: { sessionID, info: { ...assistant,
      error: { name: "UnknownError", data: { message: "Fixture provider unavailable" } }, finish: "error" } } })
    frame = await renderUntil("Fixture provider unavailable")
    expect(frame).toContain("● Error")
    expect(frame).toContain("Keep this local draft")
    await capture("error-80x24")
    emit({ id: "evt_stopped", type: "message.updated", properties: { sessionID, info: { ...assistant,
      error: { name: "MessageAbortedError", data: { message: "Stopped" } }, finish: "stop" } } })
    frame = await renderUntil("● Stopped")
    expect(frame).toContain("Keep this local draft")
    await capture("stopped-80x24")
    setup.resize(160, 48)
    emit({ id: "evt_work_done", type: "message.updated", properties: { sessionID, info: { ...assistant, finish: "stop" } } })
    for (const [id, name] of [["prt_04a", "helpers.ts"], ["prt_04b", "config.ts"]]) {
      emit({ id: `evt_${id}`, type: "message.part.updated", properties: { sessionID, time,
        part: tool(id!, "read", { path: `${directory}/src/${name}` }, {}) } })
    }
    frame = await renderUntil("Explore · 3 completed actions")
    expect(frame).not.toContain("Read src/helpers.ts")
    setup.mockInput.pressKey("o", { ctrl: true })
    await renderUntil("Read src/helpers.ts")
    expect(setup.renderer.currentFocusedEditor).toBeTruthy()
    setup.mockInput.pressKey("o", { ctrl: true })
    for (let n = 0; n < 3; n++) await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Read src/helpers.ts")
    // A later reply for the same request belongs to the existing work turn.
    const followup = { ...assistant, id: "msg_03", finish: "stop" }
    emit({ id: "evt_followup", type: "message.updated", properties: { sessionID, info: followup } })
    emit({ id: "evt_followup_text", type: "message.part.updated", properties: { sessionID, time,
      part: { id: "prt_result", type: "text", sessionID, messageID: followup.id, text: "LOCAL_WORK_RESULT" } } })
    for (const part of [tool("prt_06", "edit", { path: `${directory}/src/retry.ts` }, {}),
      tool("prt_07", "bash", { command: "bun test test/retry.test.ts" }, { exitCode: 0, output: "UI fixture command outcome" })]) {
      emit({ id: `evt_${part.id}`, type: "message.part.updated", properties: { sessionID, time, part } })
    }
    await renderUntil("LOCAL_WORK_RESULT")
    frame = await renderUntil("code verification unverified")
    expect(frame).toContain("exit 0")
    expect(frame).toContain("LOCAL_WORK_RESULT")
    expect(frame.split("\n").filter((line) => /^\s*│?\s*PHINs\s+\d/.test(line))).toHaveLength(1)
    expect(frame.split("\n").filter((line) => /\bResult\s*│?$/.test(line))).toHaveLength(1)
    await capture("work-turn-160x48")
    const failure: ToolPart = { ...tool("prt_08", "read", {}, {}), state: { status: "error",
      input: { path: `${directory}/src/blocked.ts` }, error: "Fixture read was denied", time: { start: time, end: time + 1 } } }
    emit({ id: "evt_read_failure", type: "message.part.updated", properties: { sessionID, time, part: failure } })
    await renderUntil("Fixture read was denied")
    // Stress the actual feed with history and streamed text, then exercise keyboard follow/unfollow.
    for (let n = 10; n < 60; n++) {
      const id = `msg_${n}`
      emit({ id: `evt_${id}`, type: "message.updated", properties: { sessionID,
        info: { ...assistant, id, parentID: `request_${n}`, finish: "stop" } } })
      emit({ id: `evt_part_${n}`, type: "message.part.updated", properties: { sessionID, time,
        part: { id: `stream_${n}`, type: "text", sessionID, messageID: id, text: `History fixture ${n}\nSecond line` } } })
    }
    api?.keymap.dispatchCommand("session.last")
    await renderUntil("History fixture 59")
    setup.resize(80, 24)
    api?.keymap.dispatchCommand("session.first")
    await renderUntil("Back to latest")
    const feed = setup.renderer.root.findDescendantById("conversation-feed") as ScrollBoxRenderable
    const position = feed.scrollTop
    const content = (node: BaseRenderable): string[] => node instanceof MarkdownRenderable
      ? [node.content] : node.getChildren().flatMap(content)
    for (let n = 0; n < 30; n++) {
      const marker = `STREAM_UPDATE_${n}`
      emit({ id: `evt_stream_${n}`, type: "message.part.updated", properties: { sessionID, time,
        part: { id: "stream_59", type: "text", sessionID, messageID: "msg_59",
          text: `History fixture 59\n${"Streaming fixture line\n".repeat(n + 1)}${marker}` } } })
      for (let attempt = 0; attempt < 200; attempt++) {
        await setup.renderOnce()
        if (content(feed.content.findDescendantById("msg_59")!).some((text) => text.endsWith(marker))) break
        await Bun.sleep(2)
      }
      expect(content(feed.content.findDescendantById("msg_59")!).some((text) => text.endsWith(marker))).toBe(true)
      expect(feed.scrollTop).toBe(position)
    }
    expect(setup.captureCharFrame()).toContain("Keep this local draft")
    await capture("reading-history-80x24")
    api?.keymap.dispatchCommand("session.last")
    frame = await renderUntil("Streaming fixture line")
    for (let n = 0; n < 3; n++) await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Back to latest")
    setup.resize(160, 48)
    await renderUntil("% Context: 7%")
    let finishCompact!: (value: Response) => void
    compact = () => new Promise((resolve) => { finishCompact = resolve })
    api?.keymap.dispatchCommand("session.compact")
    await renderUntil("● Compacting")
    api?.keymap.dispatchCommand("session.compact")
    await renderUntil("Wait for the current operation")
    expect(compactCalls).toBe(1)
    const checkpointID = "msg_60"
    emit({ id: "evt_compact_message", type: "message.updated", properties: { sessionID,
      info: { id: checkpointID, sessionID, role: "user", agent: "build",
        model: { providerID: provider.id, modelID: model.id }, time: { created: time + 3000 } } } })
    emit({ id: "evt_compact_marker", type: "message.part.updated", properties: { sessionID, time,
      part: { id: "prt_compact_marker", sessionID, messageID: checkpointID, type: "compaction", auto: false } } })
    emit({ id: "evt_compact_text", type: "message.part.updated", properties: { sessionID, time,
      part: { id: "prt_compact_text", sessionID, messageID: checkpointID, type: "text", synthetic: true,
        text: compactionText({ summary: "COMPACTION_SUMMARY_NOT_A_NEW_USER_REQUEST", recent: "Retained details. ".repeat(100) }) } } })
    finishCompact(json(true))
    frame = await renderUntil("% Context: ~2%")
    expect(frame).toContain("Compaction")
    expect(frame).not.toContain("COMPACTION_SUMMARY_NOT_A_NEW_USER_REQUEST")
    expect(frame).toContain("Keep this local draft")
    await capture("compacted-160x48")
    compact = () => Promise.resolve(Response.json({ message: "Compaction fixture failed" }, { status: 400 }))
    api?.keymap.dispatchCommand("session.compact")
    frame = await renderUntil("Compaction fixture failed")
    expect(frame).toContain("% Context: ~2%")
    expect(frame).toContain("● Ready")
    compact = () => Promise.resolve(json(false))
    api?.keymap.dispatchCommand("session.compact")
    await renderUntil("No new conversation to compact")
    emit({ id: "evt_after_compact_usage", type: "message.updated", properties: { sessionID,
      info: { ...assistant, id: "msg_61", tokens: { input: 4000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } } } })
    frame = await renderUntil("% Context: 13%")
    expect(frame).toContain("# Tokens: 4.2K")
    api?.route.navigate("home")
    setup.resize(120, 36)
    frame = await renderUntil("What would you like to work on?")
    expect(frame).toContain("Keep this local draft")
    expect(frame).toContain("PHINs Agent")
    expect(frame).toContain("● Ready")
    await capture("home-120x36")
    api?.keymap.dispatchCommand("help.show")
    await renderUntil("project skills")
    setup.mockInput.pressKey("s", { ctrl: true })
    await renderUntil("fixture-skill")
    setup.mockInput.pressEnter()
    frame = await renderUntil("Use the fixture-skill skill.")
    expect(frame).toContain("Keep this local draft")
    expect(frame).toContain("Use the fixture-skill skill.")
  } finally {
    api?.keymap.dispatchCommand("app.exit")
    if (task) await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 60_000)
