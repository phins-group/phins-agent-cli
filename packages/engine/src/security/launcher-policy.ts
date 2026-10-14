/** Launcher-only constraints for reviewed autonomous demo projects. */
import path from "node:path"
import { realpathSync } from "node:fs"
import { Effect } from "effect"
import { ToolFailure } from "../inference/tools/failure"

export const enabled = process.env.PHINS_SAFE_MODE === "1"
const commandJSON = process.env.PHINS_ALLOWED_COMMANDS ?? "[]"
const protectedJSON = process.env.PHINS_PROTECTED_PATHS ?? "[]"
const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.phins|\.codex|\.agents|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i
export const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
function strings(value: string) {
  const items: unknown = JSON.parse(value)
  if (!Array.isArray(items) || items.some((x) => typeof x !== "string" || !x.length))
    throw new Error("Invalid launcher policy")
  return items as string[]
}
export function commands() { return strings(commandJSON) }
function resolveCanonical(target: string) {
  let anchor = path.resolve(target)
  const suffix: string[] = []
  while (true) {
    try { anchor = realpathSync(anchor); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      suffix.unshift(path.basename(anchor))
      const parent = path.dirname(anchor)
      if (parent === anchor) throw error
      anchor = parent
    }
  }
  return path.join(anchor, ...suffix)
}
export function protectedPaths(root: string) {
  const canonicalRoot = realpathSync(root)
  return strings(protectedJSON).flatMap((item) => {
    const target = path.resolve(canonicalRoot, item)
    const canonical = resolveCanonical(target)
    if (!inside(canonicalRoot, target) || !inside(canonicalRoot, canonical))
      throw new Error("Protected path escapes project")
    return target === canonical ? [target] : [target, canonical]
  })
}
/** Includes realpath containment, so a symlink cannot reveal an external file. */
export function permitted(root: string, target: string, write = false) {
  try {
    const canonicalRoot = realpathSync(root)
    const canonical = resolveCanonical(target)
    return inside(canonicalRoot, canonical) &&
      !path.relative(canonicalRoot, canonical).split(path.sep).some((part) => sensitive.test(part) || (write && part === ".git")) &&
      (!write || !protectedPaths(canonicalRoot).some((p) => inside(p, canonical)))
  } catch { return false }
}
export const assertPath = (root: string, target: string, write = false) =>
  !enabled || permitted(root, target, write) ? Effect.void : Effect.fail(new ToolFailure({ message: "Launcher policy denies this path" }))
export const assertCommand = (command: string, background = false) => Effect.try({
  try: () => {
    if (enabled && (background || !commands().includes(command))) throw new Error()
  },
  catch: () => new ToolFailure({ message: "Command is outside the launcher's reviewed test-command list" }),
})
/** Never inherit credentials, loader hooks, shell startup hooks or proxy settings. */
export const childEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR"].flatMap(
    (key) => input[key] === undefined ? [] : [[key, input[key]!]],
  ))
