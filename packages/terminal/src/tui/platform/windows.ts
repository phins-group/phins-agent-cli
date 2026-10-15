import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "u64" },
    GetConsoleMode: { args: ["u64", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["u64", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["u64"], returns: "i32" },
    CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    WriteConsoleW: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    AttachConsole: { args: ["u32"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

/** Write to the restored console independently of the renderer's stdout handle. */
export function win32WriteConsole(text: string) {
  if (process.platform !== "win32") return false
  if (!load()) throw new Error("Unable to open Windows console output")
  const api = k32!.symbols
  // Own a fresh console handle; never close or replace the process stdio handles.
  const open = () => api.CreateFileW(Buffer.from("CONOUT$\0", "utf16le"),
    0x40000000, 3, null, 3, 0, 0n)
  let handle = open()
  const fail = (): never => {
    throw new Error(`Unable to write Windows console output (Win32: ${api.GetLastError()})`)
  }
  if (handle === 0xffffffffffffffffn) {
    const code = api.GetLastError()
    // Native terminal cleanup may detach the application from its console.
    if (![2, 6].includes(code) || !api.AttachConsole(0xffffffff)) return fail()
    handle = open()
    if (handle === 0xffffffffffffffffn) return fail()
  }
  try {
    const bytes = Buffer.from(text, "utf16le"), written = new Uint32Array(1)
    let offset = 0
    while (offset < bytes.length) {
      const remaining = bytes.subarray(offset)
      if (!api.WriteConsoleW(handle, remaining, remaining.length / 2, written, null)
        || written[0] === 0) return fail()
      offset += written[0] * 2
    }
  } finally {
    api.CloseHandle(handle)
  }
  return true
}
