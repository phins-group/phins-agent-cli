/** Windows ACL checks for private local-runtime metadata. */
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
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
$item = Get-Item -LiteralPath $env:PHINS_RUNTIME_PATH -Force
$acl = Get-Acl -LiteralPath $item.FullName
if ($env:PHINS_RUNTIME_PROTECT -eq '1') {
  if (-not $item.PSIsContainer -or $allowed -notcontains $acl.GetOwner($kind).Value) {
    throw 'Runtime directory is not owned by a trusted principal'
  }
  $private = [System.Security.AccessControl.DirectorySecurity]::new()
  $private.SetOwner($user)
  $private.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowed | Select-Object -Unique) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new($sid),
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]3,
      [System.Security.AccessControl.PropagationFlags]0,
      [System.Security.AccessControl.AccessControlType]0)
    $private.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $item.FullName -AclObject $private
  $acl = Get-Acl -LiteralPath $item.FullName
}
$rules = @($acl.GetAccessRules($true, $true, $kind) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; type = [int]$_.AccessControlType;
     rights = [int]$_.FileSystemRights }
})
@{ user = $user.Value; owner = $acl.GetOwner($kind).Value; rules = $rules } |
  ConvertTo-Json -Depth 4 -Compress
`

export async function windowsRuntimePrivacy(file: string, protect = false) {
  if (process.platform !== "win32") throw new Error("Windows ACL check requires Windows")
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.isAbsolute(file) || file.startsWith("\\\\"))
    throw new Error("Local Windows runtime path is required")
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE"])
    if (process.env[name] !== undefined) env[name] = process.env[name]
  env.PHINS_RUNTIME_PATH = file
  env.PHINS_RUNTIME_PROTECT = protect ? "1" : "0"
  try {
    const { stdout } = await execute(path.join(systemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(inspectAcl, "utf16le").toString("base64")],
    { env, windowsHide: true, timeout: 10_000, maxBuffer: 16_384 })
    return privateRuntimeAcl(JSON.parse(stdout.trim()))
  } catch {
    throw new Error("Unable to verify private Windows runtime permissions")
  }
}
