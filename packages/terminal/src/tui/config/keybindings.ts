/**
 * Nguồn sự thật cho tên command TUI, binding mặc định và config override.
 *
 * Thêm command mới phải khai báo trong `Definitions`; `CommandMap` nối tên
 * config ổn định với command dispatcher runtime.
 * @module
 */
export * as TuiKeybind from "./keybindings"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingCommandMap, BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
import { Schema } from "effect"

const KeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})

const BindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, KeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const BindingItem = Schema.Union([Schema.String, KeyStroke, BindingObject])
export const BindingValueSchema = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  BindingItem,
  Schema.Array(BindingItem),
])
export type BindingValueSchema = Schema.Schema.Type<typeof BindingValueSchema>

type Definition = {
  default: BindingValueSchema
  description: string
}

export const LeaderDefault = "ctrl+x"

const keybind = (value: Definition["default"], description: string): Definition => ({ default: value, description })

/** Toàn bộ command key có thể cấu hình cùng default binding của chúng. */
export const Definitions = {
  leader: keybind(LeaderDefault, "Leader key for keybind combinations"),

  app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "Exit the application"),
  node_monitor_exit: keybind("q,escape,ctrl+c", "Close the read-only Node session monitor without interrupting work"),
  node_monitor_line_up: keybind("up", "Scroll Node session history up by one line"),
  node_monitor_line_down: keybind("down", "Scroll Node session history down by one line"),
  node_monitor_page_up: keybind("pageup", "Scroll Node session history up by one page"),
  node_monitor_page_down: keybind("pagedown", "Scroll Node session history down by one page"),
  node_monitor_first: keybind("home", "Show the first loaded Node session message"),
  node_monitor_last: keybind("end", "Follow the newest Node session message"),
  node_session_exit: keybind("ctrl+d", "Close the interactive Node client without stopping work"),
  node_session_stop: keybind("ctrl+c", "Interrupt this Node session and wait for cleanup"),
  node_session_resume: keybind("ctrl+r", "Explicitly resume this Node session"),
  node_session_focus: keybind("escape", "Switch between Node history and input"),
  node_session_requests: keybind("ctrl+g", "Open or close pending Node requests"),
  node_session_new_prompt: keybind("<leader>n", "Detach an uncertain prompt attempt without cancelling the job"),
  node_request_submit: keybind("ctrl+s", "Submit explicit Node request answers"),
  node_request_next: keybind("tab", "Show the next question in a Node request"),
  node_request_previous: keybind("shift+tab", "Show the previous question in a Node request"),
  node_request_custom: keybind("ctrl+t", "Switch between listed choices and a custom Node answer"),
  node_request_reject: keybind("ctrl+k", "Explicitly skip a pending Node question"),
  command_list: keybind("ctrl+p", "List available commands"),
  help_show: keybind("none", "Open help dialog"),

  session_new: keybind("<leader>n", "Create a new session"),
  session_list: keybind("<leader>l", "List all sessions"),
  session_rename: keybind("ctrl+r", "Rename session"),
  session_delete: keybind("ctrl+d", "Delete session"),
  session_interrupt: keybind("escape", "Interrupt current session"),
  session_compact: keybind("<leader>c", "Compact the session"),
  session_queued_prompts: keybind("<leader>q", "Manage queued prompts"),
  session_child_first: keybind("<leader>down", "Go to first child session"),
  session_child_cycle: keybind("right", "Go to next child session"),
  session_child_cycle_reverse: keybind("left", "Go to previous child session"),
  session_parent: keybind("up", "Go to parent session"),
  session_pin_toggle: keybind("ctrl+f", "Pin or unpin session in the session list"),
  session_quick_switch_1: keybind("<leader>1", "Switch to session in quick slot 1"),
  session_quick_switch_2: keybind("<leader>2", "Switch to session in quick slot 2"),
  session_quick_switch_3: keybind("<leader>3", "Switch to session in quick slot 3"),
  session_quick_switch_4: keybind("<leader>4", "Switch to session in quick slot 4"),
  session_quick_switch_5: keybind("<leader>5", "Switch to session in quick slot 5"),
  session_quick_switch_6: keybind("<leader>6", "Switch to session in quick slot 6"),
  session_quick_switch_7: keybind("<leader>7", "Switch to session in quick slot 7"),
  session_quick_switch_8: keybind("<leader>8", "Switch to session in quick slot 8"),
  session_quick_switch_9: keybind("<leader>9", "Switch to session in quick slot 9"),

  stash_delete: keybind("ctrl+d", "Delete stash entry"),
  model_favorite_toggle: keybind("ctrl+f", "Toggle model favorite status"),
  model_list: keybind("<leader>m", "List available models"),
  agent_cycle: keybind("tab", "Next agent"),
  agent_cycle_reverse: keybind("shift+tab", "Previous agent"),
  agent_run_cancel: keybind("ctrl+c", "Cancel selected agent run"),
  agent_run_background: keybind("ctrl+b", "Background selected agent run"),

  messages_page_up: keybind("pageup,ctrl+alt+b", "Scroll messages up by one page"),
  messages_page_down: keybind("pagedown,ctrl+alt+f", "Scroll messages down by one page"),
  messages_line_up: keybind("ctrl+alt+y", "Scroll messages up by one line"),
  messages_line_down: keybind("ctrl+alt+e", "Scroll messages down by one line"),
  messages_half_page_up: keybind("ctrl+alt+u", "Scroll messages up by half page"),
  messages_half_page_down: keybind("ctrl+alt+d", "Scroll messages down by half page"),
  messages_first: keybind("ctrl+g,home", "Navigate to first message"),
  messages_last: keybind("ctrl+alt+g,end", "Navigate to last message"),
  messages_next: keybind("none", "Navigate to next message"),
  messages_previous: keybind("none", "Navigate to previous message"),
  messages_last_user: keybind("none", "Navigate to last user message"),
  messages_copy: keybind("<leader>y", "Copy message"),
  messages_toggle_actions: keybind("ctrl+o", "Expand or collapse action details"),

  prompt_submit: keybind("none", "Submit prompt"),
  prompt_editor_context_clear: keybind("none", "Clear editor context"),
  prompt_stash: keybind("none", "Stash prompt"),
  prompt_stash_pop: keybind("none", "Pop stashed prompt"),
  prompt_stash_list: keybind("none", "List stashed prompts"),

  input_clear: keybind("ctrl+c", "Clear input field"),
  input_paste: keybind({ key: "ctrl+v", preventDefault: false }, "Paste from clipboard"),
  input_submit: keybind("return", "Submit input"),
  input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline in input"),
  input_move_left: keybind("left,ctrl+b", "Move cursor left in input"),
  input_move_right: keybind("right,ctrl+f", "Move cursor right in input"),
  input_move_up: keybind("up", "Move cursor up in input"),
  input_move_down: keybind("down", "Move cursor down in input"),
  input_select_left: keybind("shift+left", "Select left in input"),
  input_select_right: keybind("shift+right", "Select right in input"),
  input_select_up: keybind("shift+up", "Select up in input"),
  input_select_down: keybind("shift+down", "Select down in input"),
  input_line_home: keybind("ctrl+a", "Move to start of line in input"),
  input_line_end: keybind("ctrl+e", "Move to end of line in input"),
  input_select_line_home: keybind("ctrl+shift+a", "Select to start of line in input"),
  input_select_line_end: keybind("ctrl+shift+e", "Select to end of line in input"),
  input_visual_line_home: keybind("alt+a", "Move to start of visual line in input"),
  input_visual_line_end: keybind("alt+e", "Move to end of visual line in input"),
  input_select_visual_line_home: keybind("alt+shift+a", "Select to start of visual line in input"),
  input_select_visual_line_end: keybind("alt+shift+e", "Select to end of visual line in input"),
  input_buffer_home: keybind("home", "Move to start of buffer in input"),
  input_buffer_end: keybind("end", "Move to end of buffer in input"),
  input_select_buffer_home: keybind("shift+home", "Select to start of buffer in input"),
  input_select_buffer_end: keybind("shift+end", "Select to end of buffer in input"),
  input_delete_line: keybind("ctrl+shift+d", "Delete line in input"),
  input_delete_to_line_end: keybind("ctrl+k", "Delete to end of line in input"),
  input_delete_to_line_start: keybind("ctrl+u", "Delete to start of line in input"),
  input_backspace: keybind("backspace,shift+backspace", "Backspace in input"),
  input_delete: keybind("ctrl+d,delete,shift+delete", "Delete character in input"),
  input_undo: keybind("ctrl+-,super+z", "Undo in input"),
  input_redo: keybind("ctrl+.,super+shift+z", "Redo in input"),
  input_word_forward: keybind("alt+f,alt+right,ctrl+right", "Move word forward in input"),
  input_word_backward: keybind("alt+b,alt+left,ctrl+left", "Move word backward in input"),
  input_select_word_forward: keybind("alt+shift+f,alt+shift+right", "Select word forward in input"),
  input_select_word_backward: keybind("alt+shift+b,alt+shift+left", "Select word backward in input"),
  input_delete_word_forward: keybind("alt+d,alt+delete,ctrl+delete", "Delete word forward in input"),
  input_delete_word_backward: keybind("ctrl+w,ctrl+backspace,alt+backspace", "Delete word backward in input"),
  input_select_all: keybind("super+a", "Select all in input"),
  history_previous: keybind("up", "Previous history item"),
  history_next: keybind("down", "Next history item"),

  "dialog.select.prev": keybind("up,ctrl+p", "Move to previous dialog item"),
  "dialog.select.next": keybind("down,ctrl+n", "Move to next dialog item"),
  "dialog.select.page_up": keybind("pageup", "Move up one page in dialog"),
  "dialog.select.page_down": keybind("pagedown", "Move down one page in dialog"),
  "dialog.select.home": keybind("home", "Move to first dialog item"),
  "dialog.select.end": keybind("end", "Move to last dialog item"),
  "dialog.select.submit": keybind("return", "Submit selected dialog item"),
  "dialog.prompt.submit": keybind("return", "Submit dialog prompt"),
  "dialog.mcp.toggle": keybind("space", "Toggle MCP in MCP dialog"),
  "dialog.move_session.new": keybind("ctrl+m", "New project copy"),
  "dialog.move_session.delete": keybind("ctrl+d", "Delete project copy"),
  "dialog.move_session.refresh": keybind("ctrl+r", "Refresh project copies"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "Move to previous autocomplete item"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "Move to next autocomplete item"),
  "prompt.autocomplete.hide": keybind("escape", "Hide autocomplete"),
  "prompt.autocomplete.select": keybind("return", "Select autocomplete item"),
  "prompt.autocomplete.complete": keybind("tab", "Complete autocomplete item"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "Toggle permission prompt fullscreen"),
  "plugins.toggle": keybind("space", "Toggle plugin"),
  "dialog.plugins.install": keybind("shift+i", "Install plugin from plugin dialog"),
  plugin_manager: keybind("none", "Open plugin manager dialog"),
  plugin_install: keybind("none", "Install plugin"),

  which_key_toggle: keybind("ctrl+alt+k", "Toggle which-key panel"),
  which_key_layout_toggle: keybind("ctrl+alt+shift+k", "Switch which-key layout"),
  which_key_pending_toggle: keybind("ctrl+alt+shift+p", "Toggle which-key pending preview"),
  which_key_group_previous: keybind("ctrl+alt+left,ctrl+alt+[", "Previous which-key group"),
  which_key_group_next: keybind("ctrl+alt+right,ctrl+alt+]", "Next which-key group"),
  which_key_scroll_up: keybind("ctrl+alt+up,ctrl+alt+p", "Scroll which-key up"),
  which_key_scroll_down: keybind("ctrl+alt+down,ctrl+alt+n", "Scroll which-key down"),
  which_key_page_up: keybind("ctrl+alt+pageup", "Page which-key up"),
  which_key_page_down: keybind("ctrl+alt+pagedown", "Page which-key down"),
  which_key_home: keybind("ctrl+alt+home", "Jump to first which-key binding"),
  which_key_end: keybind("ctrl+alt+end", "Jump to last which-key binding"),
} satisfies Record<string, Definition>

