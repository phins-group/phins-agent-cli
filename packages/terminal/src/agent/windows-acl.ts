/** Local Win32 ACL operations. No shell, script policy or translated CLI output. */
import { dlopen, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi"
import path from "node:path"

const wide = (value: string) => Buffer.from(value + "\0", "utf16le")
const pointer = (buffer: Uint8Array) => read.ptr(ptr(buffer)) as Pointer
const failed = (operation: string, code?: number): never => {
  throw new Error(`Unable to verify private Windows runtime permissions (${operation}${code === undefined ? "" : `: ${code}`})`)
}

export function openWindowsAcl() {
  const root = process.env.SystemRoot
  if (process.platform !== "win32" || process.arch !== "x64" || !root
    || !path.isAbsolute(root) || root.startsWith("\\\\") || root.includes("\0"))
    return failed("unsupported local Windows runtime")
  const kernel = dlopen(path.join(root, "System32/kernel32.dll"), {
    GetLastError: { args: [], returns: "u32" },
    // HANDLE values are integers, not Bun pointer encodings.
    CloseHandle: { args: ["u64"], returns: "i32" },
    LocalFree: { args: ["ptr"], returns: "ptr" },
  })
  const security = dlopen(path.join(root, "System32/advapi32.dll"), {
    OpenProcessToken: { args: ["u64", "u32", "buffer"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    GetNamedSecurityInfoW: {
      args: ["buffer", "u32", "u32", "buffer", "ptr", "buffer", "ptr", "buffer"], returns: "u32",
    },
    SetNamedSecurityInfoW: {
      args: ["buffer", "u32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32",
    },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["buffer", "u32", "buffer", "ptr"], returns: "i32",
    },
    GetSecurityDescriptorDacl: { args: ["ptr", "buffer", "buffer", "buffer"], returns: "i32" },
    GetAce: { args: ["ptr", "u32", "buffer"], returns: "i32" },
    IsValidSid: { args: ["ptr"], returns: "i32" },
    GetLengthSid: { args: ["ptr"], returns: "u32" },
  })
  const api = security.symbols
  const bool = (ok: number, name: string) => {
    if (!ok) failed(name, kernel.symbols.GetLastError())
  }
  const status = (code: number, name: string) => {
    if (code !== 0) failed(name, code)
  }
  const sid = (value: Pointer, available = 68) => {
    if (!value || available < 8) return failed("invalid SID")
    const expected = 8 + read.u8(value, 1) * 4
    if (expected > Math.min(68, available)) return failed("invalid SID layout")
    bool(api.IsValidSid(value), "IsValidSid")
    const size = api.GetLengthSid(value)
    if (size < 8 || size > Math.min(68, available)) return failed("invalid SID size")
    const bytes = new DataView(toArrayBuffer(value, 0, size))
    const count = bytes.getUint8(1)
    if (bytes.getUint8(0) !== 1 || size !== 8 + count * 4) return failed("invalid SID layout")
    let authority = 0
    for (let i = 2; i < 8; i++) authority = authority * 256 + bytes.getUint8(i)
    const parts = [`S-1-${authority}`]
    for (let i = 0; i < count; i++) parts.push(String(bytes.getUint32(8 + i * 4, true)))
    return parts.join("-")
  }
  const processUser = () => {
    const token = new BigUint64Array(1)
    // GetCurrentProcess's pseudo-handle is (HANDLE)-1.
    bool(api.OpenProcessToken(0xffffffffffffffffn, 8, token), "OpenProcessToken")
    try {
      const size = new Uint32Array(1)
      const probe = api.GetTokenInformation(token[0], 1, null, 0, ptr(size))
      if (probe || kernel.symbols.GetLastError() !== 122 || size[0] < 16 || size[0] > 4096)
        return failed("GetTokenInformation size")
      const buffer = new Uint8Array(size[0])
      bool(api.GetTokenInformation(token[0], 1, ptr(buffer), buffer.length, ptr(size)), "GetTokenInformation")
      return sid(pointer(buffer))
    } finally {
      kernel.symbols.CloseHandle(token[0])
    }
  }
  const user = processUser()

  return {
    inspect(file: string) {
      const owner = new Uint8Array(8), dacl = new Uint8Array(8), descriptor = new Uint8Array(8)
      status(api.GetNamedSecurityInfoW(wide(file), 1, 5, owner, null,
        dacl, null, descriptor), "GetNamedSecurityInfoW")
      try {
        const rules: { sid: string; type: number; rights: number; inheritOnly: boolean }[] = []
        const acl = pointer(dacl)
        if (acl) {
          const size = read.u16(acl, 2), count = read.u16(acl, 4)
          if (size < 8 || count > (size - 8) / 16) return failed("invalid ACL size")
          for (let i = 0; i < count; i++) {
            const out = new Uint8Array(8)
            bool(api.GetAce(acl, i, out), "GetAce")
            const ace = pointer(out)
            const offset = ace - acl
            if (offset < 8 || offset + 8 > size) return failed("invalid ACE pointer")
            const type = read.u8(ace), flags = read.u8(ace, 1), length = read.u16(ace, 2)
            if (type > 1 || length < 16 || offset + length > size)
              return failed("unsupported ACE")
            rules.push({ sid: sid((ace + 8) as Pointer, length - 8), type,
              rights: read.u32(ace, 4), inheritOnly: (flags & 8) !== 0 })
          }
        }
        // A null or empty DACL cannot prove private access.
        return { user, owner: sid(pointer(owner)), rules }
      } finally {
        kernel.symbols.LocalFree(pointer(descriptor))
      }
    },
    protect(file: string, account: string) {
      if (account !== user) return failed("foreign process identity")
      const sddl = wide(`D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`)
      const descriptor = new Uint8Array(8)
      bool(api.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1,
        descriptor, null), "ConvertStringSecurityDescriptor")
      try {
        const present = new Int32Array(1), inherited = new Int32Array(1), dacl = new Uint8Array(8)
        bool(api.GetSecurityDescriptorDacl(pointer(descriptor), present,
          dacl, inherited), "GetSecurityDescriptorDacl")
        if (!present[0] || !pointer(dacl)) return failed("missing private DACL")
        // Replace the DACL and disable parent inheritance. Preserve the trusted owner.
        status(api.SetNamedSecurityInfoW(wide(file), 1, 0x80000004,
          null, null, pointer(dacl), null), "SetNamedSecurityInfoW")
      } finally {
        kernel.symbols.LocalFree(pointer(descriptor))
      }
    },
  }
}
