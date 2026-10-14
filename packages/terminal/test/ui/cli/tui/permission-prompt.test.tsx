/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { Session } from "@phins/engine/transport/client/create"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import { ArgsProvider } from "../../../../src/tui/state/launch-args"
import { ExitProvider } from "../../../../src/tui/state/lifecycle"
import { KVProvider } from "../../../../src/tui/state/kv"
import { LocationProvider } from "../../../../src/tui/state/location"
import { ProjectProvider } from "../../../../src/tui/state/project"
import { AgentClientProvider } from "../../../../src/tui/state/agent-client"
import { SessionStateProvider, useSessionState } from "../../../../src/tui/state/sessions"
import { ThemeProvider } from "../../../../src/tui/theme/provider"
import { TuiConfigProvider } from "../../../../src/tui/config/settings"
import { PHINsKeymapProvider, registerPHINsKeymap } from "../../../../src/tui/state/keymap"
import { PermissionPrompt } from "../../../../src/tui/screens/session/permission-request"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

async function wait(check: () => boolean) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("permission prompt did not settle")
    await Bun.sleep(10)
  }
}

async function mount(state: string, initial: "parent" | "child" | "missing") {
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [sessionID, setSessionID] = createSignal(initial)
  const sessions = ["parent", "child"].map((id) => ({
    id, parentID: id === "child" ? "parent" : undefined,
    projectID: "proj_test", directory, slug: id, title: id, version: "1",
    time: { created: 1, updated: 1 },
  } satisfies Session))
  const replies: unknown[] = []
  const events = createEventSource()
  const calls = createFetch((url) => url.pathname === "/session" ? json(sessions) : undefined)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/permission/per_fixture/reply") {
      replies.push(await request.json())
      return json(true)
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch
  let sync!: ReturnType<typeof useSessionState>
  function Prompt() {
    sync = useSessionState()
    return <PermissionPrompt request={{ id: "per_fixture", sessionID: sessionID(),
      permission: "fixture", patterns: ["fixture"], always: ["*"], metadata: {} }} />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerPHINsKeymap(keymap, renderer, config))
    return <TestTuiContexts paths={{ state }}>
      <PHINsKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <ArgsProvider><ExitProvider exit={() => {}}><KVProvider>
            <ThemeProvider mode="dark">
              <AgentClientProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                <ProjectProvider><SessionStateProvider><LocationProvider location={{ directory }}>
                  <Prompt />
                </LocationProvider></SessionStateProvider></ProjectProvider>
              </AgentClientProvider>
            </ThemeProvider>
          </KVProvider></ExitProvider></ArgsProvider>
        </TuiConfigProvider>
      </PHINsKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  try {
    await wait(() => sync?.status === "complete")
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
  return { app, replies, setSessionID, async frame() {
    await app.renderOnce()
    return app.captureCharFrame()
  } }
}

test("foreground child permissions offer once/reject, never persistent grants", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, "child")
  try {
    const frame = await view.frame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    expect(frame).not.toContain("Allow always")
    view.app.mockInput.pressEnter()
    await wait(() => view.replies.length === 1)
    expect(view.replies).toEqual([{ reply: "once" }])
  } finally {
    view.app.renderer.destroy()
  }
})

test("root session retains always confirmation and keyboard navigation", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, "parent")
  try {
    expect(await view.frame()).toContain("Allow always")
    view.app.mockInput.pressArrow("right")
    view.app.mockInput.pressEnter()
    expect(await view.frame()).toContain("Always allow")
    view.app.mockInput.pressEnter()
    await wait(() => view.replies.length === 1)
    expect(view.replies).toEqual([{ reply: "always" }])
  } finally {
    view.app.renderer.destroy()
  }
})

test("child keyboard rejection still offers feedback and submits reject", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, "child")
  try {
    await view.frame()
    view.app.mockInput.pressArrow("right")
    view.app.mockInput.pressEnter()
    expect(await view.frame()).toContain("Reject permission")
    view.app.mockInput.pressEnter()
    await wait(() => view.replies.length === 1)
    expect(view.replies).toEqual([{ reply: "reject" }])
  } finally {
    view.app.renderer.destroy()
  }
})

test("unknown session cannot remember grants and a removed option cannot stay selected", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, "missing")
  try {
    expect(await view.frame()).not.toContain("Allow always")
    view.setSessionID("parent")
    expect(await view.frame()).toContain("Allow always")
    view.app.mockInput.pressArrow("right")
    view.setSessionID("child")
    expect(await view.frame()).not.toContain("Allow always")
    view.app.mockInput.pressEnter()
    await wait(() => view.replies.length === 1)
    expect(view.replies).toEqual([{ reply: "once" }])
  } finally {
    view.app.renderer.destroy()
  }
})