type KeybindName = keyof typeof Definitions
const KeybindNames = new Set<string>(Object.keys(Definitions))

export const KeybindOverrides = Schema.Struct(
  Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      Schema.optional(BindingValueSchema).annotate({ description: item.description }),
    ]),
  ),
).annotate({ description: "TUI keybinding overrides" })
export const Descriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>
/** Ánh xạ config key sang tên command mà component/plugin đăng ký. */
export const CommandMap = {
  app_exit: "app.exit",
  node_monitor_exit: "node.monitor.exit",
  node_monitor_line_up: "node.monitor.line.up",
  node_monitor_line_down: "node.monitor.line.down",
  node_monitor_page_up: "node.monitor.page.up",
  node_monitor_page_down: "node.monitor.page.down",
  node_monitor_first: "node.monitor.first",
  node_monitor_last: "node.monitor.last",
  node_session_exit: "node.session.exit",
  node_session_stop: "node.session.stop",
  node_session_resume: "node.session.resume",
  node_session_focus: "node.session.focus",
  node_session_requests: "node.session.requests",
  node_session_new_prompt: "node.session.new.prompt",
  node_request_submit: "node.request.submit",
  node_request_next: "node.request.next",
  node_request_previous: "node.request.previous",
  node_request_custom: "node.request.custom",
  node_request_reject: "node.request.reject",
  command_list: "command.palette.show",
  help_show: "help.show",
  session_new: "session.new",
  session_list: "session.list",
  session_rename: "session.rename",
  session_delete: "session.delete",
  session_interrupt: "session.interrupt",
  session_compact: "session.compact",
  session_queued_prompts: "session.queued_prompts",
  session_child_first: "session.child.first",
  session_child_cycle: "session.child.next",
  session_child_cycle_reverse: "session.child.previous",
  session_parent: "session.parent",
  session_pin_toggle: "session.pin.toggle",
  session_quick_switch_1: "session.quick_switch.1",
  session_quick_switch_2: "session.quick_switch.2",
  session_quick_switch_3: "session.quick_switch.3",
  session_quick_switch_4: "session.quick_switch.4",
  session_quick_switch_5: "session.quick_switch.5",
  session_quick_switch_6: "session.quick_switch.6",
  session_quick_switch_7: "session.quick_switch.7",
  session_quick_switch_8: "session.quick_switch.8",
  session_quick_switch_9: "session.quick_switch.9",
  stash_delete: "stash.delete",
  model_favorite_toggle: "model.dialog.favorite",
  model_list: "model.list",
  agent_cycle: "agent.cycle",
  agent_cycle_reverse: "agent.cycle.reverse",
  agent_run_cancel: "agent.run.cancel",
  agent_run_background: "agent.run.background",
  messages_page_up: "session.page.up",
  messages_toggle_actions: "session.activities.toggle",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  messages_next: "session.message.next",
  messages_previous: "session.message.previous",
  messages_last_user: "session.messages_last_user",
  messages_copy: "messages.copy",
  prompt_submit: "prompt.submit",
  prompt_editor_context_clear: "prompt.editor_context.clear",
  prompt_stash: "prompt.stash",
  prompt_stash_pop: "prompt.stash.pop",
  prompt_stash_list: "prompt.stash.list",
  input_clear: "prompt.clear",
  input_paste: "prompt.paste",
  input_submit: "input.submit",
  input_newline: "input.newline",
  input_move_left: "input.move.left",
  input_move_right: "input.move.right",
  input_move_up: "input.move.up",
  input_move_down: "input.move.down",
  input_select_left: "input.select.left",
  input_select_right: "input.select.right",
  input_select_up: "input.select.up",
  input_select_down: "input.select.down",
  input_line_home: "input.line.home",
  input_line_end: "input.line.end",
  input_select_line_home: "input.select.line.home",
  input_select_line_end: "input.select.line.end",
  input_visual_line_home: "input.visual.line.home",
  input_visual_line_end: "input.visual.line.end",
  input_select_visual_line_home: "input.select.visual.line.home",
  input_select_visual_line_end: "input.select.visual.line.end",
  input_buffer_home: "input.buffer.home",
  input_buffer_end: "input.buffer.end",
  input_select_buffer_home: "input.select.buffer.home",
  input_select_buffer_end: "input.select.buffer.end",
  input_delete_line: "input.delete.line",
  input_delete_to_line_end: "input.delete.to.line.end",
  input_delete_to_line_start: "input.delete.to.line.start",
  input_backspace: "input.backspace",
  input_delete: "input.delete",
  input_undo: "input.undo",
  input_redo: "input.redo",
  input_word_forward: "input.word.forward",
  input_word_backward: "input.word.backward",
  input_select_word_forward: "input.select.word.forward",
  input_select_word_backward: "input.select.word.backward",
  input_delete_word_forward: "input.delete.word.forward",
  input_delete_word_backward: "input.delete.word.backward",
  input_select_all: "input.select.all",
  history_previous: "prompt.history.previous",
  history_next: "prompt.history.next",
  plugin_manager: "plugins.list",
  plugin_install: "plugins.install",
  which_key_toggle: "which-key.toggle",
  which_key_layout_toggle: "which-key.layout.toggle",
  which_key_pending_toggle: "which-key.pending.toggle",
  which_key_group_previous: "which-key.group.previous",
  which_key_group_next: "which-key.group.next",
  which_key_scroll_up: "which-key.scroll.up",
  which_key_scroll_down: "which-key.scroll.down",
  which_key_page_up: "which-key.page.up",
  which_key_page_down: "which-key.page.down",
  which_key_home: "which-key.home",
  which_key_end: "which-key.end",
} satisfies BindingCommandMap
const CommandDescriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [
    CommandMap[name as keyof typeof CommandMap] ?? name,
    item.description,
  ]),
) as Record<string, string>

