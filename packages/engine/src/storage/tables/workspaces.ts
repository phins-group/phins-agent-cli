import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { EventBus } from "../../runtime/events/bus"
import { ProjectTable } from "./projects"
import { ProjectRegistry } from "../../workspace/projects/service"
import { SessionID } from "../../sessions/identifiers"
import { SessionTable } from "./sessions"
import { Workspace as WorkspaceIdentity } from "../../contracts/workspace/workspace"

export const WorkspaceTable = sqliteTable("workspace", {
  id: text().$type<WorkspaceIdentity.ID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: text({ mode: "json" }),
  project_id: text()
    .$type<ProjectRegistry.ID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: integer()
    .notNull()
    .$default(() => Date.now()),
})

/**
 * Durable hand-off intent for a Session V1 workspace transfer.
 *
 * The row is inserted by the same Event transaction that projects the
 * canonical `session.updated` event and rotates aggregate ownership. A remote
 * target can therefore be retried after a process crash without minting a
 * second transfer event.
 */
export const SessionWarpOutboxTable = sqliteTable(
  "session_warp_outbox",
  {
    delivery_id: text().primaryKey(),
    event_id: text().$type<EventBus.ID>().notNull(),
    role: text().$type<"source" | "target">().notNull(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id),
    workspace_id: text()
      .$type<WorkspaceIdentity.ID>()
      .notNull()
      .references(() => WorkspaceTable.id),
    transfer_seq: integer().notNull(),
    attempts: integer().notNull().default(0),
    next_attempt_at: integer().notNull(),
    lease_token: text(),
    lease_expires_at: integer(),
    last_error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_warp_outbox_event_role_idx").on(table.event_id, table.role),
    index("session_warp_outbox_due_idx").on(table.next_attempt_at, table.delivery_id),
    index("session_warp_outbox_session_seq_idx").on(table.session_id, table.transfer_seq),
  ],
)

/**
 * Cross-process fence for destructive workspace/session mutations.
 *
 * Rows persist after release so `lease_generation` remains monotonic across
 * crashes and takeovers. Resource keys are intentionally not foreign keys:
 * the workspace row may be deleted while its exact lease still fences the
 * deleting process.
 */
export const WorkspaceMutationLeaseTable = sqliteTable(
  "workspace_mutation_lease",
  {
    resource_key: text().primaryKey(),
    resource_kind: text().$type<"session" | "workspace">().notNull(),
    resource_id: text().notNull(),
    operation: text().$type<"session-warp" | "workspace-remove">(),
    lease_token: text(),
    lease_generation: integer().notNull().default(0),
    lease_expires_at: integer(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("workspace_mutation_lease_expiry_idx").on(table.lease_expires_at, table.resource_key),
    index("workspace_mutation_lease_resource_idx").on(table.resource_kind, table.resource_id),
  ],
)
