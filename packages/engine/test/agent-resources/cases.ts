export const names = [
  "alpha",
  "beta",
  "denied",
  "disabled",
  "revoked",
  "mismatch",
  "stale",
  "unbound",
  "native",
  "native-revoked",
] as const
export type Case = (typeof names)[number]
export const identity = (name: Case) => {
  const suffix = String(names.indexOf(name) + 1).padStart(12, "0")
  const native = name === "native" || name === "native-revoked"
  return {
    workspaceId: `10000000-0000-4000-8000-${suffix}`,
    id: `20000000-0000-4000-8000-${suffix}`,
    leaseId: `30000000-0000-4000-8000-${suffix}`,
    resourceId: `40000000-0000-4000-8000-${suffix}`,
    deviceId: native ? `50000000-0000-4000-8000-${suffix}` : `qa-${name}`,
    userId: `60000000-0000-4000-8000-${suffix}`,
    sessionId: `70000000-0000-4000-8000-${suffix}`,
    native,
  }
}
