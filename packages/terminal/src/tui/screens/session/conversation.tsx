import type { Message } from "@phins/engine/transport/client/create"
import { groupWorkMessages, groupWorkParts } from "./work-turn"
import { MessageHeading, SectionHeading } from "../../components/layout"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { useNavigation } from "../../state/navigation"
import { useSessionState } from "../../state/sessions"
import { useTuiTerminalEnvironment } from "../../state/environment"
import { Spinner } from "../../components/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../theme/provider"
import { BoxRenderable, TextAttributes, RGBA } from "@opentui/core"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@phins/engine/transport/client/create"
import { usePreferences } from "../../state/preferences"
import { Locale } from "../../render/locale"
import { webSearchProviderLabel } from "../../render/tools"
import { useRenderer, type JSX } from "@opentui/solid"
import { useDialog } from "../../components/dialog"
import { DialogAlert } from "../../components/dialog-alert"
import { TodoItem } from "../../components/todo-item"
import { filetype } from "../../render/filetype"
import stripAnsi from "strip-ansi"
import { normalizePath } from "../../platform/paths"
import { setPreLayoutSiblingMargin } from "../../components/spacing"
import { useTuiConfig } from "../../config/settings"
import { reasoningSummary, type ThinkingMode } from "../../render/thinking"
import { collapseToolOutput } from "../../render/tool-output"
import { useCommandShortcut } from "../../state/keymap"
import { usePathFormatter } from "../../state/paths"
import { renderTranscriptSummary, turnEvidence } from "./transcript-summary"

export const alwaysSeparate = new WeakSet<BoxRenderable>()

export const ConversationContext = createContext<{
  width: number
  indent: number
  sessionID?: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  activitiesExpanded: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSessionState>
  tui: ReturnType<typeof useTuiConfig>
}>()

