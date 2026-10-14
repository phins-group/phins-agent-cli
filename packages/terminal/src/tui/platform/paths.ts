import path from "path"
import { realpathSync } from "node:fs"
import { win32 } from "node:path"

export function normalizePath(input: string, platform: string) {
  if (platform !== "win32") return input
  const resolved = win32.normalize(win32.resolve(input.replaceAll("/", "\\")))
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  return "~" + path.sep + relative
}
