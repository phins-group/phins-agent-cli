import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/merge.mjs";

test("touching closed intervals merge", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
});
test("overlap and nesting", () => {
  assert.deepEqual(mergeIntervals([[1, 5], [2, 4], [4, 7]]), [[1, 7]]);
});
test("unsorted disjoint intervals without input mutation", () => {
  const input = Object.freeze([Object.freeze([8, 9]), Object.freeze([1, 2])]);
  assert.deepEqual(mergeIntervals(input), [[1, 2], [8, 9]]);
  assert.deepEqual(input, [[8, 9], [1, 2]]);
});
test("empty and invalid intervals", () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.throws(() => mergeIntervals([[3, 1]]), RangeError);
});

