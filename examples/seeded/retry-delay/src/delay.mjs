export function retryDelay(attempt, baseMs, capMs, retryAfter) {
  if (!Number.isInteger(attempt) || attempt < 0 ||
      !Number.isFinite(baseMs) || baseMs <= 0 ||
      !Number.isFinite(capMs) || capMs < baseMs) {
    throw new RangeError("Invalid retry policy");
  }
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(capMs, seconds * 1000);
  }
  return Math.min(capMs, baseMs * 2 ** attempt);
}

