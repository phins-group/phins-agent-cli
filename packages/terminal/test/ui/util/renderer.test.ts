import { expect, test } from "bun:test"
import { destroyRenderer } from "../../../src/tui/platform/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("never calls native methods on an already destroyed renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual([])
})

test("teardown is safe when both the exit action and scope finalizer run", () => {
  const calls: string[] = []
  const renderer = {
    isDestroyed: false,
    setTerminalTitle() {
      if (this.isDestroyed) throw new Error("Native renderer has been freed")
      calls.push("title")
    },
    destroy() {
      this.isDestroyed = true
      calls.push("destroy")
    },
  }
  destroyRenderer(renderer)
  destroyRenderer(renderer)
  expect(calls).toEqual(["title", "destroy"])
})

test("a title output error cannot skip renderer cleanup", () => {
  let destroyed = false
  expect(() => destroyRenderer({
    isDestroyed: false,
    setTerminalTitle() { throw new Error("Terminal output closed") },
    destroy() { destroyed = true },
  })).toThrow("Terminal output closed")
  expect(destroyed).toBe(true)
})
