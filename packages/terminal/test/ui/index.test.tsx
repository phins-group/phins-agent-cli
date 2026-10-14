import { expect, test } from "bun:test"
import { run } from "../../src/tui/app"

test("exports the canonical application lifecycle", () => {
  expect(typeof run).toBe("function")
})