function useConversation() {
  const ctx = useContext(ConversationContext)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

/** Group adjacent replies without changing the chronological session record. */
export function Conversation(props: {
  messages: Message[]
  pending?: string
  revert?: { messageID: string; reverted: unknown[]; diffFiles?: { filename: string; additions: number; deletions: number }[] }
  onSelect: (messageID: string) => void
}) {
  const ctx = useConversation()
  const { theme } = useTheme()
  const visible = createMemo(() => props.messages.filter((message) => !props.revert || message.id < props.revert.messageID))
  const messages = createMemo(() => new Map(visible().map((message) => [message.id, message])))
  const groups = createMemo(() => new Map(groupWorkMessages(visible()).map((group) => [group.id, group])))
  return <>
    <For each={[...groups().keys()]}>{(id, index) => {
      const group = () => groups().get(id)!
      return <Switch>
        <Match when={group().role === "user"}>
          <UserMessage message={messages().get(id) as UserMessage} parts={ctx.sync.data.part[id] ?? []}
            index={index()} pending={props.pending} onMouseUp={() => props.onSelect(id)} />
        </Match>
        <Match when={group().role === "assistant"}>
          <WorkTurn messages={group().messageIDs.map((key) => messages().get(key) as AssistantMessage)} />
        </Match>
      </Switch>
    }}</For>
    <Show when={props.revert && props.messages.some((message) => message.id === props.revert!.messageID)}>
      <box marginTop={1} paddingLeft={2} border={["left"]} borderColor={theme.borderSubtle} flexShrink={0}>
        <text fg={theme.textMuted}>{props.revert!.reverted.length} messages previously reverted</text>
        <For each={props.revert!.diffFiles}>{(file) => <text fg={theme.text}>
          {file.filename}
          <Show when={file.additions > 0}><span style={{ fg: theme.diffAdded }}> +{file.additions}</span></Show>
          <Show when={file.deletions > 0}><span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span></Show>
        </text>}</For>
      </box>
    </Show>
  </>
}

function WorkTurn(props: { messages: AssistantMessage[] }) {
  const ctx = useConversation()
  const { theme } = useTheme()
  const indent = () => ctx.indent
  const messages = createMemo(() => new Map(props.messages.map((message) => [message.id, message])))
  const last = () => props.messages.at(-1)!
  const parts = createMemo(() => props.messages.flatMap((message) => ctx.sync.data.part[message.id] ?? []))
  const finished = () => !!last().finish && !["tool-calls", "unknown"].includes(last().finish!)
  const showResult = () => !!last().error || (finished() && !isTaskOnlyAssistantTurn(parts()))
  const duration = createMemo(() => {
    if (!last().time.completed) return
    const request = ctx.sync.data.message[last().sessionID]?.find((message) => message.id === last().parentID)
    return request ? Locale.duration(Math.max(0, last().time.completed! - request.time.created)) : undefined
  })
  const evidence = createMemo(() => turnEvidence(parts()))
  const summary = createMemo(() => renderTranscriptSummary({ parts: parts(), error: last().error, duration: duration() }))
  const checks = createMemo(() => evidence().edits ? evidence().commands.filter((command) => command.afterLatestEdit) : [])
  const childShortcut = useCommandShortcut("session.child.first")
  return <box marginTop={1} flexShrink={0}>
    <MessageHeading role="PHINs" timestamp={ctx.showTimestamps() ? props.messages[0]?.time.created : undefined} />
    <box marginLeft={indent()} border={["left"]} borderColor={theme.borderSubtle} flexShrink={0}>
      <For each={[...messages().keys()]}>{(id) => <AssistantMessage
        message={messages().get(id)!} parts={ctx.sync.data.part[id] ?? []} />}</For>
      <Show when={parts().some((part) => part.type === "tool" && part.tool === "task")}>
        <text paddingLeft={3} fg={theme.textMuted}>{childShortcut()} view subagents</text>
      </Show>
      <Show when={showResult()}>
        <Show when={evidence().edits}>
          <box marginTop={1} flexShrink={0}>
            <SectionHeading icon="◇">Checks</SectionHeading>
            <box paddingLeft={3} flexShrink={0}>
              <Show when={checks().length} fallback={<text fg={theme.warning}>No command after the latest edit.</text>}>
                <For each={checks()}>{(check) => <text fg={check.timedOut || (check.exitCode !== undefined && check.exitCode !== 0) ? theme.error : theme.text}>
                  {check.command} · {check.timedOut ? "timed out" : check.exitCode === undefined ? "outcome unknown" : `exit ${check.exitCode}`}
                </text>}</For>
              </Show>
              <text fg={theme.textMuted}>Command outcomes only · code verification unverified</text>
            </box>
          </box>
        </Show>
        <box marginTop={1} flexShrink={0}>
          <SectionHeading icon="=">Result</SectionHeading>
          <box paddingLeft={3} flexShrink={0}>
            <text fg={summary().kind === "failed" ? theme.error : last().error?.name === "MessageAbortedError" ? theme.warning
              : summary().kind === "unverified" ? theme.text : theme.success}>
              {summary().label}
            </text>
            <Show when={summary().details.length}><text fg={theme.textMuted}>{summary().details.join(" · ")}</text></Show>
          </box>
        </box>
      </Show>
    </box>
  </box>
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = useConversation()
  const indent = () => ctx.indent
  const local = usePreferences()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <MessageHeading role="You" timestamp={ctx.showTimestamps() ? props.message.time.created : undefined} />
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            marginLeft={indent()}
            paddingLeft={0}
            paddingRight={1}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show when={queued()}>
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[] }) {
  const ctx = useConversation()
  const { theme } = useTheme()
  const parts = createMemo(() => new Map(props.parts.map((part) => [part.id, part])))
  const groups = createMemo(() => new Map(groupWorkParts(props.parts).map((group) => [group.id, group])))
  const firstAction = () => props.parts.find((part) => part.type === "tool" && part.tool !== "todowrite")?.id
  return <box id={props.message.id} flexShrink={0}>
    <For each={[...groups().keys()]}>{(id) => {
      const group = () => groups().get(id)!
      return <>
        <Show when={ctx.showDetails() && firstAction() === id}>
          <box marginTop={1} flexShrink={0}><SectionHeading icon="›">Actions</SectionHeading></box>
        </Show>
        <Show when={group().exploration && group().partIDs.length > 1} fallback={
          <MessagePart part={parts().get(id)!} message={props.message} />
        }>
          <ExplorationGroup parts={group().partIDs.map((key) => parts().get(key)!)} message={props.message} />
        </Show>
      </>
    }}</For>
    <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
      <box border={["left"]} borderColor={theme.error} paddingLeft={2} marginTop={1} flexShrink={0}>
        <text fg={theme.error}>{stringValue(props.message.error?.data.message)}</text>
      </box>
    </Show>
  </box>
}

