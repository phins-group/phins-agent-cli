import { describe, expect, test } from "bun:test"
import { normalizeMarkdownForTui } from "../../../../src/tui/screens/session/conversation"

describe("normalizeMarkdownForTui", () => {
  test("separates headings glued to preceding markdown", () => {
    const input = "| Tool | Purpose |\n| --- | --- |\n| read | attachments |### Đánh giá"

    expect(normalizeMarkdownForTui(input)).toBe("| Tool | Purpose |\n| --- | --- |\n| read | attachments |\n\n### Đánh giá")
  })

  test("moves attached code fences onto block boundaries", () => {
    const input = "Stream Processing```\nnext"

    expect(normalizeMarkdownForTui(input)).toBe("Stream Processing\n```\nnext")
  })

  test("preserves code fence info strings", () => {
    const input = "```ts\nconst ok = true\n```"

    expect(normalizeMarkdownForTui(input)).toBe(input)
  })

  test("adds spacing before a table block", () => {
    const input = "Summary\n| Area | Finding |\n| --- | --- |\n| agent | bounded |"

    expect(normalizeMarkdownForTui(input)).toBe("Summary\n\n| Area | Finding |\n| --- | --- |\n| agent | bounded |")
  })
})
