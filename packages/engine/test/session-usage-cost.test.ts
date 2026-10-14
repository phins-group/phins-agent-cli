import { expect, test } from "bun:test"
import { usageCost } from "../src/sessions/usage/cost"

const tokens = { input: 1000, output: 300, reasoning: 200, cache: { read: 400, write: 100 } }
const base = { input: 2, output: 6, cache: { read: 0.5, write: 3 } }

test("USD estimate counts uncached input, cache and reasoning output once", () => {
  expect(usageCost(tokens, [base])).toBeCloseTo(0.0055, 10)
})

test("highest matching context tier applies to the whole request input including cache", () => {
  const tier = (size: number, input: number) => ({ ...base, input, tier: { type: "context" as const, size } })
  expect(usageCost(tokens, [tier(1499, 4), tier(1200, 3), base])).toBeCloseTo(0.0075, 10)
  expect(usageCost(tokens, [base, tier(1500, 4)])).toBeCloseTo(0.0055, 10)
})

test("unknown or invalid rates are not free; explicit zero rates are", () => {
  expect(usageCost(tokens, [])).toBeUndefined()
  expect(usageCost(tokens, [{ ...base, input: -1 }])).toBeUndefined()
  expect(usageCost({ ...tokens, input: NaN }, [base])).toBeUndefined()
  expect(usageCost(tokens, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])).toBe(0)
})
