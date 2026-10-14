import { Prompt, type PromptRef } from "../../composer/input"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { AgentLayout, AgentWelcome } from "../../components/layout"
import { ConversationViewport } from "../../components/conversation-viewport"
import { useSessionState } from "../../state/sessions"
import { Toast } from "../../components/toast"
import { useArgs } from "../../state/launch-args"
import { useScreenRoute } from "../../state/navigation"
import { usePromptRef } from "../../composer/controller"
import { usePreferences } from "../../state/preferences"
import { usePluginRuntime } from "../../extensions/provider"
import { useEditorContext } from "../../state/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../../config/settings"
import { HomeSessionDestinationProvider } from "./destination"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSessionState()
  const route = useScreenRoute("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = usePreferences()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? dimensions().width - 4
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <AgentLayout>
        <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
          <ConversationViewport>
            <pluginRuntime.Slot name="home_logo" mode="replace">
              <AgentWelcome />
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="home_bottom" />
          </ConversationViewport>
          <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} flexShrink={0}>
            <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
              <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
            </pluginRuntime.Slot>
          </box>
          <Toast />
        </box>
      </AgentLayout>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