function MessagePart(props: { part: Part; message: AssistantMessage }) {
  const component = () => PART_MAPPING[props.part.type as keyof typeof PART_MAPPING]
  return <Show when={component()}>
    <Dynamic component={component()} part={props.part as any} message={props.message} />
  </Show>
}

function ExplorationGroup(props: { parts: Part[]; message: AssistantMessage }) {
  const ctx = useConversation()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const shortcut = useCommandShortcut("session.activities.toggle")
  const [expanded, setExpanded] = createSignal(ctx.activitiesExpanded())
  createEffect(on(ctx.activitiesExpanded, setExpanded))
  const parts = createMemo(() => new Map(props.parts.map((part) => [part.id, part])))
  return <Show when={ctx.showDetails()}>
    <box flexShrink={0}>
      <box paddingLeft={3} onMouseUp={() => {
        if (!renderer.getSelection()?.getSelectedText()) setExpanded((value) => !value)
      }}>
        <text fg={theme.secondary}>{expanded() ? "▾" : "▸"} Explore · {props.parts.length} completed actions
          <span style={{ fg: theme.textMuted }}> · {shortcut()} details</span>
        </text>
      </box>
      <Show when={expanded()}>
        <For each={[...parts().keys()]}>{(id) => <MessagePart part={parts().get(id)!} message={props.message} />}</For>
      </Show>
    </box>
  </Show>
}

