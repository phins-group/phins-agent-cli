import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import * as fuzzysort from "fuzzysort"
import { modelPriority, preferredNebiusModel, type ModelChoice } from "../../shared/model-info"
import type { SelectedModel } from "../../shared/provider-setup"
import { useTuiConfig } from "../config/settings"
import { formatKeyBindings, useBindings, useKeymapSelector } from "../state/keymap"
import { selectedForeground, useTheme } from "../theme/provider"
import { getScrollAcceleration } from "../platform/scroll"

export type ModelSelectProps = {
  options: ModelChoice[]
  current?: SelectedModel
  initial?: SelectedModel
  subtitle?: string
  loading?: boolean
  onSelect: (value: SelectedModel) => void
  onCancel: () => void
  onFavorite?: (value: SelectedModel) => void
}

const modelKey = (value: SelectedModel) => JSON.stringify([value.providerID, value.modelID])

// The model namespace describes its maker; the provider still owns routing.
const families: Record<string, { title: string; color: "info" | "success" | "primary" | "secondary" | "accent" | "warning" | "diffAdded" | "qwen" }> = {
  nvidia: { title: "NVIDIA", color: "success" },
  qwen: { title: "Qwen", color: "qwen" },
  deepseek: { title: "DeepSeek", color: "primary" },
  "deepseek-ai": { title: "DeepSeek", color: "primary" },
  moonshotai: { title: "Moonshot AI", color: "diffAdded" },
  openai: { title: "OpenAI", color: "secondary" },
  openbmb: { title: "OpenBMB", color: "warning" },
  "z-ai": { title: "Z.ai", color: "accent" },
  google: { title: "Google", color: "primary" },
}

export function modelGroup(option: ModelChoice) {
  const namespace = option.value.modelID.includes("/") ? option.value.modelID.split("/")[0]!.toLowerCase() : ""
  const family = families[namespace]
  const priority = modelPriority(option.value)
  const title = priority === 0 ? "NVIDIA Nemotron · Nebius"
    : priority === 1 ? "Other NVIDIA · Nebius"
    : priority === 2 ? "Other models · Nebius" : option.providerName
  return {
    id: `group:${JSON.stringify([option.value.providerID, priority])}`,
    title,
    shortTitle: priority === 0 ? "Nemotron · Nebius" : title,
    badge: family?.title ?? (namespace ? option.value.modelID.split("/")[0]! : option.providerName),
    color: priority < 2 ? "success" as const : "info" as const,
    badgeColor: family?.color ?? "secondary" as const,
    collapsed: priority >= 2,
  }
}

