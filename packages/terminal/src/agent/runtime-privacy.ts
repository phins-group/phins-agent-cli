/** Windows ACL checks for private local-runtime metadata. */
import { lstat } from "node:fs/promises"
import path from "node:path"
const fullControl = 0x1f01ff
const system = "S-1-5-18"
const administrators = "S-1-5-32-544"

export function privateRuntimeAcl(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const acl = value as Record<string, unknown>
  if (typeof acl.user !== "string" || !/^S-\d-(?:\d+-)+\d+$/.test(acl.user)
    || typeof acl.owner !== "string" || !Array.isArray(acl.rules)) return false
  const trusted = new Set([acl.user, system, administrators])
  if (!trusted.has(acl.owner) || acl.rules.length === 0) return false
  let ownerAccess = false
  for (const value of acl.rules) {
    if (!value || typeof value !== "object") return false
    const rule = value as Record<string, unknown>
    if (typeof rule.sid !== "string" || !Number.isSafeInteger(rule.rights)
      || ![0, 1].includes(rule.type as number)) return false
    if (rule.type === 1) continue
    if (!trusted.has(rule.sid)) return false
    if (rule.sid === acl.user && rule.inheritOnly !== true
      && ((rule.rights as number) & fullControl) === fullControl)
      ownerAccess = true
  }
  return ownerAccess
}

let native: ReturnType<typeof import("./windows-acl").openWindowsAcl> | undefined

export async function windowsRuntimePrivacy(file: string, protect = false) {
  if (process.platform !== "win32") throw new Error("Windows ACL check requires Windows")
  if (!path.isAbsolute(file) || file.startsWith("\\\\") || file.includes("\0"))
    throw new Error("Local Windows runtime path is required")
  const info = await lstat(file)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return false
  native ??= (await import("./windows-acl")).openWindowsAcl()
  let acl = native.inspect(file)
  if (protect) {
    if (!info.isDirectory() || ![acl.user, system, administrators].includes(acl.owner))
      throw new Error("Runtime directory is not owned by a trusted principal")
    native.protect(file, acl.user)
    acl = native.inspect(file)
  }
  return privateRuntimeAcl(acl)
}