export function isTaskOnlyAssistantTurn(parts: readonly Part[]) {
  const meaningful = parts.filter((part) => {
    if (part.type === "reasoning") return false
    if (part.type === "text") return part.text.trim().length > 0
    return true
  })

  return meaningful.length > 0 && meaningful.every((part) => part.type === "tool" && part.tool === "task")
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

function ReasoningPart(props: { part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = useConversation()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

  const toggle = () => {
    if (!inMinimal()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal()}
            open={!inMinimal() || expanded()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
          />
        </box>
        <Show when={(!inMinimal() || expanded()) && summary().body}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <Show when={props.toggleable}>
            <span>{props.open ? "- " : "+ "}</span>
          </Show>
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { part: TextPart; message: AssistantMessage }) {
  const ctx = useConversation()
  const { theme, syntax } = useTheme()
  const content = createMemo(() => normalizeMarkdownForTui(props.part.text.trim()))
  const task = createMemo(() => /^#{1,6}\s+Task\s*\n/i.test(content()))
  const body = createMemo(() => task() ? content().replace(/^#{1,6}\s+Task\s*\n+/i, "") : content())
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} flexShrink={0}>
        <Show when={task()}><SectionHeading icon="◎">Task</SectionHeading></Show>
        <box paddingLeft={3} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={body()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
        </box>
      </box>
    </Show>
  )
}

export function normalizeMarkdownForTui(input: string) {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/([^\n])(```+)/g, "$1\n$2")
    .replace(/([A-Za-z0-9_`)\]|])(?=#{1,6}\s+\S)/g, "$1\n\n")
    .replace(/([^\n])\n(#{1,6}\s+\S)/g, "$1\n\n$2")
    .replace(/([^\n])\n((?:\|[^\n]*\|\n\|[\s:|.-]+\|))/g, "$1\n\n$2")
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { part: ToolPart; message: AssistantMessage }) {
  const ctx = useConversation()
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={display() === "bash"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={display() === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = useConversation()
  const output = createMemo(() => props.output?.trim() ?? "")
  const showOutput = createMemo(() => Boolean(output() && ctx.showGenericToolOutput()))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  createEffect(on(ctx.activitiesExpanded, setExpanded))
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Show
      when={showOutput()}
      fallback={
        <InlineTool
          icon="⚙"
          pending="Writing command..."
          complete={true}
          part={props.part}
        >
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = useConversation()
  const sync = useSessionState()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(true)

  const permission = createMemo(() => {
    if (!ctx.sessionID) return false
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.primary
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.part.state.status === "completed" ? "✓" : props.part.state.status === "error" ? "✕" : props.icon}
      iconColor={props.part.state.status === "completed" ? theme.success
        : props.part.state.status === "error" ? theme.error : props.iconColor ?? theme.primary}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  output?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      marginTop={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <box flexDirection="row" flexShrink={0}>
            <Show when={props.spinner} fallback={
              <SectionHeading icon="▤">{title().replace(/^# /, "")}</SectionHeading>
            }>
              <Spinner color={theme.primary}>{title().replace(/^# /, "")}</Spinner>
            </Show>
            <Show when={props.output}>
              <box flexGrow={1} minWidth={0} height={1} marginLeft={1}
                border={["top"]} borderColor={theme.borderSubtle} />
            </Show>
          </box>
        )}
      </Show>
      <box
        border={props.output ? ["left", "right", "bottom"] : false}
        borderColor={theme.borderSubtle}
        marginLeft={props.output ? 3 : 0}
        paddingLeft={props.output ? 0 : 3}
        paddingRight={props.output ? 1 : 0}
        flexShrink={0}
      >
        {props.children}
        <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      </box>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = useConversation()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output)?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  createEffect(on(ctx.activitiesExpanded, setExpanded))
  const maxLines = 6
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    const formatted = pathFormatter.format(workdir)
    if (formatted === ".") return undefined
    return formatted
  })

  const title = createMemo(() => {
    const wd = workdirDisplay()
    return wd ? `Output · ${wd}` : "Output"
  })

  return (
    <Switch>
      <Match when={stringValue(props.metadata.output) !== undefined}>
        <BlockTool
          output
          title={title()}
          part={props.part}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={0}>
            <Show when={isRunning()} fallback={<text fg={theme.text}>$ {stringValue(props.input.command)}</text>}>
              <Spinner color={theme.text}>{stringValue(props.input.command)}</Spinner>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={stringValue(props.input.command)} part={props.part}>
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const filePath = createMemo(() => stringValue(props.input.path) ?? stringValue(props.input.filePath))
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + pathFormatter.format(filePath())} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(filePath())}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath() ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing write..."
          complete={filePath()}
          part={props.part}
        >
          Write {pathFormatter.format(filePath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const filePath = createMemo(() => stringValue(props.input.path) ?? stringValue(props.input.filePath))
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={filePath()}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(filePath())} {input(props.input, ["path", "filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useNavigation()
  const sync = useSessionState()
  const dialog = useDialog()

  onMount(() => {
    const sessionID = stringValue(props.metadata.sessionId)
    if (sessionID && !sync.data.message[sessionID]?.length) void sync.session.sync(sessionID)
  })

  const sessionID = createMemo(() => stringValue(props.metadata.sessionId))
  const messages = createMemo(() => sync.data.message[sessionID() ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    const value = status()
    return (
      props.part.state.status === "running" ||
      (props.metadata.background === true && value !== undefined && value.type !== "idle")
    )
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    let content = [
      formatSubagentTitle(
        Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
        description,
        props.metadata.background === true,
      ),
    ]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      content.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      separate={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

function Edit(props: ToolProps) {
  const ctx = useConversation()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const filePath = createMemo(() => stringValue(props.input.path) ?? stringValue(props.input.filePath))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filePath()))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool title={"← Edit " + pathFormatter.format(filePath())} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath() ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={filePath()} part={props.part}>
          Edit {pathFormatter.format(filePath())} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = useConversation()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <box marginTop={1} flexShrink={0}>
          <SectionHeading icon="▤">Plan</SectionHeading>
          <box paddingLeft={4}>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Updating todos..."
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
