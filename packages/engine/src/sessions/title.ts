import { stripVTControlCharacters } from "node:util"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** A local task label, never a model call or a claim about the task's result. */
export function titleFromPrompt(text: string): string | undefined {
  const line = stripVTControlCharacters(text.slice(0, 4096))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return
  const characters = Array.from(segments.segment(line), (item) => item.segment)
  if (characters.length <= 80) return line
  const head = characters.slice(0, 79).join("")
  const boundary = head.lastIndexOf(" ")
  return `${(boundary >= 40 ? head.slice(0, boundary) : head).trimEnd()}…`
}
