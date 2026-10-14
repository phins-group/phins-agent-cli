import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import {
  projectKey,
  readRegistration,
  registeredAgents,
  type AgentRegistration,
} from "../../src/agent/registry"

afterEach(() => mock.restore())

const registration = (directory: string): AgentRegistration => ({
  protocol: "phins.agent-runtime.v1",
  id: "12345678-1234-1234-1234-123456789abc",
  pid: 123,
  directory,
  url: "http://127.0.0.1:51234",
  password: "a".repeat(64),
  version: "test",
  mode: "personal",
})

function fixture() {
  const directoryInfo = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o700,
    uid: process.getuid?.() ?? 0,
  }
  const fileInfo = {
    isFile: () => true,
    size: 1024,
    mode: 0o600,
    uid: process.getuid?.() ?? 0,
  }
  const files = new Map<string, string>()
  const handles: {
    readFile: ReturnType<typeof mock>
    close: ReturnType<typeof mock>
  }[] = []
  const lstat = spyOn(fs, "lstat").mockResolvedValue(
    directoryInfo as Awaited<ReturnType<typeof fs.lstat>>,
  )
  const readdir = spyOn(fs, "readdir").mockImplementation(
    async () => [...files.keys()] as never,
  )
  const open = spyOn(fs, "open").mockImplementation(async (file) => {
    const contents = files.get(path.basename(String(file)))
    if (contents === undefined)
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    const handle = {
      stat: async () => fileInfo,
      readFile: mock(async () => contents),
      close: mock(async () => {}),
    }
    handles.push(handle)
    return handle as unknown as Awaited<ReturnType<typeof fs.open>>
  })
  const add = (value: AgentRegistration) =>
    files.set(`${projectKey(value.directory)}.json`, JSON.stringify(value))
  return { add, files, handles, directoryInfo, fileInfo, lstat, readdir, open }
}

test("registry discovery validates each private file once and preserves order", async () => {
  const io = fixture()
  const second = registration("/project-second"),
    first = registration("/project-first")
  io.add(second)
  io.files.set("unrelated.json", "not JSON")
  io.add(first)
  expect(await registeredAgents()).toEqual([second, first])
  expect(io.lstat).toHaveBeenCalledTimes(3)
  expect(io.readdir).toHaveBeenCalledTimes(1)
  expect(io.open).toHaveBeenCalledTimes(2)
  for (const call of io.open.mock.calls)
    expect(call[1]).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  for (const handle of io.handles) {
    expect(handle.readFile).toHaveBeenCalledTimes(1)
    expect(handle.readFile).toHaveBeenCalledWith("utf8")
    expect(handle.close).toHaveBeenCalledTimes(1)
  }
})

test("direct reads accept a private server registration at the size limit", async () => {
  const io = fixture()
  const value = { ...registration("/project"), mode: "server" as const }
  io.add(value)
  io.fileInfo.size = 16_384
  expect(await readRegistration(value.directory)).toEqual(value)
  expect(io.open).toHaveBeenCalledTimes(1)
  expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
})

test("discovery rechecks directory privacy after reading an entry", async () => {
  const io = fixture()
  io.add(registration("/project"))
  io.lstat.mockResolvedValueOnce(
    io.directoryInfo as Awaited<ReturnType<typeof fs.lstat>>,
  ).mockResolvedValue({
    ...io.directoryInfo,
    mode: 0o755,
  } as Awaited<ReturnType<typeof fs.lstat>>)
  await expect(registeredAgents()).rejects.toThrow("quyền riêng tư")
  expect(io.open).toHaveBeenCalledTimes(1)
  expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
})

test("discovery skips an entry if its registry was removed during the read", async () => {
  const io = fixture()
  io.add(registration("/project"))
  io.lstat.mockResolvedValueOnce(
    io.directoryInfo as Awaited<ReturnType<typeof fs.lstat>>,
  ).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
  expect(await registeredAgents()).toEqual([])
  expect(io.open).toHaveBeenCalledTimes(1)
  expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
})

