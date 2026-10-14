/** Windows ACL checks for private local-runtime metadata. */
import { execFileSync } from "node:child_process"
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
    if (rule.sid === acl.user && ((rule.rights as number) & fullControl) === fullControl)
      ownerAccess = true
  }
  return ownerAccess
}

const inspectAcl = `
$ErrorActionPreference = 'Stop'
$kind = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
$file = [System.IO.Path]::GetFullPath($env:PHINS_RUNTIME_PATH)
$isDirectory = [System.IO.Directory]::Exists($file)
if ($isDirectory) { $acl = [System.IO.Directory]::GetAccessControl($file) }
else { $acl = [System.IO.File]::GetAccessControl($file) }
if ($env:PHINS_RUNTIME_PROTECT -eq '1') {
  if (-not $isDirectory -or $allowed -notcontains $acl.GetOwner($kind).Value) {
    throw 'Runtime directory is not owned by a trusted principal'
  }
  $private = [System.Security.AccessControl.DirectorySecurity]::new()
  $private.SetOwner($user)
  $private.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowed) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new($sid),
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]3,
      [System.Security.AccessControl.PropagationFlags]0,
      [System.Security.AccessControl.AccessControlType]0)
    $private.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($file, $private)
  $acl = [System.IO.Directory]::GetAccessControl($file)
}
$rules = [System.Collections.Generic.List[string]]::new()
foreach ($rule in $acl.GetAccessRules($true, $true, $kind)) {
  $sid = $rule.IdentityReference.Value
  $type = [int]$rule.AccessControlType
  $rights = [int]$rule.FileSystemRights
  $rules.Add('{"sid":"' + $sid + '","type":' + $type + ',"rights":' + $rights + '}')
}
# SIDs are canonical numeric identifiers; rights/type are integers.
[System.Console]::WriteLine('{"user":"' + $user.Value + '","owner":"' +
  $acl.GetOwner($kind).Value + '","rules":[' + [string]::Join(',', $rules) + ']}')
`
export async function windowsRuntimePrivacy(file: string, protect = false) {
  if (process.platform !== "win32") throw new Error("Windows ACL check requires Windows")
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.isAbsolute(file) || file.startsWith("\\\\"))
    throw new Error("Local Windows runtime path is required")
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE",
    "PATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramData", "SystemDrive"])
    if (process.env[name] !== undefined) env[name] = process.env[name]
  env.PSModulePath = path.join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules")
  env.PHINS_RUNTIME_PATH = file
  env.PHINS_RUNTIME_PROTECT = protect ? "1" : "0"
  try {
    const stdout = execFileSync(path.join(systemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(inspectAcl, "utf16le").toString("base64")],
    { env, windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return privateRuntimeAcl(JSON.parse(stdout.trim()))
  } catch {
    throw new Error("Unable to verify private Windows runtime permissions")
  }
}
