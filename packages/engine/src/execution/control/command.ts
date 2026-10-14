import { createHash } from "node:crypto"
import z from "zod"
import * as ControlGrant from "./grant"

export const Expected = ControlGrant.Expected.extend({
  action: z.literal("prompt"),
  attempt: ControlGrant.Attempt.unwrap().readonly(),
})
export type Expected = z.infer<typeof Expected>

const Payload = z
  .strictObject({
    text: z
      .string()
      .max(8000)
      .refine((value) => Boolean(value.trim()) && !value.includes("\0")),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024)
  .readonly()
const Command = z
  .strictObject({
    version: z.literal("phins.node-control.v1"),
    id: z.uuid().transform((value) => value.toLowerCase()),
    action: z.literal("prompt"),
    delivery: z.literal("queue"),
    payload: Payload,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: ControlGrant.Proof.unwrap().shape.expiresAt,
  })
  .readonly()

/** Immutable command data and current proof, never permission to run tools. */
export const Proof = ControlGrant.ControlProof.unwrap()
  .extend({
    action: z.literal("prompt"),
    attempt: Expected.shape.attempt,
    command: Command,
  })
  .readonly()
export type Proof = z.infer<typeof Proof>

export function matches(proof: Proof, expected: Expected) {
  return (
    proof.command.id === expected.attempt.id &&
    proof.attempt.kind === expected.attempt.kind &&
    proof.attempt.id === expected.attempt.id &&
    proof.attempt.leaseId === expected.attempt.leaseId &&
    proof.command.payloadHash ===
      createHash("sha256")
        .update(JSON.stringify(proof.command.payload))
        .digest("hex") &&
    Date.parse(proof.command.expiresAt) > Date.now() &&
    Date.parse(proof.expiresAt) <= Date.parse(proof.command.expiresAt)
  )
}
