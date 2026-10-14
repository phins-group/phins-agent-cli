/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"

export type RunningStatusTheme = {
  elapsedMuted: string
}

export type RunningStatusOptions = {
  elapsedMs: number
  theme: RunningStatusTheme
  noColor?: boolean
  trueColor?: boolean
}

export const runningStatusTheme: RunningStatusTheme = {
  elapsedMuted: "#8B949E",
}

export function terminalNoColor() {
  return process.env.NO_COLOR !== undefined
}

export function terminalTrueColor() {
  const colorterm = process.env.COLORTERM?.toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return true
  const program = process.env.TERM_PROGRAM?.toLowerCase()
  if (program && ["iterm.app", "wezterm", "vscode", "apple_terminal"].includes(program)) return true
  return /\b(truecolor|24bit)\b/i.test(process.env.TERM ?? "")
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const two = (value: number) => String(value).padStart(2, "0")

  if (hours > 0) return `${two(hours)}:${two(minutes)}:${two(seconds)}`
  return `${two(minutes)}:${two(seconds)}`
}

export function renderRunningStatus(options: RunningStatusOptions): JSX.Element {
  const fg = options.noColor ? undefined
    : options.trueColor === false ? "#8a8a8a" : options.theme.elapsedMuted
  if (!fg) return <span>⏱ {formatElapsed(options.elapsedMs)}</span>
  return <span style={{ fg }}>⏱ {formatElapsed(options.elapsedMs)}</span>
}
