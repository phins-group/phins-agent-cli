/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"

export type RunningStatusTheme = {
  activityDot: string
  runningGradientStart: string
  runningGradientEnd: string
  elapsedMuted: string
}

export type RunningStatusOptions = {
  elapsedMs: number
  frameIndex: number
  theme: RunningStatusTheme
  reducedMotion?: boolean
  noColor?: boolean
  trueColor?: boolean
}

export const runningStatusTheme: RunningStatusTheme = {
  activityDot: "#008000",
  runningGradientStart: "#f3c74c",
  runningGradientEnd: "#90ee90",
  elapsedMuted: "#8B949E",
}

const DOT_FRAMES = ["◉", "◎", "◌", "◎"] as const
const DOT_FRAME_DIVISOR = 5
const RUNNING_TEXT = "Running"
const READY_TEXT = "Ready"
const FALLBACK_256: RunningStatusTheme = {
  activityDot: "#008000",
  runningGradientStart: "#ffd75f",
  runningGradientEnd: "#87ff87",
  elapsedMuted: "#8a8a8a",
}

function color(theme: RunningStatusTheme, key: keyof RunningStatusTheme, options?: { noColor?: boolean; trueColor?: boolean }) {
  if (options?.noColor) return undefined
  if (options?.trueColor === false) return FALLBACK_256[key]
  return theme[key]
}

function truthy(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes"
}

export function terminalNoColor() {
  return process.env.NO_COLOR !== undefined
}

export function terminalReducedMotion() {
  return !process.stdout.isTTY || truthy(process.env.REDUCED_MOTION) || truthy(process.env.PHINS_REDUCED_MOTION)
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

export function renderPulseDot(frameIndex: number, theme: RunningStatusTheme, options?: RunningStatusOptions) {
  const symbol =
    options?.reducedMotion || options?.noColor
      ? DOT_FRAMES[0]
      : DOT_FRAMES[Math.floor(frameIndex / DOT_FRAME_DIVISOR) % DOT_FRAMES.length]
  const fg = color(theme, "activityDot", options)
  if (!fg) return <span>{symbol}</span>
  return <span style={{ fg, bold: symbol === "◉" }}>{symbol}</span>
}

export function renderAnimatedGradientText(
  text: string,
  frameIndex: number,
  theme: RunningStatusTheme,
  options?: RunningStatusOptions,
) {
  if (options?.reducedMotion || options?.noColor) {
    const fg = color(theme, "runningGradientStart", options)
    if (!fg) return <span>{text}</span>
    return <span style={{ fg }}>{text}</span>
  }

  const sweepWidth = 2
  const sweep = frameIndex % (text.length + sweepWidth * 2)
  return (
    <>
      {text.split("").map((char, index) => {
        const active = Math.abs(index - (sweep - sweepWidth)) <= 1
        const fg = color(theme, active ? "runningGradientEnd" : "runningGradientStart", options)
        if (!fg) return <span>{char}</span>
        return <span style={{ fg, bold: active }}>{char}</span>
      })}
    </>
  )
}

export function renderRunningStatus(options: RunningStatusOptions): JSX.Element {
  const elapsedFg = color(options.theme, "elapsedMuted", options)
  return (
    <>
      {renderPulseDot(options.frameIndex, options.theme, options)}
      <span> </span>
      {renderAnimatedGradientText(RUNNING_TEXT, options.frameIndex, options.theme, options)}
      <span>  </span>
      {elapsedFg ? <span style={{ fg: elapsedFg }}>{formatElapsed(options.elapsedMs)}</span> : <span>{formatElapsed(options.elapsedMs)}</span>}
    </>
  )
}

export function renderReadyStatus(options: Pick<RunningStatusOptions, "theme" | "noColor" | "trueColor">): JSX.Element {
  const fg = color(options.theme, "activityDot", options)
  if (!fg) {
    return (
      <>
        <span>◉</span>
        <span> </span>
        <span>{READY_TEXT}</span>
      </>
    )
  }
  return (
    <>
      <span style={{ fg, bold: true }}>◉</span>
      <span> </span>
      <span style={{ fg }}>{READY_TEXT}</span>
    </>
  )
}
