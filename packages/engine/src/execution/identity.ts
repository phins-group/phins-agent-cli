import { Schema } from "effect"
import z from "zod"
import type { Options as ResourceOptions } from "../agents/resources/client"
import { ResourceError } from "../agents/resources/error"
import * as ControlGrant from "./control/grant"
import * as ControlCommand from "./control/command"

export class IdentityError extends Schema.TaggedErrorClass<IdentityError>()(
  "NodeIdentity.Error",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    retryable: Schema.optional(Schema.Boolean),
  },
) {}

const Expected = z.strictObject({
  nodeId: z.uuid(),
  userId: z.uuid(),
  workspaceId: z.uuid(),
})
const Identity = Expected.extend({
  version: z.literal(1),
  sessionId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
})
export type Identity = Readonly<z.infer<typeof Identity>>

export interface Options {
  readonly baseUrl: string
  readonly expected: z.infer<typeof Expected>
  readonly token: (signal: AbortSignal) => Promise<string>
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}
type Execution = Pick<ResourceOptions, "kind" | "id" | "leaseId"> & {
  readonly directory: string
}
const Work = z.strictObject({
  kind: z.enum(["jobs", "tasks"]),
  id: z.uuid(),
  leaseId: z.uuid(),
  directory: z
    .string()
    .max(2000)
    .refine((value) => Boolean(value.trim()) && !value.includes("\0")),
})
const WorkIdentity = Identity.extend(Work.shape)
export type WorkIdentity = Readonly<z.infer<typeof WorkIdentity>>

