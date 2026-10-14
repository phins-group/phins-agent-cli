export function mergeIntervals(intervals) {
  if (intervals.some(([start, end]) => start > end)) {
    throw new RangeError("Reversed interval");
  }
  const sorted = intervals.map((interval) => [...interval])
    .sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const interval of sorted) {
    const previous = result.at(-1);
    if (previous && interval[0] < previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      result.push(interval);
    }
  }
  return result;
}

