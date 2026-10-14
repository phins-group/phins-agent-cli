/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { AgentClientProvider, useAgentClient } from "../../../../../src/tui/state/agent-client"
import { wait } from "./sync-fixture"

test("SDK reconnects after a failed subscription and delivers subsequent events", async () => {
  let attempts = 0
  let received = 0
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetcher = (async (_input: RequestInfo | URL) => {
    if (++attempts === 1) throw new Error("offline fixture")
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"directory":"/tmp","payload":{"id":"evt_connected","type":"server.connected","properties":{}}}\n\n',
            ),
          )
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  }) as typeof fetch
  function Probe() {
    const sdk = useAgentClient()
    onCleanup(sdk.event.on("event", () => received++))
    return <box />
  }
  const app = await testRender(() => (
    <AgentClientProvider url="http://test" fetch={fetcher}>
      <Probe />
    </AgentClientProvider>
  ))
  try {
    await wait(() => received === 1, 6000)
    expect(attempts).toBe(2)
  } finally {
    app.renderer.destroy()
    stream?.close()
  }
})
