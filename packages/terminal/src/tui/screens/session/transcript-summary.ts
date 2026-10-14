import type { Part, ToolPart } from "@phins/engine/transport/client/create"

import { summarizeTools } from "../../../shared/coding-report"

export type TranscriptSummary = { kind: "success" | "failed" | "unverified"; label: string; details: string[] }

type ErrorLike = {
  name?: unknown
  message?: unknown
  data?: unknown
}

export function turnEvidence(parts: readonly Part[]) {
  return summarizeTools(parts.filter(isToolPart).map((part) => ({
    name: part.tool, status: part.state.status,
    input: recordValue(part.state.input) ?? {}, output: metadata(part),
  })))
}

export function renderTranscriptSummary(input: {
  parts: readonly Part[]
  duration?: string
  error?: ErrorLike
}): TranscriptSummary {
  if (input.error?.name === "MessageAbortedError")
    return { kind: "unverified", label: "Stopped", details: details(input.duration) }
  const failure = failureReason(input.error)
  if (failure) return { kind: "failed", label: "Failed", details: details(failure, input.duration) }
  const tools = input.parts.filter(isToolPart)
  const evidence = turnEvidence(input.parts)
  const completed = tools.filter((part) => part.state.status === "completed")
  if (evidence.edits) {
    const last = evidence.commands.at(-1)
    const failed = last?.afterLatestEdit && (last.timedOut || (last.exitCode !== undefined && last.exitCode !== 0))
    return { kind: failed ? "failed" : "unverified",
      label: evidence.changedFiles.length ? `Updated ${count(evidence.changedFiles.length, "file")}` : "Updated files",
      details: details(count(evidence.correctionAttempts, "correction"), input.duration) }
  }
  if (evidence.failedTools) return { kind: "failed", label: "Tool failed", details: details(count(evidence.failedTools, "failure"), input.duration) }
  if (completed.length) return { kind: "success", label: "Explored project structure", details: details(count(completed.length, "tool"), input.duration) }
  if (tools.length) return { kind: "unverified", label: "Tools incomplete", details: details(input.duration) }
  return { kind: "success", label: "Responded", details: details(input.duration) }
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool"
}

function failureReason(error: ErrorLike | undefined) {
  if (!error) return undefined
  const data = recordValue(error.data)
  return stringValue(data?.message) ?? stringValue(error.message) ?? "unknown error"
}

function metadata(part: ToolPart): Record<string, unknown> {
  return recordValue("metadata" in part.state ? part.state.metadata : undefined) ?? {}
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function count(value: number, noun: string, plural = `${noun}s`) {
  return `${value} ${value === 1 ? noun : plural}`
}

function details(...items: Array<string | undefined>) {
  return items.filter((item): item is string => Boolean(item))
}
