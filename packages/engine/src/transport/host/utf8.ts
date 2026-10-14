/** Utilities for enforcing exact UTF-8 transport bounds. @module */

const codePointBytes = (codePoint: number) =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

/**
 * Return the longest code-point-aligned prefix whose UTF-8 encoding fits the
 * supplied byte limit. The scan stops as soon as the limit is reached, so a
 * very large rejected payload cannot force another full-string traversal.
 */
export function truncateUtf8(value: string, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError("maximumBytes must be a non-negative safe integer")

  let bytes = 0
  let end = 0
  for (const character of value) {
    const next = codePointBytes(character.codePointAt(0)!)
    if (bytes + next > maximumBytes) break
    bytes += next
    end += character.length
  }
  return end === value.length ? value : value.slice(0, end)
}

export * as Utf8 from "./utf8"
