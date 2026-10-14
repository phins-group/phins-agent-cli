import { isDeepStrictEqual } from "node:util"
import z from "zod"
import type { Identity } from "../identity"

const text = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => Boolean(value.trim()) && !value.includes("\0"))
const id = z.uuid().transform((value) => value.toLowerCase())
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const action = z.enum([
  "view",
  "prompt",
  "resume",
  "interrupt",
  "permission.reply",
  "question.reply",
  "question.reject",
])

export const Scope = z
  .strictObject({
    source: z.enum(["web", "channel"]),
    granteeUserId: id,
    projectId: text(128),
    targetSessionId: text(128),
    directory: text(2000),
    syncWorkspaceId: text(128).nullable(),
  })
  .readonly()

export const Attempt = z
  .strictObject({
    kind: z.enum(["jobs", "tasks"]),
    id,
    leaseId: id,
  })
  .readonly()
export type Attempt = z.infer<typeof Attempt>

export const Expected = z.strictObject({ id, revision, action, scope: Scope })
export type Expected = z.infer<typeof Expected>
export const SharedBindings = z
  .array(Expected.extend({ action: z.literal("view") }))
  .max(64)
  .refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
  )
/** A queued route must select exactly one explicitly configured prompt target. */
export const PromptBindings = z
  .array(Expected.extend({ action: z.literal("prompt") }))
  .min(1)
  .max(64)
  .refine(
    (bindings) =>
      new Set(bindings.map((binding) => binding.id)).size === bindings.length,
  )
  .refine(
    (bindings) =>
      new Set(
        bindings.map((binding) =>
          JSON.stringify([
            binding.scope.source,
            binding.scope.granteeUserId,
            binding.scope.directory,
          ]),
        ),
      ).size === bindings.length,
  )
export const ExpectedControl = Expected.extend({ attempt: Attempt })
export type ExpectedControl = z.infer<typeof ExpectedControl>

const Rule = z
  .strictObject({
    action: text(128),
    resource: text(1024),
    effect: z.enum(["allow", "deny"]),
  })
  .readonly()
const fields = Expected.extend({
  version: z.literal(1),
  ownerUserId: z.uuid(),
  nodeId: z.uuid(),
  workspaceId: z.uuid(),
  loginSessionId: z.uuid(),
  actions: z
    .array(action)
    .min(1)
    .max(action.options.length)
    .refine((values) => new Set(values).size === values.length)
    .readonly(),
  rules: z.array(Rule).max(64).readonly(),
  expiresAt: z.iso
    .datetime()
    .refine(
      (value) =>
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    ),
})

/** Immutable snapshot data, never a cached permission or execution receipt. */
export const Proof = fields.readonly()
export type Proof = z.infer<typeof Proof>
export const ControlProof = fields.extend({ attempt: Attempt }).readonly()
export type ControlProof = z.infer<typeof ControlProof>

export function matches(proof: Proof, expected: Expected, live: Identity) {
  return (
    proof.id === expected.id &&
    proof.revision === expected.revision &&
    proof.action === expected.action &&
    proof.actions.includes(expected.action) &&
    proof.ownerUserId === live.userId &&
    proof.nodeId === live.nodeId &&
    proof.workspaceId === live.workspaceId &&
    proof.loginSessionId === live.sessionId &&
    isDeepStrictEqual(proof.scope, expected.scope) &&
    Date.parse(proof.expiresAt) > Date.now() &&
    Date.parse(proof.expiresAt) <= Date.parse(live.expiresAt)
  )
}
