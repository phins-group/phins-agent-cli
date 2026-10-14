import { Conversation, ConversationContext } from "./conversation"
import { ConversationViewport } from "../../components/conversation-viewport"
import { AgentLayout, AgentWelcome, useMessageIndent } from "../../components/layout"
import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, untrack } from "solid-js"
import { useNavigation, useScreenRoute } from "../../state/navigation"
import { useProject } from "../../state/project"
import { useSessionState } from "../../state/sessions"
import { useEvent } from "../../state/event"
import { useTheme } from "../../theme/provider"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../composer/input"
import type { ToolPart, AgentRun } from "@phins/engine/transport/client/create"
import { usePreferences } from "../../state/preferences"
import { Locale } from "../../render/locale"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useAgentClient } from "../../state/agent-client"
import { useEditorContext } from "../../state/editor"
import { useDialog } from "../../components/dialog"
import { DialogAlert } from "../../components/dialog-alert"
import { DialogMessage } from "./message-menu"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { SubagentDialog } from "./subagent-dialog"
import parsers from "../../render/parsers"
import { errorMessage } from "../../../shared/errors"
import { Toast, useToast } from "../../components/toast"
import { useKV } from "../../state/kv.tsx"
import { usePromptRef } from "../../composer/controller"
import { useEpilogue } from "../../state/lifecycle"
import { PermissionPrompt } from "./permission-request"
import { QuestionPrompt } from "./question-request"
import * as Model from "../../../shared/model-info"
import { sessionEpilogue } from "../../../shared/presentation"
import { useTuiConfig } from "../../config/settings"
import { useClipboard } from "../../state/clipboard"
import { useThinkingMode } from "../../render/thinking"
import { usePluginRuntime } from "../../extensions/provider"
import { getRevertDiffFiles } from "../../render/revert-diff"
import { PHINS_BASE_MODE, useBindings } from "../../state/keymap"
import { LocationProvider } from "../../state/location"

addDefaultParsers(parsers.parsers)