/** Bounded JSON decoding shared by native adapters; never an authorization check. */
export async function responseJSON(
  response: Response,
  signal: AbortSignal,
  scope = "identity",
  maximumBytes = 16 * 1024,
) {
  if (!response.body)
    throw new IdentityError({ message: `Invalid Node ${scope} response` })
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumBytes)
        throw new IdentityError({
          message: `Node ${scope} response exceeds the ${maximumBytes / 1024} KiB limit`,
        })
      chunks.push(chunk.value)
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown
  } finally {
    signal.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Accept only an origin, without a credential, query or application path. */
export function trustedOrigin(baseUrl: string) {
  try {
    const url = new URL(baseUrl)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error()
    return url.origin
  } catch {
    throw new IdentityError({
      message: "Node identity requires a trusted HTTPS origin or loopback HTTP",
    })
  }
}

/** Host-only adapter. Identity proves a login, never execution or sharing rights. */
export async function authenticate(options: Options, signal: AbortSignal) {
  const expected = Expected.safeParse(options.expected)
  const origin = trustedOrigin(options.baseUrl)
  if (!expected.success)
    throw new IdentityError({ message: "Invalid expected Node identity" })
  const owner = Object.freeze(expected.data)
  const token = options.token
  const fetchImpl = options.fetch ?? globalThis.fetch
  const request = async (signal: AbortSignal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      deadline.throwIfAborted()
      const credential = await token(deadline)
      deadline.throwIfAborted()
      if (
        typeof credential !== "string" ||
        !credential ||
        credential.length > 16384 ||
        /[\s\x00-\x1f\x7f]/.test(credential)
      )
        throw new IdentityError({ message: "No valid Node credential" })
      const response = await fetchImpl(`${origin}/v1/agent/node/identity`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: owner.nodeId,
          workspaceId: owner.workspaceId,
        }),
        signal: deadline,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new IdentityError({
          message: "Node identity is unavailable or no longer authorized",
          status: response.status,
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        })
      }
      const decoded = Identity.safeParse(await responseJSON(response, deadline))
      if (!decoded.success)
        throw new IdentityError({ message: "Invalid Node identity response" })
      const identity = decoded.data
      if (
        identity.nodeId !== owner.nodeId ||
        identity.userId !== owner.userId ||
        identity.workspaceId !== owner.workspaceId ||
        Date.parse(identity.expiresAt) <= Date.now()
      )
        throw new IdentityError({
          message: "Node identity does not match this binding or has expired",
        })
      deadline.throwIfAborted()
      return { identity: Object.freeze(identity), credential }
    } catch (error) {
      if (error instanceof IdentityError) throw error
      throw new IdentityError({
        message: deadline.aborted
          ? "Node identity request cancelled or timed out"
          : "Could not verify Node identity",
        retryable: !signal.aborted,
      })
    }
  }
  const { identity } = await request(signal)
  const current = async (signal: AbortSignal) => {
    const result = await request(signal)
    if (result.identity.sessionId !== identity.sessionId)
      throw new IdentityError({
        message: "Node login changed; a new binding is required",
      })
    return result
  }
  const controlRequest = async <Result extends ControlGrant.Proof>(
    expected: ControlGrant.Expected,
    schema: z.ZodType<Result>,
    signal: AbortSignal,
    attempt?: ControlGrant.Attempt,
    command?: "record" | "verify",
  ): Promise<Result> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      const { credential, identity: live } = await current(deadline)
      deadline.throwIfAborted()
      const response = await fetchImpl(
        `${origin}/v1/agent/node/control/grants/${expected.id}/${
          command
            ? `commands/${attempt!.id}${command === "verify" ? "/verify" : ""}`
            : `verify${attempt ? "-attempt" : ""}`
        }`,
        {
          method: command === "record" ? "PUT" : "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId: owner.nodeId,
            workspaceId: owner.workspaceId,
            sessionId: identity.sessionId,
            revision: expected.revision,
            action: expected.action,
            scope: expected.scope,
            ...(attempt ? { attempt } : {}),
          }),
          signal: deadline,
        },
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new IdentityError({
          message: "Node grant is unavailable or no longer authorized",
          status: response.status,
        })
      }
      // Grant writes accept 64 KiB; command proofs add a 32 KiB payload.
      const decoded = schema.safeParse(
        await responseJSON(
          response,
          deadline,
          "grant",
          (command ? 128 : 80) * 1024,
        ),
      )
      if (!decoded.success)
        throw new IdentityError({ message: "Invalid Node grant response" })
      if (!ControlGrant.matches(decoded.data, expected, live))
        throw new IdentityError({
          message: "Node grant does not match this scope or has expired",
        })
      deadline.throwIfAborted()
      return decoded.data
    } catch (error) {
      if (error instanceof IdentityError) throw error
      throw new IdentityError({
        message: deadline.aborted
          ? "Node grant request cancelled or timed out"
          : "Could not verify Node grant",
      })
    }
  }
  const commandRequest = (
    mode: "record" | "verify",
    input: ControlCommand.Expected,
    signal: AbortSignal,
  ) => {
    const expected = ControlCommand.Expected.safeParse(input)
    if (!expected.success)
      throw new IdentityError({
        message: "Invalid expected Node prompt command",
      })
    return controlRequest(
      expected.data,
      ControlCommand.Proof.refine((proof) =>
        ControlCommand.matches(proof, expected.data),
      ),
      signal,
      expected.data.attempt,
      mode,
    )
  }
  return {
    identity,
    verify: async (signal: AbortSignal) => (await current(signal)).identity,
    /** Explicit native producer: stores only a binding/hash, never dispatches. */
    recordCommand: async (
      input: ControlCommand.Expected,
      signal: AbortSignal,
    ) => commandRequest("record", input, signal),
    /** Reads an already bound command; never creates or renews one. */
    verifyCommand: async (
      input: ControlCommand.Expected,
      signal: AbortSignal,
    ) => commandRequest("verify", input, signal),
    /** A grant snapshot alone does not prove a queue actor, command or session. */
    verifyGrant: async (input: ControlGrant.Expected, signal: AbortSignal) => {
      const expected = ControlGrant.Expected.safeParse(input)
      if (!expected.success)
        throw new IdentityError({ message: "Invalid expected Node grant" })
      return controlRequest(expected.data, ControlGrant.Proof, signal)
    },
    /** Joins grant and native queue actor/source/lease; no execution is dispatched. */
    verifyControl: async (
      input: ControlGrant.ExpectedControl,
      signal: AbortSignal,
    ) => {
      const expected = ControlGrant.ExpectedControl.safeParse(input)
      if (!expected.success)
        throw new IdentityError({
          message: "Invalid expected Node control attempt",
        })
      const schema = ControlGrant.ControlProof.refine(
        (proof) =>
          proof.attempt.kind === expected.data.attempt.kind &&
          proof.attempt.id === expected.data.attempt.id &&
          proof.attempt.leaseId === expected.data.attempt.leaseId,
      )
      return controlRequest(
        expected.data,
        schema,
        signal,
        expected.data.attempt,
      )
    },
    /** Rechecks a native queue attempt, never authorizes remote session/tools. */
    verifyWork: async (
      execution: Execution,
      signal: AbortSignal,
    ): Promise<WorkIdentity> => {
      const parsed = Work.safeParse(execution)
      if (!parsed.success)
        throw new IdentityError({ message: "Invalid expected Node work" })
      const work = parsed.data
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      try {
        const { credential, identity: live } = await current(deadline)
        deadline.throwIfAborted()
        const response = await fetchImpl(
          `${origin}/v1/agent/node/${work.kind}/${work.id}/verify`,
          {
            method: "POST",
            redirect: "error",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${credential}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              deviceId: owner.nodeId,
              workspaceId: owner.workspaceId,
              sessionId: identity.sessionId,
              leaseId: work.leaseId,
              directory: work.directory,
            }),
            signal: deadline,
          },
        )
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new IdentityError({
            message: "Node work is unavailable or no longer authorized",
            status: response.status,
          })
        }
        const decoded = WorkIdentity.safeParse(
          await responseJSON(response, deadline, "work"),
        )
        if (!decoded.success)
          throw new IdentityError({ message: "Invalid Node work response" })
        const result = decoded.data
        if (
          result.nodeId !== owner.nodeId ||
          result.userId !== owner.userId ||
          result.workspaceId !== owner.workspaceId ||
          result.sessionId !== identity.sessionId ||
          result.kind !== work.kind ||
          result.id !== work.id ||
          result.leaseId !== work.leaseId ||
          result.directory !== work.directory ||
          Date.parse(result.expiresAt) <= Date.now() ||
          Date.parse(result.expiresAt) > Date.parse(live.expiresAt)
        )
          throw new IdentityError({
            message: "Node work does not match this attempt or has expired",
          })
        deadline.throwIfAborted()
        return Object.freeze(result)
      } catch (error) {
        if (error instanceof IdentityError) throw error
        throw new IdentityError({
          message: deadline.aborted
            ? "Node work request cancelled or timed out"
            : "Could not verify Node work",
        })
      }
    },
    /** Credentials are reverified after tool permission, for every read/receipt. */
    resources: (execution: Execution): ResourceOptions => ({
      baseUrl: origin,
      kind: execution.kind,
      id: execution.id,
      leaseId: execution.leaseId,
      nodeSessionId: identity.sessionId,
      project: {
        deviceId: owner.nodeId,
        workspaceId: owner.workspaceId,
        directory: execution.directory,
      },
      fetch: fetchImpl,
      token: async (signal) => {
        try {
          return (await current(signal)).credential
        } catch (error) {
          if (error instanceof IdentityError)
            throw new ResourceError({
              message: error.message,
              status: error.status,
            })
          throw new ResourceError({
            message: "Could not verify the resource Node",
          })
        }
      },
    }),
  }
}
