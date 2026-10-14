import { createHash } from "node:crypto"

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
export const toolName = (server: string, tool: string) =>
  sanitize(server) + "_" + sanitize(tool)

/** Keep the legacy names and disambiguate sanitized collisions deterministically. */
export function names(input: ReadonlyArray<{ server: string; tool: string }>) {
  const counts = new Map<string, number>()
  const bases = input.map((item) => {
    const base = toolName(item.server, item.tool)
    counts.set(base, (counts.get(base) ?? 0) + 1)
    return base
  })
  return input.map((item, index) => {
    const base = bases[index]!
    return counts.get(base) === 1 && base.length <= 64
      ? base
      : `${base.slice(0, 51)}_${createHash("sha256")
          .update(JSON.stringify([item.server, item.tool]))
          .digest("hex")
          .slice(0, 12)}`
  })
}

export * as McpToolNames from "./tool-names"
