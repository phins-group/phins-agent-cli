import z from "zod"

export const RESOURCE_CAPABILITY = "agent.resources.v1"
/** Folder/MCP content access, not merely source metadata in the manifest. */
export const SOURCE_CAPABILITY = "agent.resources.sources.v1"
const text = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => !value.includes("\0"))
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const source = z
  .object({
    type: z.enum(["folder", "mcp"]),
    target: text(512).min(1),
  })
  .refine((value) =>
    value.type === "mcp"
      ? /^[a-zA-Z0-9_.-]{1,128}$/.test(value.target)
      : !value.target.startsWith("/") &&
        !value.target.includes("\\") &&
        !value.target.split("/").includes("..") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(value.target),
  )

export const Project = z.object({
  workspaceId: z.uuid(),
  deviceId: text(128).min(1),
  directory: text(2000).min(1),
})
export type Project = z.infer<typeof Project>

export const Resource = z
  .object({
    id: z.uuid(),
    revision,
    kind: z.enum(["skill", "knowledge", "source"]),
    title: text(160).min(1),
    description: text(500),
    provenance: text(1000),
    content: text(16000),
    source: source.nullable(),
    enabled: z.literal(true),
    archived: z.literal(false),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .refine((value) =>
    value.kind === "source"
      ? value.source !== null && value.content === ""
      : value.source === null && !!value.content.trim(),
  )
  .refine((value) => value.kind !== "knowledge" || !!value.provenance.trim())
export type Resource = z.infer<typeof Resource>

export const Manifest = z
  .object({
    project: Project,
    revision,
    items: z.array(Resource).max(50),
  })
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length,
  )
export type Manifest = z.infer<typeof Manifest>
export type ResourceProject = Pick<Project, "workspaceId" | "directory">

export const sameProject = (left: Project, right: Project) =>
  left.workspaceId === right.workspaceId &&
  left.deviceId === right.deviceId &&
  left.directory === right.directory
