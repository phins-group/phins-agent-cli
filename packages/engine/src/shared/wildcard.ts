export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

export function all<T>(input: string, patterns: Record<string, T>) {
  let result: T | undefined
  for (const [pattern, value] of sortedEntries(patterns)) {
    if (match(input, pattern)) result = value
  }
  return result
}

export function allStructured<T>(input: { head: string; tail: string[] }, patterns: Record<string, T>) {
  let result: T | undefined
  for (const [pattern, value] of sortedEntries(patterns)) {
    const parts = pattern.split(/\s+/)
    const head = parts[0]
    if (!head || !match(input.head, head)) continue
    if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) result = value
  }
  return result
}

function sortedEntries<T>(patterns: Record<string, T>) {
  return Object.entries(patterns).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return true
  const [pattern, ...rest] = patterns
  if (pattern === "*") return matchSequence(items, rest)
  if (!pattern) return false
  for (let i = 0; i < items.length; i++) {
    if (match(items[i]!, pattern) && matchSequence(items.slice(i + 1), rest)) return true
  }
  return false
}
