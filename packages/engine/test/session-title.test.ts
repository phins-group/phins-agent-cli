import { expect, test } from "bun:test"
import { isDefaultTitle, titleFromPrompt } from "../src/sessions/title"

test("task titles keep Vietnamese and technical terms on one readable line", () => {
  expect(titleFromPrompt("\n### Sửa lỗi HTTP 500 trong auth.ts\n\tChạy lại tests.\n"))
    .toBe("Sửa lỗi HTTP 500 trong auth.ts Chạy lại tests.")
  expect(titleFromPrompt("Fix the retry limit bug")).toBe("Fix the retry limit bug")
  expect(titleFromPrompt(" \n\t ")).toBeUndefined()
})

test("long requests are bounded without cutting a word or Unicode grapheme", () => {
  const text = "Sửa lỗi đồng bộ đơn hàng và kiểm tra dữ liệu trong repository với bộ kiểm thử hiện có. ".repeat(50)
  const title = titleFromPrompt(text)!
  expect(title.length).toBeLessThanOrEqual(80)
  expect(title.endsWith("…")).toBe(true)
  expect(text.startsWith(title.slice(0, -1) + " ")).toBe(true)
  const emoji = "👩🏽‍💻"
  expect(titleFromPrompt(emoji.repeat(100))).toBe(emoji.repeat(79) + "…")
})

test("terminal escapes and direction controls cannot become session titles", () => {
  expect(titleFromPrompt("\x1b[31mFix\x1b[0m \x1b]0;hidden title\x07tests\u202e\0"))
    .toBe("Fix tests")
  expect(titleFromPrompt("\x1b[31m\x1b[0m")).toBeUndefined()
})

test("only generated timestamp placeholders are eligible for automatic naming", () => {
  expect(isDefaultTitle("New session - 2026-10-13T07:48:27.164Z")).toBe(true)
  expect(isDefaultTitle("Child session - 2026-10-13T07:48:27.164Z")).toBe(true)
  expect(isDefaultTitle("New session - custom")).toBe(false)
  expect(isDefaultTitle("Kiểm tra đơn hàng")).toBe(false)
})