export type Keybinds = { [K in KeybindName]: BindingValueSchema }
export type KeybindOverrides = Partial<Keybinds>
export type BindingLookupView = {
  readonly bindings: readonly Binding<Renderable, KeyEvent>[]
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
  pick(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
  omit(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
}

export function toBindingConfig(keybinds: Keybinds): BindingConfig<Renderable, KeyEvent> {
  return Object.fromEntries(Object.entries(keybinds)) as BindingConfig<Renderable, KeyEvent>
}

const decodeBindingValue = Schema.decodeUnknownSync(BindingValueSchema)

export function defaultValue(name: KeybindName) {
  return Definitions[name].default
}

/** Merge override người dùng với default và bỏ binding được tắt rõ ràng. */
export function parse(keybinds: KeybindOverrides): Keybinds {
  const invalid = unknownKeys(keybinds)
  if (invalid.length) throw new Error(`Unrecognized keybind${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`)
  return Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      decodeBindingValue(keybinds[name as KeybindName] ?? item.default),
    ]),
  ) as Keybinds
}

export const Keybinds = { parse }

export function unknownKeys(input: object) {
  return Object.keys(input).filter((key) => !KeybindNames.has(key))
}

export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
  return ({ command, binding }) => {
    if (binding.desc !== undefined) return
    return { desc: CommandDescriptions[command] }
  }
}
