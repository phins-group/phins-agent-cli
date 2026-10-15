import { dlopen, ptr } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "u64" },
    GetConsoleMode: { args: ["u64", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["u64", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["u64"], returns: "i32" },
    DuplicateHandle: { args: ["u64", "u64", "u64", "buffer", "u32", "i32", "u32"], returns: "i32" },
    WriteConsoleW: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
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

/** Preserve the original output buffer before the renderer switches screens. */
export function openWindowsConsoleOutput() {
  if (process.platform !== "win32" || !process.stdout.isTTY) return undefined
  if (!load()) throw new Error("Unable to open Windows console output")
  const api = k32!.symbols
  const fail = (): never => {
    throw new Error(`Unable to write Windows console output (Win32: ${api.GetLastError()})`)
  }
  const duplicated = new BigUint64Array(1), processHandle = 0xffffffffffffffffn
  if (!api.DuplicateHandle(processHandle, api.GetStdHandle(-11), processHandle,
    duplicated, 0, 0, 2)) return fail()
  const handle = duplicated[0]
  return {
    write(text: string) {
      const bytes = Buffer.from(text, "utf16le"), written = new Uint32Array(1)
      let offset = 0
      while (offset < bytes.length) {
        const remaining = bytes.subarray(offset)
        if (!api.WriteConsoleW(handle, remaining, remaining.length / 2, written, null)) return fail()
        if (written[0] === 0) throw new Error("Windows console write made no progress")
        offset += written[0] * 2
      }
    },
    close() { api.CloseHandle(handle) },
  }
}
