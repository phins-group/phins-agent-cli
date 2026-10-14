import { BoxRenderable, TextRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Effect, Exit, Redacted } from "effect"
import type { Prompt } from "effect/unstable/cli"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { providerSetup, saveSelectedModel, type ProviderSetupPrompts } from "../../shared/provider-setup"
import { usePreferences } from "../state/preferences"
import { useTuiPaths } from "../state/environment"
import { useAgentClient } from "../state/agent-client"
import { useSessionState } from "../state/sessions"
import { useTheme } from "../theme/provider"
import { useDialog } from "../components/dialog"
import { DialogSelect } from "../components/dialog-select"
import { ModelSelect } from "../components/model-select"
import type { ModelChoice } from "../../shared/model-info"
import type { SelectedModel } from "../../shared/provider-setup"
import { useToast } from "../components/toast"

/** Only mask characters enter the render tree; no textarea, history or clipboard copy. */
export function ProviderKeyInput(props: {
  options: Prompt.TextOptions
  onSubmit: (key: string) => void
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [length, setLength] = createSignal(0)
  const [error, setError] = createSignal("")
  let value = ""
  let field: BoxRenderable
  let content: TextRenderable
  let submitted = false

  function update(next: string) {
    value = next
    setLength(Array.from(value).length)
    setError("")
  }

  function append(text: string) {
    if (submitted) return
    if (/[\x00-\x1f\x7f]/.test(text) || value.length + text.length > 4096) {
      setError("Enter a single-line API key (up to 4096 characters).")
      return
    }
    update(value + text)
  }

  function submit() {
    if (submitted) return
    const result = Effect.runSyncExit(props.options.validate?.(value) ?? Effect.succeed(value))
    if (Exit.isFailure(result)) {
      setError("Enter a non-empty, single-line API key.")
      return
    }
    submitted = true
    update("")
    props.onSubmit(result.value)
  }

  function keydown(event: KeyEvent) {
    if (event.name === "escape" || (event.ctrl && event.name === "c")) return
    event.preventDefault()
    event.stopPropagation()
    if (submitted || event.eventType === "release") return
    if (event.name === "return") submit()
    else if (event.name === "backspace") update(Array.from(value).slice(0, -1).join(""))
    else if (event.ctrl && event.name === "u") update("")
    else if (!event.ctrl && !event.meta && !event.super && !event.option) append(event.sequence)
  }

  const hideCursor = () => renderer.setCursorPosition(0, 0, false)
  onMount(() => {
    field.on("blurred", hideCursor)
    field.focus()
  })
  onCleanup(() => {
    value = ""
    field.off("blurred", hideCursor)
    if (field.focused) hideCursor()
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>{props.options.message}</text>
      <box
        id="provider-api-key"
        ref={(item: BoxRenderable) => { field = item }}
        focusable
        height={3}
        border
        borderColor={theme.border}
        focusedBorderColor={theme.primary}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
        onMouseUp={() => {
          renderer.clearSelection()
          field.focus()
        }}
        renderAfter={() => {
          if (!field.focused || submitted || !content) return
          const offset = Math.min(length(), 40, Math.max(0, content.width - 1))
          renderer.setCursorStyle({ style: "block", blinking: true, cursor: "text" })
          renderer.setCursorColor(theme.text)
          // Renderables use 0-based cells; the terminal cursor API is 1-based.
          renderer.setCursorPosition(content.x + offset + 1, content.y + 1, true)
        }}
        onKeyDown={keydown}
        onPaste={(event) => {
          event.preventDefault()
          event.stopPropagation()
          append(new TextDecoder().decode(event.bytes).trim())
        }}
      >
        <text ref={(item: TextRenderable) => { content = item }}
          fg={length() ? theme.text : theme.textMuted}
          width="100%" wrapMode="none" truncate>
          {length() ? "*".repeat(Math.min(length(), 40)) : "Type or paste API key"}
        </text>
      </box>
      <Show when={error()}><text fg={theme.error}>{error()}</text></Show>
      <text fg={theme.textMuted}>enter save · esc cancel · ctrl+u clear</text>
    </box>
  )
}

/** CLI and TUI share credential/model operations, with one input owner per frontend. */
export function ProviderSetupDialog() {
  const dialog = useDialog()
  const sdk = useAgentClient()
  const sync = useSessionState()
  const local = usePreferences()
  const paths = useTuiPaths()
  const toast = useToast()
  const { theme } = useTheme()
  const controller = new AbortController()
  type Step =
    | { kind: "busy" }
    | { kind: "key"; options: Prompt.TextOptions; submit: (key: string) => void }
    | { kind: "select"; title: string; choices: { title: string; value: number }[]; submit: (index: number) => void }
    | { kind: "model"; title: string; choices: ModelChoice[]; submit: (model: SelectedModel) => void }
  const [step, setStep] = createSignal<Step>({ kind: "busy" })
  const password = () => { const current = step(); return current.kind === "key" ? current : undefined }
  const selection = () => { const current = step(); return current.kind === "select" ? current : undefined }
  const models = () => { const current = step(); return current.kind === "model" ? current : undefined }
  const prompts: ProviderSetupPrompts<never> = {
    model: (options) => Effect.callback((resume) => {
      dialog.setSize("model")
      setStep({ kind: "model", title: options.message, choices: options.choices, submit: (model) => {
        setStep({ kind: "busy" })
        resume(Effect.succeed(model))
      } })
    }),
    select: (options) => Effect.callback((resume) => {
      setStep({
        kind: "select", title: options.message,
        choices: options.choices.map((choice, index) => ({ title: choice.title, value: index })),
        submit: (index) => {
          setStep({ kind: "busy" })
          resume(Effect.succeed(options.choices[index]!.value))
        },
      })
    }),
    password: (options) => Effect.callback((resume) => {
      setStep({ kind: "key", options, submit: (key) => {
        setStep({ kind: "busy" })
        resume(Effect.succeed(Redacted.make(key)))
      } })
    }),
  }

  onCleanup(() => controller.abort())
  onMount(() => {
    dialog.setSize("large")
    void Effect.runPromise(providerSetup(sdk.client, {
      directory: sdk.directory ?? paths.cwd,
    }, prompts), { signal: controller.signal }).then(async (model) => {
      if (controller.signal.aborted) return
      await saveSelectedModel(paths.state, model)
      if (controller.signal.aborted) return
      await sync.bootstrap()
      if (controller.signal.aborted) return
      local.model.set(model, { recent: true })
      dialog.clear()
      toast.show({ title: "Setup saved", message: "API key stored locally. No inference requested.", variant: "success" })
    }).catch(() => {
      if (controller.signal.aborted) return
      dialog.clear()
      // Transport failures can contain credentials. Keep diagnostics fixed and safe.
      toast.show({ message: "Setup stopped. A key already saved is retained; no inference requested.", variant: "warning" })
    })
  })

  return (
    <>
      <Show when={step().kind === "busy"}>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <text fg={theme.textMuted}>Loading provider settings and models... esc to cancel</text>
        </box>
      </Show>
      <Show when={password()} keyed>
        {(current) => <ProviderKeyInput options={current.options} onSubmit={current.submit} />}
      </Show>
      <Show when={selection()} keyed>
        {(current) => <DialogSelect title={current.title} options={current.choices}
          onSelect={(option) => current.submit(option.value)} />}
      </Show>
      <Show when={models()} keyed>
        {(current) => <ModelSelect options={current.choices} subtitle={current.title}
          current={local.model.current()} initial={current.choices[0]?.value}
          onSelect={current.submit} onCancel={() => dialog.clear()} />}
      </Show>
    </>
  )
}
