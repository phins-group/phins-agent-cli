import test from "node:test";
import assert from "node:assert/strict";
import { page } from "../src/page.mjs";

test("first page contains exactly size items", () => {
  assert.deepEqual(page(["a", "b", "c", "d", "e"], 0, 2), ["a", "b"]);
});
test("last partial page and out-of-range page", () => {
  assert.deepEqual(page(["a", "b", "c", "d", "e"], 2, 2), ["e"]);
  assert.deepEqual(page(["a"], 2, 2), []);
});
test("unit size, empty input and input preservation", () => {
  const input = Object.freeze([1, 2, 3]);
  assert.deepEqual(page(input, 1, 1), [2]);
  assert.deepEqual(page([], 0, 1), []);
  assert.deepEqual(input, [1, 2, 3]);
});
test("invalid page and size are rejected", () => {
  for (const [index, size] of [[-1, 2], [0.5, 2], [0, 0], [0, 1.5]]) {
    assert.throws(() => page([1], index, size), RangeError);
  }
});