test("missing registry files are ignored without replacing them", async () => {
  const io = fixture()
  expect(await readRegistration("/missing")).toBeUndefined()
  expect(io.open).toHaveBeenCalledTimes(1)
  io.lstat.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  )
  expect(await readRegistration("/missing")).toBeUndefined()
  expect(await registeredAgents()).toEqual([])
  expect(io.open).toHaveBeenCalledTimes(1)
  expect(io.readdir).not.toHaveBeenCalled()
})

test("discovery rejects filenames that do not match the registered project", async () => {
  const io = fixture()
  const value = registration("/project")
  io.files.set(`${projectKey("/other-project")}.json`, JSON.stringify(value))
  await expect(registeredAgents()).rejects.toThrow("không khớp kho runtime")
  expect(io.open).toHaveBeenCalledTimes(1)
  expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
})

test.each([
  { protocol: "wrong" },
  { id: "not-a-generation" },
  { pid: 0 },
  { pid: 1.5 },
  { password: "short" },
  { version: 1 },
  { mode: "other" },
  { url: "https://127.0.0.1:51234" },
  { url: "http://localhost:51234" },
  { url: "http://127.0.0.1" },
  { url: "http://127.0.0.1:51234/api" },
  { url: "http://user:secret@127.0.0.1:51234" },
  { url: "http://127.0.0.1:51234/?secret=value" },
  { url: "http://127.0.0.1:51234/#secret" },
])("discovery and direct reads enforce the same validation: %j", async (patch) => {
  const io = fixture()
  io.add({ ...registration("/project"), ...patch } as AgentRegistration)
  for (const read of [registeredAgents, () => readRegistration("/project")])
    await expect(read()).rejects.toThrow(
      "Đăng ký Agent local không khớp project; không tự thay thế.",
    )
  for (const handle of io.handles)
    expect(handle.close).toHaveBeenCalledTimes(1)
})

test.each([
  "not JSON containing a credential",
  JSON.stringify({ url: "invalid" }),
])(
  "invalid registration contents produce redacted errors",
  async (contents) => {
    const io = fixture()
    io.files.set(`${projectKey("/project")}.json`, contents)
    await expect(readRegistration("/project")).rejects.toThrow(
      contents.startsWith("{")
        ? "Địa chỉ Agent local không hợp lệ."
        : "Nội dung đăng ký Agent local không hợp lệ.",
    )
    expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
  },
)

test.each([
  { mode: 0o644 },
  { size: 16_385 },
  { isFile: () => false },
  ...(process.getuid ? [{ uid: process.getuid() + 1 }] : []),
])("insecure registration files are closed without reading: %j", async (patch) => {
  const io = fixture()
  io.add(registration("/project"))
  Object.assign(io.fileInfo, patch)
  await expect(registeredAgents()).rejects.toThrow("quyền riêng tư")
  expect(io.handles[0]!.readFile).not.toHaveBeenCalled()
  expect(io.handles[0]!.close).toHaveBeenCalledTimes(1)
})

test.each([
  { mode: 0o755 },
  { isDirectory: () => false },
  { isSymbolicLink: () => true },
  ...(process.getuid ? [{ uid: process.getuid() + 1 }] : []),
])("insecure registry directories are rejected before opening: %j", async (patch) => {
  const io = fixture()
  Object.assign(io.directoryInfo, patch)
  await expect(registeredAgents()).rejects.toThrow("quyền riêng tư")
  expect(io.readdir).not.toHaveBeenCalled()
  expect(io.open).not.toHaveBeenCalled()
})

test("open failures do not expose paths or credentials", async () => {
  const io = fixture()
  io.open.mockRejectedValue(
    Object.assign(new Error("private path and credential"), { code: "ELOOP" }),
  )
  await expect(readRegistration("/project")).rejects.toThrow(
    "Không đọc được đăng ký Agent riêng tư; không tự thay thế.",
  )
})
