import test from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/delay.mjs";

test("attempt zero uses base delay and backoff reaches cap", () => {
  assert.equal(retryDelay(0, 100, 1000), 100);
  assert.equal(retryDelay(2, 100, 1000), 400);
  assert.equal(retryDelay(10, 100, 1000), 1000);
});
test("Retry-After zero means immediate retry", () => {
  assert.equal(retryDelay(2, 100, 1000, "0"), 0);
});
test("numeric seconds and cap", () => {
  assert.equal(retryDelay(0, 100, 5000, "2"), 2000);
  assert.equal(retryDelay(0, 100, 5000, "10"), 5000);
});
test("invalid attempts rejected and nonnumeric header falls back", () => {
  assert.throws(() => retryDelay(-1, 100, 1000), RangeError);
  assert.throws(() => retryDelay(0.5, 100, 1000), RangeError);
  assert.equal(retryDelay(1, 100, 1000, "later"), 200);
});

