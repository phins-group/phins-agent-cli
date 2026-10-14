import { DateTime, Schema } from "effect"
import { SessionV1 } from "../contracts/session/compat"
import { AgentRegistry } from "../agents/registry"
import { Location } from "../workspace/location"
import { CatalogModel } from "../inference/catalog/model"
import { ProjectRegistry } from "../workspace/projects/service"
import { CatalogProvider } from "../inference/catalog/provider"
import { AbsolutePath, RelativePath } from "../shared/schema"
import { Workspace as WorkspaceIdentity } from "../contracts/workspace/workspace"
import { Session as SessionSchema } from "../contracts/session/info"
import { SessionTable } from "../storage/tables/sessions"
import { SessionMessageID } from "../contracts/session/message-id"

/** Lossless presentation of the shared session row for the original TUI. */
export function legacyInfo(row: typeof SessionTable.$inferSelect) {
  return Schema.decodeUnknownSync(Schema.toType(SessionV1.SessionInfo))({
    id: row.id, slug: row.slug, projectID: row.project_id,
    directory: row.directory, path: row.path ?? undefined,
    workspaceID: row.workspace_id ?? undefined,
    parentID: row.parent_id ?? undefined, title: row.title,
    version: row.version, agent: row.agent ?? undefined,
    model: row.model ?? undefined, metadata: row.metadata ?? undefined,
    share: row.share_url ? { url: row.share_url } : undefined,
    summary: row.summary_diffs ? { additions: row.summary_additions ?? 0,
      deletions: row.summary_deletions ?? 0, files: row.summary_files ?? 0,
      diffs: row.summary_diffs } : undefined,
    permission: row.permission ?? undefined, revert: row.revert ?? undefined,
    cost: row.cost, tokens: { input: row.tokens_input, output: row.tokens_output,
      reasoning: row.tokens_reasoning, cache: { read: row.tokens_cache_read, write: row.tokens_cache_write } },
    time: { created: row.time_created, updated: row.time_updated,
      compacting: row.time_compacting ?? undefined, archived: row.time_archived ?? undefined },
  })
}

export function fromRow(
  row: typeof SessionTable.$inferSelect,
): SessionSchema.Info {
  const chat =
    row.metadata?.runtimeScope === "chat-v1" || row.id.startsWith("ses_webchat_")
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: ProjectRegistry.ID.make(row.project_id),
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    agent: row.agent ? AgentRegistry.ID.make(row.agent) : undefined,
    permissionMode:
      row.metadata?.nodePermissionMode === "confirm-writes"
        ? "confirm-writes"
        : undefined,
    model: row.model
      ? {
          id: CatalogModel.ID.make(row.model.id),
          providerID: CatalogProvider.ID.make(row.model.providerID),
          variant: CatalogModel.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      // An own scope: undefined would split ordinary project graph cache keys.
      ...(chat ? { scope: "chat-v1" as const } : {}),
      workspaceID: row.workspace_id
        ? WorkspaceIdentity.ID.make(row.workspace_id)
        : undefined,
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    revert: row.revert
      ? {
          ...row.revert,
          messageID: SessionMessageID.ID.make(row.revert.messageID),
        }
      : undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived
        ? DateTime.makeUnsafe(row.time_archived)
        : undefined,
    },
  })
}
