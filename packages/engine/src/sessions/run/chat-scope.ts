/** Identity for the private, non-project Q&A runtime. Never discovers a repository. */
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, realpath, lstat } from "node:fs/promises"
import { Location } from "../../contracts/workspace/location"
import { AppPaths } from "../../runtime/paths"
import { AbsolutePath } from "../../shared/schema"
import { ProjectRegistry } from "../../workspace/projects/service"

const root = path.join(AppPaths.directories.state, "web-chat")
export const agentID = "web-chat"

export function project(directory: AbsolutePath): ProjectRegistry.Resolved {
  const relative = path.relative(root, directory)
  if (!/^[a-f0-9]{64}$/.test(relative))
    throw new Error("General chat requires its private runtime directory")
  return {
    id: ProjectRegistry.ID.make(`webchat_${relative}`),
    directory,
  }
}

export async function location(identity: {
  nodeId: string
  userId: string
  workspaceId: string
  sessionId: string
}) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        identity.nodeId,
        identity.userId,
        identity.workspaceId,
        identity.sessionId,
      ]),
    )
    .digest("hex")
  const directory = path.join(root, hash)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  // Refuse aliases/symlinks instead of loading an arbitrary project graph.
  for (const item of [root, directory]) {
    const info = await lstat(item)
    if (
      (await realpath(item)) !== item ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("General chat directory must be canonical and private")
  }
  // Constructor defaults keep cache identity identical to persisted/decoded
  // session refs, including an explicit undefined workspaceID.
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    scope: "chat-v1",
  })
}
