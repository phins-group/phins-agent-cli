/** Private native stdout/stderr sink, independent of the daemon event loop. */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"

const maxBytes = 5 * 1024 * 1024

function openPrivate(file: string) {
  const fd = openSync(
    file,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  )
  try {
    const info = fstatSync(fd)
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Daemon log must be a regular file without hard links")
    fchmodSync(fd, 0o600)
    return { fd, size: info.size }
  } catch (cause) {
    closeSync(fd)
    throw cause
  }
}

function rotate(file: string, fd: number, size: number) {
  // Keep only the latest bounded tail. Atomic private publication never follows
  // an existing .previous symlink or changes another file through a hard link.
  const tail = Buffer.alloc(Math.min(size, maxBytes))
  let offset = 0
  const reader = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const input = fstatSync(reader),
      output = fstatSync(fd)
    if (
      input.ino !== output.ino ||
      input.dev !== output.dev ||
      input.nlink !== 1
    )
      throw new Error("Log changed during rotation")
    while (offset < tail.length) {
      const count = readSync(
        reader,
        tail,
        offset,
        tail.length - offset,
        size - tail.length + offset,
      )
      if (!count) break
      offset += count
    }
  } finally {
    closeSync(reader)
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  const output = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(output, tail.subarray(0, offset))
    closeSync(output)
    renameSync(temporary, file + ".previous")
    ftruncateSync(fd, 0)
  } catch (error) {
    try {
      closeSync(output)
    } catch {
      /* Already closed before rename. */
    }
    try {
      unlinkSync(temporary)
    } catch {
      /* Never remove any other path. */
    }
    throw error
  }
}

/** Startup rotation plus periodic bounding without replacing the inherited FD. */
export function openAgentLog(file: string, rotate = true) {
  const current = openPrivate(file)
  if (!rotate || current.size < maxBytes) return current.fd
  try {
    boundAgentLog(file, current.fd)
    return current.fd
  } catch (error) {
    closeSync(current.fd)
    throw error
  }
}

export function boundAgentLog(file: string, fd = 2) {
  const info = fstatSync(fd)
  // Manual terminal/pipe/redirection output is not owned by this log policy.
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size < maxBytes ||
    (process.getuid && info.uid !== process.getuid())
  )
    return false
  const linked = lstatSync(file)
  if (!linked.isFile() || linked.ino !== info.ino || linked.dev !== info.dev)
    return false
  rotate(file, fd, info.size)
  return true
}