const sessionBindingCommands = [
  "session.compact",
  "session.activities.toggle",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const pluginRuntime = usePluginRuntime()
  const route = useScreenRoute("session")
  const { navigate } = useNavigation()
  const sync = useSessionState()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => (route.sessionID ? sync.session.get(route.sessionID) : undefined))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  createEffect(() => {
    const current = session()
    if (!current) {
      setEpilogue(sessionEpilogue({ title: "New session" }))
      return
    }
    const title = Locale.truncate(current.title, 50)
    setEpilogue(sessionEpilogue({ title, sessionID: current.id }))
  })
  onCleanup(() => setEpilogue())
  const children = createMemo(() => {
    if (!route.sessionID) return []
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => (route.sessionID ? (sync.data.message[route.sessionID] ?? []) : []))
  const foregroundTasks = createMemo(() =>
    sync.data.capabilities.experimentalBackgroundSubagents
      ? messages().flatMap((message) =>
          (sync.data.part[message.id] ?? []).filter(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              part.state.metadata?.background !== true,
          ),
        )
      : [],
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLast((x) => x.role === "assistant" && x.time.completed)?.id
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed && (!completed || x.id > completed))
      ?.id
  })

  const dimensions = useTerminalDimensions()
  const [sidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [conceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps] = kv.signal<"hide" | "show">("timestamps", "show")
  const [showDetails] = kv.signal("tool_details_visibility", true)
  const [showScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [activitiesExpanded, setActivitiesExpanded] = createSignal(false)
  const [compacting, setCompacting] = createSignal<string>()
  createEffect(on(() => route.sessionID, () => setActivitiesExpanded(false)))

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const messageIndent = useMessageIndent()
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 7 - messageIndent())
  const providers = createMemo(() => Model.indexProviders(sync.data.provider))

  const toast = useToast()
  const sdk = useAgentClient()
  const editor = useEditorContext()
  const [agentRuns, setAgentRuns] = createSignal<AgentRun[]>([])
  const parentSessionID = createMemo(() => session()?.parentID ?? session()?.id)

  let agentRunsRequest = 0
  async function refreshAgentRuns(parentID = parentSessionID()) {
    if (!parentID) {
      setAgentRuns([])
      return
    }
    const request = ++agentRunsRequest
    try {
      const result = await sdk.client.experimental.session.agents({
        sessionID: parentID,
        workspace: project.workspace.current(),
      })
      if (request !== agentRunsRequest) return
      setAgentRuns(result.data?.agents ?? [])
    } catch {
      if (request === agentRunsRequest) setAgentRuns([])
    }
  }

  createEffect(() => {
    const parentID = parentSessionID()
    if (!parentID || session()?.parentID) {
      setAgentRuns([])
      return
    }
    const dependencies = [
      children()
        .map((child) => child.id)
        .join(","),
      foregroundTasks()
        .map((part) => `${part.id}:${part.state.status}`)
        .join(","),
      permissions()
        .map((permission) => permission.id)
        .join(","),
      questions()
        .map((question) => question.id)
        .join(","),
    ].join("|")
    void dependencies
    void refreshAgentRuns(parentID)
  })

  createEffect(() => {
    const sessionID = route.sessionID
    if (!sessionID) return
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    if (!route.sessionID) return
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  const bind = (r: PromptRef | undefined) => {
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const dialog = useDialog()
  const renderer = useRenderer()

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = messages().flatMap((message) => {
      const node = scroll.content.findDescendantById(message.id)
      return node instanceof BoxRenderable ? [node] : []
    })
    const messageIDs = new Set(messages().map((message) => message.id))
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id || !messageIDs.has(c.id)) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[c.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return visibleMessages.findLast((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.content.findDescendantById(targetID)
    if (child instanceof BoxRenderable) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(scrollTimer))
  function toBottom() {
    clearTimeout(scrollTimer)
    const sessionID = route.sessionID
    scrollTimer = setTimeout(() => {
      if (route.sessionID !== sessionID || !scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = usePreferences()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function openAgentManager() {
    const agents = agentRuns()
    if (agents.length === 0) {
      moveFirstChild()
      return
    }
    dialog.replace(() => (
      <SubagentDialog
        agents={agents}
        current={route.sessionID}
        onCancel={(sessionID) => {
          void sdk.client.experimental.agent
            .cancel({
              sessionID,
              workspace: project.workspace.current(),
            })
            .then(() => refreshAgentRuns())
            .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        }}
        onBackground={(sessionID) => {
          void sdk.client.experimental.agent
            .background({
              sessionID,
              workspace: project.workspace.current(),
            })
            .then(() => refreshAgentRuns())
            .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        }}
      />
    ))
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      enabled: !!route.sessionID,
      slash: {
        name: "compact",
      },
      run: async () => {
        const sessionID = route.sessionID
        if (!sessionID) return
        dialog.clear()
        if (compacting() || (sync.data.session_status[sessionID]?.type ?? "idle") !== "idle") {
          toast.show({ variant: "warning", message: "Wait for the current operation to finish before compacting" })
          return
        }
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "No model provider is available to summarize this session",
            duration: 3000,
          })
          return
        }
        setCompacting(sessionID)
        try {
          const result = await sdk.client.session.summarize({
            sessionID,
            modelID: selectedModel.modelID,
            providerID: selectedModel.providerID,
          }, { throwOnError: true })
          toast.show({ variant: result.data ? "success" : "info", message: result.data
            ? "Context compacted. ~ estimates conversation tokens until the next model response includes instructions and tools."
            : "No new conversation to compact" })
        } catch (error) {
          toast.show({ variant: "error", message: errorMessage(error) })
        } finally {
          setCompacting(undefined)
        }
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      enabled: !!route.sessionID,
      run: () => {
        if (!route.sessionID) return
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.content.findDescendantById(message.id)
            if (child instanceof BoxRenderable) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        openAgentManager()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      hidden: command.value !== "session.compact",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    commands: [{ name: "session.activities.toggle", title: "Expand / collapse exploration actions", hidden: true,
      run: () => setActivitiesExpanded((value) => !value) }],
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: PHINS_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <LocationProvider location={location()}>
      <ConversationContext.Provider
        value={{
          get width() {
            return contentWidth()
          },
          get indent() {
            return messageIndent()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          activitiesExpanded,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
        }}
      >
        <AgentLayout sessionID={route.sessionID} waiting={disabled()} compacting={!!route.sessionID && compacting() === route.sessionID}>
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
              <ConversationViewport ref={(value) => (scroll = value)} scrollbar={showScrollbar()}>
                <Show when={messages().length === 0}><AgentWelcome timestamp={session()?.time.created} /></Show>
                <Conversation
                  messages={messages()}
                  pending={pending()}
                  revert={revert()}
                  onSelect={(messageID) => {
                    const sessionID = route.sessionID
                    if (!sessionID || renderer.getSelection()?.getSelectedText()) return
                    dialog.replace(() => <DialogMessage messageID={messageID} sessionID={sessionID} />)
                  }}
                />
              </ConversationViewport>
              <box flexShrink={0}>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt
                    request={questions()[0]}
                    directory={sync.session.get(questions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID ?? ""}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID ?? ""} />}
                    />
                  </pluginRuntime.Slot>
                </Show>
              </box>
              <Toast />
            </box>
            <Show when={sidebarVisible()}>
              <Switch>
                <Match when={wide()}>
                  <Sidebar sessionID={route.sessionID} />
                </Match>
                <Match when={!wide()}>
                  <box
                    position="absolute"
                    top={0}
                    left={0}
                    right={0}
                    bottom={0}
                    alignItems="flex-end"
                    backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                  >
                    <Sidebar sessionID={route.sessionID} />
                  </box>
                </Match>
              </Switch>
            </Show>
          </box>
        </AgentLayout>
      </ConversationContext.Provider>
    </LocationProvider>
  )
}

