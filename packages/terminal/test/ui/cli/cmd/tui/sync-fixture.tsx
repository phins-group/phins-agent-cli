/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../../../src/tui/state/launch-args"
import { ExitProvider } from "../../../../../src/tui/state/lifecycle"
import { KVProvider, useKV } from "../../../../../src/tui/state/kv"
import { ProjectProvider, useProject } from "../../../../../src/tui/state/project"
import { AgentClientProvider } from "../../../../../src/tui/state/agent-client"
import { SessionStateProvider, useSessionState } from "../../../../../src/tui/state/sessions"
import { createEventSource, createFetch, type FetchHandler, directory } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = { kv: ReturnType<typeof useKV>; project: ReturnType<typeof useProject>; sync: ReturnType<typeof useSessionState> }

export async function mount(override?: FetchHandler, state?: string) {
  const calls = createFetch(override)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSessionState>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSessionState() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={state ? { state } : undefined}>
      <ArgsProvider>
        <ExitProvider exit={() => {}}>
          <KVProvider>
            <AgentClientProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SessionStateProvider>
                  <Probe />
                </SessionStateProvider>
              </ProjectProvider>
            </AgentClientProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, kv, project, sync, session: calls.session }
}
