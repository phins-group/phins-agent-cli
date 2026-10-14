import test from "node:test";
import assert from "node:assert/strict";
import ms from "../index.js";
const cases = [
  ["-10.5h", -37800000], ["-100.25s", -100250], ["-42.75m", -2565000],
  ["-1234.5ms", -1234.5], ["-.5h", -1800000], ["-1.5h", -5400000],
  ["-100h", -360000000], ["10.5h", 37800000], ["100", 100], ["2w", 1209600000],
  ["3 hours", 10800000], ["-20 days", -1728000000], ["0", 0], [".5ms", 0.5],
];
for (const [input, expected] of cases)
  test(`parse ${input}`, () => assert.equal(ms(input), expected));
for (const input of ["1-2h", "--10.5h", "10..5h", "ten hours", "h", "x".repeat(101)])
  test(`reject malformed ${input.slice(0,20)}`, () => assert.equal(ms(input), undefined));
test("short and long numeric formatting stay unchanged", () => {
  assert.equal(ms(60000), "1m");
  assert.equal(ms(-60000), "-1m");
  assert.equal(ms(120000, {long: true}), "2 minutes");
});
test("invalid value types throw", () => {
  for (const value of [null, {}, true, "", NaN]) assert.throws(() => ms(value));
});
