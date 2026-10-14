/** Private project runtime of the existing Agent CLI, not the remote Node host. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { AppPaths } from "@phins/engine/runtime/paths"
import { Flock } from "@phins/engine/shared/flock"
import { InstallationVersion } from "@phins/engine/runtime/version"
import { SessionExecution } from "@phins/engine/sessions/run/execution"
import { SessionStore } from "@phins/engine/sessions/store"
import { Session as SessionSchema } from "@phins/engine/contracts/session/info"
import { AbsolutePath } from "@phins/engine/shared/schema"
import { SessionsCursor } from "@phins/engine/transport/api/resources/session"

import { Credential } from "@phins/engine/security/credentials"
import { PermissionSaved } from "@phins/engine/security/permissions/saved"

import { ServerRuntime } from "@phins/engine/transport/host/runtime"
import { ServiceControl } from "@phins/engine/transport/host/service-control"
import { createRoutes } from "@phins/engine/transport/host/routes"
import { createClientLeases } from "./client-leases"
import { boundAgentLog } from "./process-log"

import {
  projectDirectory,
  projectKey,
  removeRegistration,
  writeRegistration,
  type AgentRegistration,
} from "./registry"
import type { AgentMode } from "./process"

export async function runAgentHost(input: {
  directory: string
  nonce: string
  mode: AgentMode
}) {
  const directory = await projectDirectory(input.directory)
  const lock = await Flock.acquire(`agent-host-${projectKey(directory)}`, {
    dir: path.join(AppPaths.directories.state, "locks"),
    timeoutMs: 0,
    recoverDeadOwner: true,
  })
  try {
    await projectRuntime(input, directory)
  } finally {
    await lock.release()
  }
}

async function projectRuntime(
  input: { nonce: string; mode: AgentMode },
  directory: string,
) {
  const id = randomUUID(),
    password = randomBytes(32).toString("hex")
  const authorization = `Basic ${Buffer.from(`phins:${password}`).toString("base64")}`
  const expectedAuthorization = Buffer.from(authorization)
  const scope = await Effect.runPromise(Scope.make())
  const memoMap = Layer.makeMemoMapUnsafe()
  const context = await Effect.runPromise(
    Layer.buildWithMemoMap(
      ServerRuntime.layer.pipe(
        Layer.provideMerge(PermissionSaved.defaultLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
      memoMap,
      scope,
    ),
  )
  const execution = Context.get(context, SessionExecution.Service)
  const store = Context.get(context, SessionStore.Service)
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const clients = createClientLeases({
    keepRemote: false,
    running: async (value) => {
      const state = await run(store.runState(SessionSchema.ID.make(value)))
      return state?.status === "busy" || state?.status === "retrying"
    },
    stop: async (value) => {
      if (!execution.captureLocalInterrupt)
        throw new Error("Agent chưa hỗ trợ dừng đúng owner local.")
      // Capture before any await. Durable state alone cannot distinguish a
      // remote admission that has not published its inputID yet.
      const stop = await run(execution.captureLocalInterrupt(
        SessionSchema.ID.make(value),
      ))
      if (stop) await run(stop)
    },
  })
  
  const control = await Effect.runPromise(
    ServiceControl.make(id).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const web = HttpRouter.toWebHandler(
    createRoutes(password, Layer.succeed(ServiceControl.Service, control)).pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provide(Credential.defaultLayer),
      Layer.provide(PermissionSaved.defaultLayer),
    ),
    { memoMap, disableLogger: true },
  )
  let registration: AgentRegistration | undefined,
    closing = false

  const authenticate = (request: Request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "")
    return (
      actual.length === expectedAuthorization.length &&
      timingSafeEqual(actual, expectedAuthorization)
    )
  }
  const json = (message: string, status = 409) =>
    Response.json({ message }, { status })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.hostname !== "127.0.0.1" || url.port !== String(server.port))
        return json("Invalid local host", 403)
      return handle(request, url)
    },
  })
  async function handle(request: Request, url: URL) {
    if (!authenticate(request))
      return json("Kết nối Agent local không được xác thực.", 401)
    if (
      request.headers.has("origin") ||
      request.headers.has("cookie")
    ) return json("Origin không được phép.", 403)
    if (request.headers.get("x-phins-service-generation") !== id)
      return json("The service generation has changed", 409)
    if (closing) return json("Agent đang đóng, không nhận thêm yêu cầu.", 503)
    const clientID = request.headers.get("x-phins-agent-client")
    try {
      if (url.pathname.startsWith("/api/agent/")) {
        if (request.method === "GET" && url.pathname === "/api/agent/status")
          return Response.json({
            protocol: "phins.agent-runtime.v1",
            id,
            directory,
            mode: input.mode,
            sessions: clients.sessions(),
            foregroundSessions: clients.foregroundSessions(),
            owners: clients.owners(),
          })
        if (request.method !== "POST")
          return json("Thao tác Agent không hợp lệ.", 405)
        const length = Number(request.headers.get("content-length") ?? 0)
        if (length > 4096) return json("Yêu cầu vượt giới hạn.", 413)
        const reader = request.body?.getReader()
        let text = "",
          bytes = 0
        if (reader) {
          const decoder = new TextDecoder()
          while (true) {
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.length
            if (bytes > 4096) {
              await reader.cancel()
              return json("Yêu cầu vượt giới hạn.", 413)
            }
            text += decoder.decode(part.value, { stream: true })
          }
          text += decoder.decode()
        }
        const body = JSON.parse(text || "{}")
        if (closing)
          return json("Agent đang đóng, không nhận thêm yêu cầu.", 503)
        if (url.pathname === "/api/agent/client/open") {
          if (!["tui", "headless"].includes(body.kind))
            return json("Loại giao diện không hợp lệ.", 400)
          return Response.json({ clientID: clients.open(body.kind) })
        }
        if (!clientID) return json("Thiếu kết nối giao diện.", 401)

        if (url.pathname === "/api/agent/client/release-observer")
          return Response.json({ released: clients.releaseObserver(clientID, true) })
        if (url.pathname === "/api/agent/close-idle") {
          await clients.prune()
          if (!clients.idle) return Response.json({ closed: false })
          closing = true
          setTimeout(() => { void stop().finally(() => finishHost?.()) }, 50)
          return Response.json({ closed: true }, { status: 202 })
        }
        // Closing is exact-lease and retry-safe, including a lost release ACK
        // or an expired lease. It never renews or admits work for that client.
        if (url.pathname !== "/api/agent/client/close")
          clients.heartbeat(clientID)

        if (url.pathname === "/api/agent/client/heartbeat")
          clients.heartbeat(clientID)
        else if (url.pathname === "/api/agent/client/background") {
          if (body.confirmed !== true)
            return json("Cần chủ động xác nhận chạy nền.", 400)
          clients.confirmBackground(clientID)
        } else if (url.pathname === "/api/agent/client/close") {
          if (typeof body.background !== "boolean")
            return json("Thiếu lựa chọn dừng hoặc chạy nền.", 400)
          await clients.close(clientID, body.background)
        } else return json("Không tìm thấy thao tác Agent.", 404)
        return Response.json({ ok: true })
      }
      // A project runtime may observe only its own project, including on reads.
      const belongs = async (value: string) =>
        (await projectDirectory(value).catch(() => undefined)) === directory
      const selectors = ["location[directory]", "directory"] as const
      for (const selector of selectors) {
        for (const value of url.searchParams.getAll(selector))
          if (!(await belongs(value)))
            return json("Kết nối thuộc project khác.", 403)
        if (url.searchParams.has(selector))
          url.searchParams.set(selector, directory)
      }
      const headerDirectory = request.headers.get("x-phins-directory")
      if (headerDirectory !== null) {
        let value = headerDirectory
        try {
          value = decodeURIComponent(value)
        } catch {
          // Match the protocol middleware's treatment of literal percent signs.
        }
        if (!(await belongs(value)))
          return json("Kết nối thuộc project khác.", 403)
      }
      if (
        url.pathname === "/api/session" &&
        ["GET", "HEAD"].includes(request.method)
      ) {
        url.searchParams.set("directory", directory)
        const cursor = url.searchParams.get("cursor")
        if (cursor) {
          // A cursor contains its own list scope and supersedes query fields.
          // Invalid cursors retain the protocol handler's existing error path.
          const parsed = await run(
            Effect.suspend(() => SessionsCursor.parse(cursor)),
          ).catch(() => undefined)
          if (parsed) {
            if (!("directory" in parsed) || !(await belongs(parsed.directory)))
              return json("Kết nối thuộc project khác.", 403)
            url.searchParams.set(
              "cursor", SessionsCursor.make({
                ...parsed, directory: AbsolutePath.make(directory),
              }),
            )
          }
        }
      }
      request = new Request(url, request)
      request.headers.set("x-phins-directory", encodeURIComponent(directory))
      const target = /^\/api\/(?:tui\/)?session\/([^/]+)/.exec(
        url.pathname,
      )?.[1]
      if (target) {
        const session = await run(
          store.get(SessionSchema.ID.make(decodeURIComponent(target))),
        )
        if (session && !(await belongs(session.location.directory)))
          return json("Session thuộc project khác.", 403)
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        clients.heartbeat(clientID)
        await clients.prune()
        if (
          request.headers.get("content-type")?.startsWith("application/json")
        ) {
          const body = (await request.clone().json()) as {
            id?: string
            directory?: string
            location?: { directory?: string }
          }
          if (
            (body.directory && !(await belongs(body.directory))) ||
            (body.location?.directory &&
              !(await belongs(body.location.directory)))
          )
            return json("Yêu cầu thuộc project khác.", 403)
          if (
            url.pathname === "/api/session" &&
            request.method === "POST" && typeof body.id === "string"
          ) {
            // Create is idempotent and may return a previously recorded ID.
            // The requested new location must not expose a foreign old row.
            const existing = await run(store.get(SessionSchema.ID.make(body.id)))
            if (existing && !(await belongs(existing.location.directory)))
              return json("Session thuộc project khác.", 403)
          }
          // New session locations must use the project runtime's canonical
          // directory. An accepted symlink alias must not create invisible
          // history or a second project identity when publishing to Web.
          if (url.pathname === "/api/session" && body.location?.directory) {
            const headers = new Headers(request.headers)
            headers.delete("content-length")
            request = new Request(request, {
              headers,
              body: JSON.stringify({
                ...body,
                location: { ...body.location, directory },
              }),
            })
          }
        }
        return await clients.withRequest(clientID, (signal) => {
            // Admission is after body/location validation, with no await
            // between lifetime validation, ownership claim and dispatch.
            if (closing)
              return Promise.resolve(json(
                "Agent đang đóng, không nhận thêm yêu cầu.", 503,
              ))
            if (target && !/\/(interrupt|wait)$/.test(url.pathname))
              clients.authorize(clientID, decodeURIComponent(target))
            if (
              target &&
              /\/(prompt|resume|shell|skill|compact|command)$/.test(url.pathname)
            )
              clients.claim(clientID, decodeURIComponent(target))
            return web.handler(
              new Request(request, {
                signal: AbortSignal.any([request.signal, signal]),
              }),
              context,
            )
          })
      }
      if (closing)
        return json("Agent đang đóng, không nhận thêm yêu cầu.", 503)
      return await web.handler(request, context)
    } catch (error) {
      return json(
        error instanceof Error
          ? error.message
          : "Không hoàn tất yêu cầu Agent.",
      )
    }
  }
  const connection = { authorization, "x-phins-service-generation": id }
  let timer: ReturnType<typeof setInterval> | undefined
  let finishHost: (() => void) | undefined
  let pendingTick = false,
    lastUsed = Date.now()
  
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return stopping
    closing = true
    if (timer) clearInterval(timer)
    return stopping = (async () => {
      try {
        for (const session of clients.sessions())
          await run(execution.interrupt(SessionSchema.ID.make(session)))
        await web.dispose()
        await Effect.runPromise(Scope.close(scope, Exit.void))
        if (registration) await removeRegistration(registration)
      } finally {
        server.stop(true)
      }
    })()
  }
  try {
    const ready = await fetch(new URL("/api/capabilities", server.url), {
      headers: connection,
    })
    if (!ready.ok) throw new Error("Agent chưa khởi tạo được runtime local.")
    registration = {
      protocol: "phins.agent-runtime.v1",
      id,
      pid: process.pid,
      directory,
      url: server.url.origin,
      password,
      version: InstallationVersion,
      mode: input.mode,
    }
    await writeRegistration(registration)
    process.stdout.write(
      JSON.stringify({
        kind: "phins-agent-ready",
        nonce: input.nonce,
        directory,
      }) + "\n",
    )
    // The caller closes the private handshake pipe. Runtime logging stays on stderr.
    console.log = (...values: unknown[]) => console.error(...values)
    const finished = new Promise<void>((resolve) => {
      finishHost = resolve
      const signal = () => {
        void stop().finally(resolve)
      }
      process.once("SIGTERM", signal)
      process.once("SIGINT", signal)
      void run(control.awaitShutdown).then(() => stop().finally(resolve))
      timer = setInterval(() => {
        try { boundAgentLog(path.join(AppPaths.directories.log, `agent-${projectKey(directory)}.log`)) }
        catch { /* Diagnostics must not interrupt Agent execution. */ }
        if (pendingTick || closing) return
        pendingTick = true
        void (async () => {
          await clients.expire()
          await clients.prune()
          if (
            !clients.idle
          ) {
            lastUsed = Date.now()
            return
          }

          if (
            Date.now() - lastUsed >= 15_000 &&
            clients.idle
          ) await stop().finally(resolve)
        })()
          .catch((error) => console.error("Agent lifecycle: " + String(error)))
          .finally(() => {
            pendingTick = false
          })
      }, 1000)
    })
    
    await finished
  } catch (error) {
    await stop()
    throw error
  }
}
