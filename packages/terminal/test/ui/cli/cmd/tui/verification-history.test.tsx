/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@phins/engine/transport/client/create"
import { createSignal } from "solid-js"
import { AgentClientProvider } from "../../../../../src/tui/state/agent-client"
import { VerificationHistoryPanel } from "../../../../../src/tui/screens/session/verification-history-panel"
import { createEventSource, directory, json, wait } from "./sync-fixture"

function receipt(sessionID = "ses_a", verdict = "passed") {
  return {
    id: "receipt_a",
    sessionID,
    mode: "shadow",
    verdict,
    freshness: "unverified",
    time: { requested: 1_700_000_000_000 },
  }
}

async function mount(initial: string | undefined = "ses_a") {
  const [sessionID, changeSession] = createSignal<string | undefined>(initial)
  const events = createEventSource()
  const requests: { request: Request; resolve: (value: Response) => void }[] = []
  const fetcher = ((input: Request) => {
    const pending = Promise.withResolvers<Response>()
    requests.push({ request: input, resolve: pending.resolve })
    return pending.promise // Deliberately ignore abort to exercise late-response protection.
  }) as typeof fetch
  const app = await testRender(
    () => (
      <AgentClientProvider url="http://test" fetch={fetcher} events={events.source}>
        <box width={37}>
          <VerificationHistoryPanel sessionID={sessionID()} color={RGBA.fromHex("#888888")} />
        </box>
      </AgentClientProvider>
    ),
    { width: 42, height: 18 },
  )
  async function frame() {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  function emit(type: string, properties: object = {}) {
    events.emit({ directory, payload: { id: "evt_test", type, properties } } as GlobalEvent)
  }
  async function reply(index: number, data: unknown, status = 200) {
    requests[index].resolve(json(data, { status }))
    const start = Date.now()
    do {
      await Bun.sleep(0)
      if (requests[index].request.signal.aborted) return
      if (!(await frame()).includes("Loading history")) return
    } while (Date.now() - start < 2000)
    throw new Error("history response did not render")
  }
  return { app, requests, changeSession, frame, emit, reply }
}

test("history renders bounded historical results without claiming current success", async () => {
  const ui = await mount()
  try {
    await wait(() => ui.requests.length === 1)
    expect(await ui.frame()).toContain("Loading history")
    await ui.reply(0, { data: [receipt(), receipt("ses_a", "failed"), receipt("ses_a", "pending"), receipt()] })
    const frame = await ui.frame()
    expect(frame).toContain("Verification history · shadow")
    expect(frame).toContain("Current code: unverified")
    expect(frame).toContain("UTC · passed")
    expect(frame).toContain("UTC · failed")
    expect(frame).toContain("UTC · pending")
    expect(frame).toContain("Showing latest 3 checks")
    expect(frame.match(/UTC/g)).toHaveLength(3)
    expect(frame).toMatchSnapshot()
  } finally {
    ui.app.renderer.destroy()
  }
})

test("session changes abort requests and ignore late responses, including failures", async () => {
  const ui = await mount()
  try {
    await wait(() => ui.requests.length === 1)
    ui.changeSession("ses_b")
    await wait(() => ui.requests.length === 2)
    expect(ui.requests[0].request.signal.aborted).toBe(true)
    expect(ui.requests[1].request.url).toContain("/api/session/ses_b/verification")
    await ui.reply(1, { data: [receipt("ses_b", "failed")] })
    await ui.reply(0, { data: [receipt()] })
    expect(await ui.frame()).toContain("UTC · failed")
    expect(await ui.frame()).not.toContain("UTC · passed")
    ui.emit("server.connected")
    await wait(() => ui.requests.length === 3)
    ui.changeSession("ses_c")
    await wait(() => ui.requests.length === 4)
    await ui.reply(3, { data: [] })
    await ui.reply(2, {}, 500)
    expect(await ui.frame()).toContain("No historical checks")
    expect(await ui.frame()).not.toContain("History unavailable")
  } finally {
    ui.app.renderer.destroy()
  }
})

test("reconnect and matching events reload history; deleted sessions stay invalidated", async () => {
  const ui = await mount()
  try {
    await wait(() => ui.requests.length === 1)
    await ui.reply(0, { data: [] })
    ui.emit("session.next.verification.settled", { sessionID: "ses_other" })
    ui.emit("server.connected")
    await wait(() => ui.requests.length === 2)
    await ui.reply(1, { data: [receipt()] })
    for (const type of [
      "session.next.verification.requested",
      "session.next.verification.settled",
      "session.next.moved",
    ]) {
      const count = ui.requests.length
      ui.emit(type, { sessionID: "ses_a" })
      await wait(() => ui.requests.length === count + 1)
      expect(await ui.frame()).toContain("Loading history")
      await ui.reply(count, { data: [] })
    }
    ui.emit("server.connected")
    await wait(() => ui.requests.length === 6)
    ui.emit("session.deleted", { info: { id: "ses_a" } })
    await wait(() => ui.requests[5].request.signal.aborted)
    await ui.reply(5, { data: [receipt()] })
    expect(await ui.frame()).toContain("History unavailable")
    ui.emit("server.connected")
    await ui.frame()
    expect(ui.requests).toHaveLength(6)
  } finally {
    ui.app.renderer.destroy()
  }
})

test("errors and incompatible history fail closed and recover on reconnect", async () => {
  const ui = await mount()
  try {
    const invalid = [
      undefined,
      [receipt("ses_other")],
      [{ ...receipt(), mode: "enforce" }],
      [{ ...receipt(), freshness: "verified" }],
      [receipt("ses_a", "unknown")],
      [{ ...receipt(), time: {} }],
      Array.from({ length: 51 }, () => receipt()),
    ]
    for (const [index, data] of invalid.entries()) {
      await wait(() => ui.requests.length === index + 1)
      await ui.reply(index, { data })
      expect(await ui.frame()).toContain("History unavailable")
      expect(await ui.frame()).not.toContain("UTC · passed")
      ui.emit("server.connected")
    }
    await wait(() => ui.requests.length === invalid.length + 1)
    await ui.reply(invalid.length, {}, 404)
    expect(await ui.frame()).toContain("History unavailable")
    ui.emit("server.connected")
    await wait(() => ui.requests.length === invalid.length + 2)
    await ui.reply(invalid.length + 1, { data: [] })
    expect(await ui.frame()).toContain("No historical checks")
  } finally {
    ui.app.renderer.destroy()
  }
})

test("new sessions do not fetch; unmount aborts the visible session request", async () => {
  const ui = await mount("")
  try {
    expect(ui.requests).toHaveLength(0)
    expect(await ui.frame()).not.toContain("Verification history")
    ui.changeSession("ses_a")
    await wait(() => ui.requests.length === 1)
    ui.changeSession(undefined)
    await wait(() => ui.requests[0].request.signal.aborted)
    await ui.reply(0, { data: [receipt()] })
    expect(await ui.frame()).not.toContain("Verification history")
    ui.changeSession("ses_b")
    await wait(() => ui.requests.length === 2)
  } finally {
    ui.app.renderer.destroy()
  }
  await wait(() => ui.requests[1].request.signal.aborted)
  await ui.reply(1, { data: [receipt("ses_b")] })
})
