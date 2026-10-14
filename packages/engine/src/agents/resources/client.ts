import z from "zod"
import { Manifest, Project, sameProject } from "./contract"
import { ResourceError } from "./error"

export interface Options {
  readonly baseUrl: string
  readonly token: (signal: AbortSignal) => Promise<string>
  readonly kind: "jobs" | "tasks"
  readonly id: string
  readonly leaseId: string
  readonly project: Project
  /** Pin a native Node login and require the transaction-bound endpoint. */
  readonly nodeSessionId?: string
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

const Binding = z
  .object({
    kind: z.enum(["jobs", "tasks"]),
    id: z.uuid(),
    leaseId: z.uuid(),
    project: Project,
    nodeSessionId: z.uuid().optional(),
  })
  .refine(
    (input) =>
      !input.nodeSessionId ||
      z.uuid().safeParse(input.project.deviceId).success,
    {
      message: "A native binding requires a registered Node UUID",
    },
  )
const TIMEOUT_MS = 30_000
const RESPONSE_LIMIT = 4 * 1024 * 1024

async function responseJSON(response: Response, signal: AbortSignal) {
  if (!response.body)
    throw new ResourceError({ message: "Invalid resource response" })
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
      if (size > RESPONSE_LIMIT)
        throw new ResourceError({
          message: "Resource response exceeds the 4 MiB limit",
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

/** Trusted host capability. Model/client input never supplies this binding. */
export function create(options: Options) {
  const binding = Binding.safeParse(options)
  let origin: string
  try {
    const url = new URL(options.baseUrl)
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
    origin = url.origin
  } catch {
    throw new ResourceError({
      message: "Resources require a trusted HTTPS origin or loopback HTTP",
    })
  }
  if (!binding.success)
    throw new ResourceError({ message: "Invalid fenced resource binding" })
  const { kind, id, leaseId, project, nodeSessionId } = binding.data
  const token = options.token
  const fetchImpl = options.fetch ?? globalThis.fetch
  const endpoint = `${origin}/v1/${nodeSessionId ? "agent/node" : "channels/agent"}/${kind}/${id}/resources`
  const load = async (signal: AbortSignal): Promise<Manifest> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(abort, TIMEOUT_MS)
    try {
      controller.signal.throwIfAborted()
      // One credential snapshot covers both the read and its receipt.
      const credential = await token(controller.signal)
      controller.signal.throwIfAborted()
      if (
        typeof credential !== "string" ||
        !credential ||
        credential.length > 16384 ||
        /[\s\x00-\x1f\x7f]/.test(credential)
      )
        throw new ResourceError({ message: "No valid resource credential" })
      const request = async (receivedRevision?: string) => {
        controller.signal.throwIfAborted()
        const response = await fetchImpl(
          receivedRevision ? `${endpoint}/received` : endpoint,
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
              deviceId: project.deviceId,
              leaseId,
              ...(nodeSessionId
                ? { workspaceId: project.workspaceId, sessionId: nodeSessionId }
                : {}),
              ...(receivedRevision ? { revision: receivedRevision } : {}),
            }),
            signal: controller.signal,
          },
        )
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new ResourceError({
            message:
              "Resource authorization, lease or request is no longer valid",
            status: response.status,
          })
        }
        return responseJSON(response, controller.signal)
      }
      const decoded = Manifest.safeParse(await request())
      if (!decoded.success)
        throw new ResourceError({ message: "Invalid resource manifest" })
      if (!sameProject(decoded.data.project, project))
        throw new ResourceError({
          message: "Resources belong to another workspace, Node or project",
        })
      const receipt = await request(decoded.data.revision)
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("ok" in receipt) ||
        receipt.ok !== true
      )
        throw new ResourceError({
          message: "Resource receipt was not confirmed",
        })
      controller.signal.throwIfAborted()
      return decoded.data
    } catch (error) {
      if (error instanceof ResourceError) throw error
      // Neither upstream exception messages nor invalid payloads are safe output.
      throw new ResourceError({
        message: controller.signal.aborted
          ? "Resource request cancelled or timed out"
          : "Could not load authorized project resources",
      })
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
    }
  }
  return { project, load }
}
