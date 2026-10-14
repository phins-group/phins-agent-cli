import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/provider"
import { usePreferences } from "../state/preferences"
import { useSessionState } from "../state/sessions"
import { useTuiPaths } from "../state/environment"
import { useProject } from "../state/project"
import { useTagline } from "../theme/tagline"
import { Locale } from "../render/locale"
import { modelPricing } from "../transport/mapping"
import { usageCost } from "@phins/engine/sessions/usage/cost"
import { contextUsage, totalTokens } from "../render/context-usage"

/** Shared CLI chrome; all status and usage values come from the current session. */
export function AgentLayout(props: {
  sessionID?: string
  waiting?: boolean
  compacting?: boolean
  children: JSX.Element
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const local = usePreferences()
  const sync = useSessionState()
  const paths = useTuiPaths()
  const project = useProject()
  const tagline = useTagline()
  const session = createMemo(() => props.sessionID ? sync.session.get(props.sessionID) : undefined)
  const messages = createMemo(() => sync.data.message[props.sessionID ?? ""] ?? [])
  const latest = createMemo(() => messages().at(-1))
  const status = createMemo(() => {
    if (!sync.ready) return { label: "Loading", color: theme.textMuted }
    if (props.waiting) return { label: "Needs input", color: theme.warning }
    if (props.compacting) return { label: "Compacting", color: theme.info }
    const state = sync.data.session_status[props.sessionID ?? ""]?.type
    if (state === "retry") return { label: "Retrying", color: theme.warning }
    if (state === "busy") return { label: "Running", color: theme.info }
    const message = latest()
    if (message?.role === "assistant" && message.error)
      return { label: message.error.name === "MessageAbortedError" ? "Stopped" : "Error", color: theme.error }
    return { label: "Ready", color: theme.success }
  })
  const usage = createMemo(() => {
    const value = contextUsage(messages(), sync.data.part)
    const selected = value.model ?? local.model.current()
    const model = sync.data.provider.find((p) => p.id === selected?.providerID)?.models[selected?.modelID ?? ""]
    return { ...value, context: value.tokens > 0 && model?.limit.context
      ? Math.round(value.tokens / model.limit.context * 100) : undefined }
  })
  const directory = createMemo(() => session()?.directory ?? (project.instance.directory() || paths.cwd))
  const cost = createMemo(() => {
    let total = 0
    for (const message of messages()) {
      if (message.role !== "assistant" || totalTokens(message.tokens) === 0) continue
      const model = sync.data.provider.find((p) => p.id === message.providerID)?.models[message.modelID]
      // Older sessions recorded zero despite real usage. Estimate those from
      // current catalog rates without rewriting their persisted history.
      const value = message.cost > 0 ? message.cost : usageCost(message.tokens, modelPricing(model))
      if (value === undefined) return "—"
      total += value
    }
    const value = Math.max(session()?.cost ?? 0, total)
    return value > 0 && value < 0.0001 ? "<0.0001" : `~${value.toFixed(4)}`
  })

  return (
    <box flexGrow={1} minHeight={0} border borderColor={theme.borderSubtle}>
      <box height={2} flexShrink={0} border={["bottom"]} borderColor={theme.borderSubtle}
        paddingLeft={1} paddingRight={1} flexDirection="row" alignItems="center" gap={2}>
        <text flexShrink={0} fg={theme.text}>
          <span style={{ fg: status().color }}>●</span> <b>PHINs Agent</b>
        </text>
        <Show when={dimensions().width >= 140}>
          <text fg={theme.secondary} flexShrink={0}>{tagline.text()}</text>
        </Show>
        <box flexGrow={1} minWidth={0} alignItems="flex-end">
          <text fg={theme.primary} wrapMode="none" truncate>
            ◇ <Show when={local.model.current()} fallback="/setup to select a model">
              <b>{local.model.parsed().model}</b>{" "}
              <span style={{ fg: theme.textMuted }}>({local.model.parsed().provider})</span>
              <Show when={local.model.variant.current()}>
                <span style={{ fg: theme.syntaxType }}> · {local.model.variant.current()}</span>
              </Show>
            </Show>
          </text>
        </box>
        <Show when={dimensions().width >= 100}>
          <text fg={theme.syntaxType} flexShrink={0}>
            <span style={{ fg: theme.border }}>│</span>{" "}
            <span style={{ fg: theme.primary }}>&lt;/&gt;</span>{" "}
            <b>{local.agent.current()?.name ?? "setup"}</b> mode
          </text>
        </Show>
      </box>
      {props.children}
      <box flexShrink={0} height={2} border={["top"]} borderColor={theme.borderSubtle}
        flexDirection="row" paddingLeft={1} paddingRight={1} gap={2}>
        <text fg={status().color} flexShrink={0}>● {status().label}</text>
        <box flexGrow={1} minWidth={0}>
          <text fg={theme.secondary} wrapMode="none" truncate>📂 {directory()}</text>
        </box>
        <Show when={dimensions().width >= 70}>
          <text fg={theme.secondary} flexShrink={0}>
            <span style={{ fg: theme.border }}>│ </span>
            <span style={{ fg: theme.primary }}>#</span> Tokens:{" "}
            <span style={{ fg: theme.text }}>{usage().estimated ? "~" : ""}{Locale.number(usage().tokens)}</span>
            <span style={{ fg: theme.border }}> │ </span>
            <span style={{ fg: theme.primary }}>%</span> Context:{" "}
            <span style={{ fg: theme.text }}>{usage().context === undefined ? "—"
              : `${usage().estimated ? "~" : ""}${usage().context}%`}</span>
          </text>
        </Show>
        <Show when={dimensions().width >= 50}>
          <text fg={theme.secondary} flexShrink={0}>
            <span style={{ fg: theme.border }}>│ </span>
            <span style={{ fg: theme.primary }}>$</span> Cost:{" "}
            <span style={{ fg: theme.text }}>{cost()}</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

export function useMessageIndent() {
  const dimensions = useTerminalDimensions()
  return () => dimensions().width >= 60 ? 2 : 0
}

export function MessageHeading(props: { role: "You" | "PHINs"; timestamp?: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={props.role === "You" ? theme.syntaxType : theme.primary} width={7} flexShrink={0}><b>{props.role}</b></text>
      <Show when={props.timestamp !== undefined}>
        <text fg={theme.secondary}>{Locale.todayTimeOrDateTime(props.timestamp!)}</text>
      </Show>
    </box>
  )
}

export function SectionHeading(props: { icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={theme.primary} width={3} flexShrink={0}>{props.icon}</text>
      <text fg={theme.primary}><b>{props.children}</b></text>
    </box>
  )
}

export function AgentWelcome(props: { timestamp?: number }) {
  const { theme } = useTheme()
  const indent = useMessageIndent()
  const openedAt = Date.now()
  return (
    <box paddingTop={1} paddingBottom={1} flexShrink={0}>
      <MessageHeading role="PHINs" timestamp={props.timestamp ?? openedAt} />
      <box paddingLeft={indent()} flexShrink={0}>
        <text fg={theme.text}>Hi! I’m <span style={{ fg: theme.warning }}>PHINs</span>, your AI developer agent.</text>
        <text fg={theme.text}>I can analyze code, make changes, run commands, and help you ship faster.</text>
        <text fg={theme.text} marginTop={1}>What would you like to work on?</text>
      </box>
    </box>
  )
}
