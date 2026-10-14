import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../../src/shared/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("phins resume ses_123")
  expect(epilogue).toContain("👋 Goodbye!")
})

test("omits continuation command without a session id", () => {
  const epilogue = sessionEpilogue({ title: "Draft" })
  expect(epilogue).not.toContain("Draft")
  expect(epilogue).not.toContain("Session")
  expect(epilogue).not.toContain("Continue")
  expect(epilogue).toContain("👋 Goodbye!")
  expect(epilogue).not.toContain("undefined")
})

test("shows the requested seven-line ASCII logo at exit", () => {
  const lines = sessionEpilogue({ title: "Draft" }).split("\n")
  expect(lines.slice(0, 7).every(line => /^  [\x20-\x7e]+$/.test(line))).toBe(true)
  expect(lines[0]).toBe("   ______   ___   ___    ________  ___   __    ______")
  expect(lines[6]).toBe(String.raw`      \_\/     \__\/ \::\/\________\/ \__\/ \__\/ \_____\/`)
  expect(lines[7]).toBe("")
})

test("keeps ASCII on image-capable terminals", () => {
  const previousProgram = process.env.TERM_PROGRAM
  const previousInline = process.env.PHINS_FORCE_INLINE_LOGO
  process.env.TERM_PROGRAM = "iTerm.app"
  process.env.PHINS_FORCE_INLINE_LOGO = "1"
  try {
    const epilogue = sessionEpilogue({ title: "Draft" })
    expect(epilogue.startsWith("   ______")).toBe(true)
    expect(epilogue).not.toContain("\x1b]1337;")
    expect(epilogue).not.toMatch(/[▀▄█]/)
  } finally {
    if (previousProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousProgram
    if (previousInline === undefined) delete process.env.PHINS_FORCE_INLINE_LOGO
    else process.env.PHINS_FORCE_INLINE_LOGO = previousInline
  }
})
