/** Launch/observe the same CLI per project. Local work never needs Node Service. */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync } from "node:fs"
import path from "node:path"
import { AppPaths } from "@phins/engine/runtime/paths"
import { Flock } from "@phins/engine/shared/flock"
import { openAgentLog } from "./process-log"
import {
  createLocalServiceFetch,
  type LocalServiceConnection,
} from "@phins/engine/transport/client/connection"
import {
  discoverAgent,
  projectDirectory,
  projectKey,
  registrationConnection,
  type AgentRegistration,
} from "./registry"

export type AgentClientKind = "tui" | "desktop" | "headless" | "remote"
export type AgentMode = "personal" | "server"

export async function ensureAgent(project: string, mode?: AgentMode) {
  const directory = await projectDirectory(project)
  const lock = await Flock.acquire(`agent-start-${projectKey(directory)}`, {
    dir: path.join(AppPaths.directories.state, "locks"),
    timeoutMs: 15_000,
    recoverDeadOwner: true,
  })
  try {
    const existing = await discoverAgent(directory)
    if (existing) {
      if (mode && existing.mode !== mode)
        throw new Error(
          "Agent của project đang chạy ở chế độ khác. Kết thúc tác vụ trước khi đổi chế độ; không tự chuyển runtime.",
        )
      return existing
    }
    const compiled =
      path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
    const entry = compiled ? [] : [process.argv[1]!]
    if (entry.some((value) => !value))
      throw new Error("Không tìm được điểm vào Agent CLI.")
    const nonce = randomUUID()
    const log = openAgentLog(
      path.join(AppPaths.directories.log, `agent-${projectKey(directory)}.log`),
    )
    const child = (() => {
      try {
        return spawn(
          process.execPath,
          [
            ...entry,
            "agent-host",
            "--directory",
            directory,
            "--nonce",
            nonce,
            "--mode",
            mode ?? "personal",
          ],
          {
            cwd: directory,
            detached: true,
            env: process.env,
            stdio: ["ignore", "pipe", log],
          },
        )
      } finally {
        closeSync(log)
      }
    })()
    child.unref()
    // stdout is a one-time private handshake. No secret goes into user logs.
    try {
      await new Promise<void>((resolve, reject) => {
        let buffered = "",
          size = 0
        const timer = setTimeout(
          () =>
            finish(
              new Error("Agent khởi động quá hạn; không tự gửi lại tác vụ."),
            ),
          15_000,
        )
        const finish = (error?: Error) => {
          clearTimeout(timer)
          child.stdout?.removeAllListeners()
          child.removeListener("error", failed)
          child.removeListener("exit", exited)
          child.stdout?.destroy()
          error ? reject(error) : resolve()
        }
        const failed = () =>
          finish(new Error("Không khởi động được Agent CLI."))
        const exited = () =>
          finish(
            new Error(
              "Agent đã thoát trước khi sẵn sàng. Kiểm tra log của project.",
            ),
          )
        child.once("error", failed)
        child.once("exit", exited)
        child.stdout!.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > 16_384)
            return finish(new Error("Handshake Agent vượt giới hạn."))
          buffered += chunk.toString("utf8")
          let end: number
          while ((end = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, end)
            buffered = buffered.slice(end + 1)
            try {
              const value = JSON.parse(line)
              if (
                value.kind === "phins-agent-ready" &&
                value.nonce === nonce &&
                value.directory === directory
              )
                return finish()
            } catch {
              /* Other startup messages contain no handshake authority. */
            }
          }
        })
      })
    } catch (error) {
      // Stop only the unready child created by this call, never an existing Agent.
      if (child.exitCode === null) child.kill("SIGTERM")
      throw error
    }
    const ready = await discoverAgent(directory)
    if (!ready) throw new Error("Agent chưa công bố kết nối local có xác thực.")
    return ready
  } finally {
    await lock.release()
  }
}

export async function agentRequest(
  connection: LocalServiceConnection,
  action: string,
  payload: object = {},
  options: { signal?: AbortSignal } = {},
) {
  const request = createLocalServiceFetch(connection)
  const headers = new Headers(connection.headers)
  headers.set("content-type", "application/json")
  const response = await request(
    new Request(new URL(`/api/agent/${action}`, connection.url), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal ?? AbortSignal.timeout(10_000),
    }),
  )
  const value = (await response.json()) as { message?: string } & Record<
    string,
    unknown
  >
  if (!response.ok)
    throw new Error(value.message ?? "Không hoàn tất thao tác Agent local.")
  return value
}

export async function openAgentClient(
  registration: AgentRegistration,
  kind: AgentClientKind,
  options: { heartbeat?: boolean } = {},
) {
  const base = registrationConnection(registration)
  const value = await agentRequest(base, "client/open", { kind })
  if (
    typeof value.clientID !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.clientID)
  )
    throw new Error("Agent trả kết nối client không hợp lệ.")
  const headers = new Headers(base.headers)
  headers.set("x-phins-agent-client", value.clientID)
  const connection = { ...base, headers }
  let closed = false,
    background = false,
    failure: unknown
  const heartbeat =
    options.heartbeat === false
      ? undefined
      : setInterval(() => {
          if (!closed)
            void agentRequest(connection, "client/heartbeat").then(
              () => {
                failure = undefined
              },
              (error) => {
                failure = error
              },
            )
        }, 3000)
  heartbeat?.unref()
  return {
    connection,
    registration,
    directory: registration.directory,
    clientID: value.clientID,
    async background() {
      if (closed) throw new Error("Giao diện đã đóng.")
      await agentRequest(connection, "client/background", { confirmed: true })
      background = true
    },
    async close() {
      if (closed) return
      if (heartbeat) clearInterval(heartbeat)
      // A failed release is not a claim that the run stopped. The runtime's
      // client lease remains the crash fallback and cannot authorize background.
      await agentRequest(connection, "client/close", { background })
      closed = true
    },
    get failure() {
      return failure
    },
  }
}

export type AgentClient = Awaited<ReturnType<typeof openAgentClient>>
