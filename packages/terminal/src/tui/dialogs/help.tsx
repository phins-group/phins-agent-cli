import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, For, Show } from "solid-js"
import { useTheme } from "../theme/provider"
import { useDialog } from "../components/dialog"
import { useBindings, useCommandShortcut, useCommandSlashes } from "../state/keymap"
import { useKV } from "../state/kv"
import { useTagline } from "../theme/tagline"
import { useSessionState } from "../state/sessions"
import { useAgentClient } from "../state/agent-client"
import { nextThinkingMode, useThinkingMode } from "../render/thinking"
import { DialogSelect } from "../components/dialog-select"
import { ThemePickerDialog } from "./theme-picker"
import { McpStatusDialog } from "./mcp"
import { SkillPickerDialog } from "./skill"

function DisplayOptions() {
  const dialog = useDialog()
  const kv = useKV()
  const theme = useTheme()
  const thinking = useThinkingMode()
  const tagline = useTagline()
  return <DialogSelect title="Display options" renderFilter={false} options={[
    { title: "Theme", value: "theme", onSelect: () => dialog.replace(() => <ThemePickerDialog />) },
    { title: theme.mode() === "dark" ? "Switch to light mode" : "Switch to dark mode", value: "mode",
      onSelect: () => theme.setMode(theme.mode() === "dark" ? "light" : "dark") },
    { title: thinking.mode() === "hide" ? "Expand thinking" : "Collapse thinking", value: "thinking",
      onSelect: () => thinking.set(nextThinkingMode(thinking.mode())) },
    { title: kv.get("timestamps", "show") === "show" ? "Hide timestamps" : "Show timestamps", value: "timestamps",
      onSelect: () => kv.set("timestamps", kv.get("timestamps", "show") === "show" ? "hide" : "show") },
    { title: kv.get("sidebar", "hide") === "hide" ? "Show sidebar on wide screens" : "Hide sidebar", value: "sidebar",
      onSelect: () => kv.set("sidebar", kv.get("sidebar", "hide") === "hide" ? "auto" : "hide") },
    { title: kv.get("tool_details_visibility", true) ? "Hide tool details" : "Show tool details", value: "tools",
      onSelect: () => kv.set("tool_details_visibility", !kv.get("tool_details_visibility", true)) },
    { title: tagline.language() === "vi" ? "Switch tagline to English" : "Switch tagline to Tiếng Việt", value: "tagline",
      onSelect: () => tagline.set(tagline.language() === "vi" ? "en" : "vi") },
  ]} />
}

export function HelpDialog(props: { onSelectSkill: (name: string) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const sync = useSessionState()
  const sdk = useAgentClient()
  const slashes = useCommandSlashes()
  const commandShortcut = useCommandShortcut("command.palette.show")
  const newlineShortcut = useCommandShortcut("input.newline")
  const [skills] = createResource(() => sdk.client.app.skills({}, { throwOnError: true })
    .then((result) => result.data?.filter((skill) => !skill.location.startsWith("/builtin/")) ?? [])
    .catch(() => []))
  const display = () => dialog.replace(() => <DisplayOptions />)
  const mcp = () => dialog.replace(() => <McpStatusDialog />)
  const selectSkill = () => dialog.replace(() => <SkillPickerDialog onSelect={props.onSelectSkill} />)
  useBindings(() => ({ bindings: [
    { key: "return", desc: "Close help", cmd: () => dialog.clear() },
    { key: "ctrl+t", desc: "Display options", cmd: display },
    ...(Object.keys(sync.data.mcp).length ? [{ key: "ctrl+g", desc: "Configured MCPs", cmd: mcp }] : []),
    ...(skills()?.length ? [{ key: "ctrl+s", desc: "Project skills", cmd: selectSkill }] : []),
  ] }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>PHINs Agent help</text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>esc/enter</text>
      </box>
      <scrollbox height={Math.max(4, Math.min(slashes().length, dimensions().height - Math.floor(dimensions().height / 4) - 10))}>
        <For each={slashes()}>{(command) => (
          <box flexDirection="row">
            <text fg={theme.primary} width={12}>{command.display}</text>
            <text fg={theme.text}>{command.description}</text>
          </box>
        )}</For>
      </scrollbox>
      <text fg={theme.textMuted}>{commandShortcut()}: commands · Esc twice: stop run</text>
      <text fg={theme.textMuted}>{newlineShortcut()}: newline · @: attach file</text>
      <text fg={theme.primary} onMouseUp={display}>Ctrl+T: display options</text>
      <Show when={Object.keys(sync.data.mcp).length > 0}>
        <text fg={theme.primary} onMouseUp={mcp}>Ctrl+G: configured MCPs</text>
      </Show>
      <Show when={skills()?.length}>
        <text fg={theme.primary} onMouseUp={selectSkill}>Ctrl+S: project skills</text>
      </Show>
    </box>
  )
}