/** Shared by /models, /setup and the CLI setup model step. No provider calls. */
export function ModelSelect(props: ModelSelectProps) {
  const { theme, mode } = useTheme()
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [collapsed, setCollapsed] = createSignal(new Map<string, boolean>())
  const initial = props.initial ?? props.current ?? preferredNebiusModel(props.options)?.value
    ?? [...props.options].sort((a, b) => modelPriority(a.value) - modelPriority(b.value))[0]?.value
  const [active, setActive] = createSignal(initial ? modelKey(initial) : "")
  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let mouse = false
  let revealSelection = true
  const width = () => Math.min(96, dimensions().width - 2)
  const compact = () => width() < 88
  const narrow = () => width() < 48
  const short = () => dimensions().height < 32
  function groupColor(color: ReturnType<typeof modelGroup>["badgeColor"]) {
    if (color === "qwen") return mode() === "dark" ? "#b9a5f0" : "#6148a5"
    if (mode() === "light" && color === "success") return "#24783f"
    if (mode() === "light" && color === "warning") return "#946312"
    return theme[color]
  }
  const search = () => query().trim()
  const hasNebius = () => props.options.some((option) => option.value.providerID === "nebius")
  const priority = (a: ModelChoice, b: ModelChoice) => modelPriority(a.value) - modelPriority(b.value)
    || Number(!!b.recommended) - Number(!!a.recommended)
  const ordered = createMemo(() => {
    const preferred = preferredNebiusModel(props.options)
    return props.options.map((option) => ({ ...option, recommended: option === preferred }))
      .sort(priority)
  })
  const options = createMemo(() => {
    if (!search()) return ordered()
    const matches = new Set(fuzzysort.go(search(), ordered(), {
      keys: ["title", "value.modelID", "providerName"],
    }).map((item) => item.obj))
    return ordered().filter((option) => matches.has(option))
  })
  const groups = createMemo(() => {
    const result = new Map<string, ReturnType<typeof modelGroup> & { options: ModelChoice[] }>()
    for (const option of options()) {
      const group = modelGroup(option)
      const existing = result.get(group.id)
      if (existing) existing.options.push(option)
      else result.set(group.id, { ...group, options: [option] })
    }
    return [...result.values()]
  })
  const isCollapsed = (id: string) => {
    if (search()) return false
    const override = collapsed().get(id)
    if (override !== undefined) return override
    const group = groups().find((item) => item.id === id)
    return !!group?.collapsed && !group.options.some((option) =>
      (initial && modelKey(option.value) === modelKey(initial))
      || (props.current && modelKey(option.value) === modelKey(props.current)))
  }
  const rows = createMemo(() => groups().flatMap((group, index) => [
    ...(index ? [{ key: `space:${group.id}`, group, option: undefined as ModelChoice | undefined, spacer: true }] : []),
    { key: group.id, group, option: undefined as ModelChoice | undefined, spacer: false },
    ...(isCollapsed(group.id) ? [] : group.options.map((option) => ({ key: modelKey(option.value), group, option, spacer: false }))),
  ]))
  // Arrow navigation visits models, or a collapsed group that can be reopened.
  const choices = createMemo(() => rows().filter((row) => !row.spacer && (row.option || isCollapsed(row.group.id))))
  const selected = createMemo(() => choices().find((row) => row.key === active()))
  const keyBindings = useKeymapSelector((keymap) => keymap.getCommandBindings({
    visibility: "registered", commands: ["model.dialog.favorite", "dialog.select.submit"],
  }))
  const favoriteLabel = () => formatKeyBindings(keyBindings().get("model.dialog.favorite"), config) ?? ""
  const submitLabel = () => formatKeyBindings(keyBindings().get("dialog.select.submit"), config) ?? ""
  const footerRows = () => narrow() ? (props.onFavorite ? 3 : 2) : compact() ? 2 : 1
  const listHeight = () => Math.max(1, Math.min(Math.max(rows().length, 3),
    dimensions().height - 2 - (short() ? 11 : 16) - footerRows() - (compact() ? 1 : 0)))

  createEffect(() => {
    const available = choices()
    if (!available.some((row) => row.key === active())) setActive(available[0]?.key ?? "")
  })
  createEffect(() => {
    rows()
    active()
    revealSelection = true
  })
  onCleanup(() => input?.blur())

  function filter(value: string) {
    mouse = false
    setQuery(value)
    setActive(choices()[0]?.key ?? "")
    scroll?.scrollTo(0)
  }
  function move(amount: number) {
    mouse = false
    const list = choices()
    if (!list.length) return
    const index = Math.max(0, list.findIndex((row) => row.key === active()))
    setActive(list[(index + amount % list.length + list.length) % list.length]!.key)
  }
  function toggleGroup(id: string) {
    if (search()) return
    const close = !isCollapsed(id)
    setCollapsed((previous) => {
      const next = new Map(previous)
      next.set(id, close)
      return next
    })
    setActive(close ? id : rows().find((row) => row.group.id === id && row.option)?.key ?? "")
    input?.focus()
  }
  function submit() {
    const row = selected()
    if (!row) return
    if (row.option) props.onSelect(row.option.value)
    else toggleGroup(row.group.id)
  }
  function favorite() {
    const option = selected()?.option
    if (option) props.onFavorite?.(option.value)
  }
  const commands = [
    { name: "dialog.select.prev", title: "Previous model", run: () => move(-1) },
    { name: "dialog.select.next", title: "Next model", run: () => move(1) },
    { name: "dialog.select.page_up", title: "Previous page", run: () => move(-listHeight()) },
    { name: "dialog.select.page_down", title: "Next page", run: () => move(listHeight()) },
    { name: "dialog.select.home", title: "First model", run: () => setActive(choices()[0]?.key ?? "") },
    { name: "dialog.select.end", title: "Last model", run: () => setActive(choices().at(-1)?.key ?? "") },
    { name: "dialog.select.submit", title: "Select model", run: submit },
  ]
  useBindings(() => ({
    commands: [...commands, ...(props.onFavorite ? [{ name: "model.dialog.favorite", title: "Favorite", run: favorite }] : [])],
    bindings: [
      ...config.keybinds.gather("dialog.select", commands.map((item) => item.name)),
      ...(props.onFavorite ? config.keybinds.get("model.dialog.favorite") : []),
      { key: "escape", cmd: props.onCancel },
      { key: "ctrl+c", cmd: props.onCancel },
      ...(!query() ? [
        { key: "/", cmd: () => { input?.focus() } },
        { key: "left", cmd: () => { const row = selected(); if (row?.option) toggleGroup(row.group.id) } },
        { key: "right", cmd: () => { const row = selected(); if (row && !row.option) toggleGroup(row.group.id) } },
      ] : []),
    ],
  }))

  function KeyHint(hint: { label: string; title: string; action?: () => void }) {
    return <box flexDirection="row" gap={1} onMouseUp={hint.action}>
      <text fg={theme.text} bg={theme.backgroundElement}> {hint.label} </text>
      <text fg={theme.textMuted}>{hint.title}</text>
    </box>
  }
  function GroupHeader(item: { row: ReturnType<typeof rows>[number] }) {
    const group = () => item.row.group
    const focused = () => active() === item.row.key
    const color = () => focused() ? selectedForeground(theme) : groupColor(group().color)
    return <box id={`model-group-${item.row.key}`} height={1} flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}
      backgroundColor={focused() ? theme.primary : undefined} onMouseUp={() => toggleGroup(group().id)}>
      <text fg={color()} width={1} flexShrink={0}>{isCollapsed(group().id) ? "▸" : "▾"}</text>
      <text fg={color()} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexShrink={0} maxWidth={width() - 16}>
        {narrow() ? group().shortTitle : group().title}
      </text>
      <text fg={focused() ? color() : theme.borderSubtle} width={1} flexGrow={1} wrapMode="none" overflow="hidden">{"─".repeat(96)}</text>
      <text fg={color()} flexShrink={0}>[{group().options.length}]</text>
    </box>
  }
  function ModelRow(item: { option: ModelChoice; rowKey: string }) {
    const focused = () => active() === item.rowKey
    const current = () => !!props.current && modelKey(props.current) === item.rowKey
    const fg = () => focused() ? selectedForeground(theme) : theme.text
    const group = () => modelGroup(item.option)
    return <box id={`model-row-${item.rowKey}`} height={1} flexDirection="row" gap={1} paddingLeft={2} paddingRight={1}
      backgroundColor={focused() ? theme.primary : undefined}
      onMouseMove={() => { mouse = true }}
      onMouseOver={() => { if (mouse) setActive(item.rowKey) }}
      onMouseUp={() => props.onSelect(item.option.value)}>
      <text fg={fg()} flexShrink={0}>{focused() ? ">" : " "}</text>
      <text fg={focused() ? fg() : current() ? theme.primary : theme.borderActive} flexShrink={0}>{current() ? "●" : "○"}</text>
      <text fg={fg()} attributes={focused() ? TextAttributes.BOLD : undefined} flexGrow={1} wrapMode="none" truncate>
        {item.option.title}{item.option.recommended && !narrow() ? " (recommended)" : ""}
      </text>
      <Show when={item.option.favorite}><text fg={fg()} flexShrink={0}>★</text></Show>
      <Show when={!narrow()}>
        <text fg={groupColor(group().badgeColor)} bg={theme.backgroundElement} flexShrink={0}
          maxWidth={Math.min(22, Math.floor(width() / 3))} wrapMode="none" truncate>
          {` ${group().badge === "Nebius Token Factory" ? "Nebius" : group().badge} `}
        </text>
      </Show>
    </box>
  }

  return <box id="model-select" border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.backgroundPanel}>
    <box paddingLeft={2} paddingRight={2} paddingTop={short() ? 0 : 1} paddingBottom={short() ? 0 : 1} border={["bottom"]} borderColor={theme.borderSubtle}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}><span style={{ fg: theme.primary }}>◇ </span>Select model</text>
        <text fg={theme.textMuted} onMouseUp={props.onCancel}>{compact() ? "ESC" : "ESC to close"}</text>
      </box>
      <text fg={theme.textMuted} wrapMode="none" truncate>{props.subtitle ?? (hasNebius()
        ? compact() ? "Nebius × NVIDIA" : "Nebius Token Factory · NVIDIA Nemotron"
        : "Choose the model for your session")}</text>
    </box>
    <box marginLeft={2} marginRight={2} marginTop={short() ? 0 : 1} marginBottom={1} border borderColor={theme.primary} height={3} flexDirection="row" paddingLeft={1} paddingRight={1} gap={1}>
      <text fg={theme.primary}>⌕</text>
      <input id="model-search" flexGrow={1}
        ref={(field) => {
          input = field
          field.traits = { status: "FILTER" }
          const timer = setTimeout(() => { if (!field.isDestroyed) field.focus() }, 1)
          onCleanup(() => clearTimeout(timer))
        }}
        onInput={filter} onMouseUp={() => input?.focus()}
        placeholder={compact() || !hasNebius() ? "Search models..." : "Search models... (e.g. Nemotron, NVIDIA, Nebius)"}
        placeholderColor={theme.textMuted} textColor={theme.text} focusedTextColor={theme.text}
        backgroundColor={theme.backgroundPanel} focusedBackgroundColor={theme.backgroundPanel} cursorColor={theme.primary}
      />
    </box>
    <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} height={listHeight()}
      onSizeChange={() => { revealSelection = true }} renderAfter={() => {
        if (!revealSelection || !scroll) return
        revealSelection = false
        const index = rows().findIndex((row) => row.key === active())
        if (index < 0) return
        if (index <= 1) scroll.scrollTo(0)
        else if (index < scroll.scrollTop) scroll.scrollTo(index)
        else if (index >= scroll.scrollTop + scroll.height) scroll.scrollTo(index - scroll.height + 1)
      }}
      marginLeft={1} marginRight={1} scrollbarOptions={{ visible: false }} scrollAcceleration={getScrollAcceleration(config)}>
      <For each={rows()}>{(row) => row.spacer ? <box height={1} /> : row.option ? <ModelRow option={row.option} rowKey={row.key} /> : <GroupHeader row={row} />}</For>
      <Show when={!rows().length}>
        <text paddingLeft={2} fg={theme.textMuted}>{props.loading ? "Loading provider models…" : "No models match your search"}</text>
      </Show>
    </scrollbox>
    <box paddingLeft={2} paddingRight={2} marginTop={1} border={["top"]} borderColor={theme.borderSubtle}>
      <Show when={compact()}>
        <text fg={theme.textMuted} wrapMode="none" truncate>{selected()?.option?.value.modelID ?? "← → Collapse / expand group"}</text>
      </Show>
      <box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0} paddingTop={short() ? 0 : 1} paddingBottom={short() ? 0 : 1}>
        <KeyHint label={submitLabel()} title="Select" action={submit} />
        <KeyHint label="↑ ↓" title="Navigate" />
        <KeyHint label="/" title="Search" action={() => input?.focus()} />
        <Show when={props.onFavorite}><KeyHint label={favoriteLabel()} title={selected()?.option?.favorite ? "Unfavorite" : compact() ? "Favorite" : "Add to favorite"} action={favorite} /></Show>
        <Show when={props.current}><text fg={theme.textMuted}><span style={{ fg: theme.primary }}>● </span>Current</text></Show>
        <Show when={props.loading}><text fg={theme.textMuted}>Refreshing…</text></Show>
      </box>
    </box>
  </box>
}
