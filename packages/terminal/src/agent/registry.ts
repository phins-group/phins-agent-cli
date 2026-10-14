/** Private discovery of the existing CLI's project runtimes, not execution authority. */
import { createHash } from "node:crypto"
import { Database as SQLite } from "bun:sqlite"
import { Database } from "@phins/engine/storage/database"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { AppPaths } from "@phins/engine/runtime/paths"
import { InstallationVersion } from "@phins/engine/runtime/version"
import {
  connectLocalService,
  createLocalServiceFetch,
  type LocalServiceConnection,
} from "@phins/engine/transport/client/connection"

export interface AgentRegistration {
  protocol: "phins.agent-runtime.v1"
  id: string
  pid: number
  directory: string
  url: string
  password: string
  version: string
  mode: "personal" | "server"
}

export const registryDirectory = () => path.join(AppPaths.directories.state, "agents")
export const projectKey = (directory: string) =>
  createHash("sha256").update(directory).digest("hex")
const filename = (directory: string) =>
  path.join(registryDirectory(), `${projectKey(directory)}.json`)

export async function projectDirectory(value: string) {
  const directory = await realpath(path.resolve(value))
  if (/\p{Cc}/u.test(directory) || !(await lstat(directory)).isDirectory())
    throw new Error(
      "Project phải là thư mục có thật, không chứa ký tự điều khiển.",
    )
  return directory
}

export function processIsStopped(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

async function privateDirectory(create = false) {
  if (create) await mkdir(registryDirectory(), { recursive: true, mode: 0o700 })
  const info = await lstat(registryDirectory()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    },
  )
  if (!info) return false
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Kho runtime local không có quyền riêng tư hợp lệ.")
  return true
}

export function registrationConnection(
  value: AgentRegistration,
): LocalServiceConnection {
  return {
    url: value.url,
    generation: value.id,
    headers: {
      authorization: `Basic ${Buffer.from(`phins:${value.password}`).toString("base64")}`,
    },
  }
}

async function readPrivateRegistration(file: string) {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined
    throw new Error("Không đọc được đăng ký Agent riêng tư; không tự thay thế.")
  })
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.size > 16_384 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Đăng ký Agent local không có quyền riêng tư hợp lệ.")
    // Never include malformed JSON excerpts: this file contains a credential.
    try {
      return JSON.parse(await handle.readFile("utf8")) as AgentRegistration
    } catch {
      throw new Error("Nội dung đăng ký Agent local không hợp lệ.")
    }
  } finally {
    await handle.close()
  }
}

function validateRegistration(value: AgentRegistration, directory: string) {
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw new Error("Địa chỉ Agent local không hợp lệ.")
  }
  if (
    value.protocol !== "phins.agent-runtime.v1" ||
    value.directory !== directory ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.password !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.password) ||
    typeof value.version !== "string" ||
    !["personal", "server"].includes(value.mode) ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Đăng ký Agent local không khớp project; không tự thay thế.",
    )
  return value
}

export async function readRegistration(directory: string) {
  if (!(await privateDirectory())) return undefined
  const value = await readPrivateRegistration(filename(directory))
  return value ? validateRegistration(value, directory) : undefined
}

export async function discoverAgent(directory: string) {
  const value = await readRegistration(directory)
  if (!value || processIsStopped(value.pid)) return undefined
  if (value.version !== InstallationVersion)
    throw new Error(
      "Agent đang chạy khác phiên bản. Kết thúc tác vụ trước khi mở bản mới.",
    )
  try {
    await connectLocalService(registrationConnection(value))
  } catch {
    throw new Error(
      "Agent của project chưa phản hồi nhưng tiến trình vẫn còn. Không tự mở runtime thứ hai.",
    )
  }
  return value
}

export async function registeredAgents() {
  if (!(await privateDirectory())) return []
  const result: AgentRegistration[] = []
  for (const name of await readdir(registryDirectory())) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const file = path.join(registryDirectory(), name)
    const raw = await readPrivateRegistration(file)
    if (!raw) continue
    if (
      typeof raw.directory !== "string" ||
      projectKey(raw.directory) + ".json" !== name
    )
      throw new Error("Đăng ký Agent không khớp kho runtime.")
    // Recheck directory privacy without reopening the validated private file.
    if (await privateDirectory())
      result.push(validateRegistration(raw, raw.directory))
  }
  return result
}

/** Locate the existing session without booting Node or migrating any database. */
export async function sessionDirectory(id: string) {
  const database = Database.path()
  if (database !== ":memory:") {
    const info = await lstat(database).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause
    })
    if (info?.isFile() && !info.isSymbolicLink()) {
      using db = new SQLite(database, { readonly: true, create: false })
      const row = db
        .query("SELECT directory FROM session WHERE id=?")
        .get(id) as { directory: string } | null
      if (row?.directory) return projectDirectory(row.directory)
    }
  }
  for (const entry of await registeredAgents()) {
    if (processIsStopped(entry.pid)) continue
    const connection = registrationConnection(entry)
    const response = await createLocalServiceFetch(connection)(
      new Request(`${entry.url}/api/session/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(2000),
      }),
    )
    await response.body?.cancel()
    if (response.ok) return entry.directory
  }
  throw new Error("Không tìm thấy session. Mở đúng project trước khi thao tác.")
}

export async function writeRegistration(value: AgentRegistration) {
  await privateDirectory(true)
  const file = filename(value.directory)
  const temporary = `${file}.${value.id}.tmp`
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(temporary, file)
}

export async function removeRegistration(value: AgentRegistration) {
  const current = await readRegistration(value.directory)
  if (current?.id === value.id) await unlink(filename(value.directory))
}
