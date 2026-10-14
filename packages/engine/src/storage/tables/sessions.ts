import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../path"
import { ProjectTable } from "./projects"
import type { SessionMessage } from "../../sessions/messages/service"
import type { Prompt } from "../../contracts/session/prompt"
import type { SessionInput } from "../../sessions/input/inbox"
import type { Snapshot } from "../../workspace/repository/snapshot"
import type { PermissionV1 } from "../../contracts/security/permission-compat"
import { ProjectRegistry } from "../../workspace/projects/service"
import type { Session as SessionSchema } from "../../contracts/session/info"
import type { MessageID, PartID } from "../../contracts/session/compat"
import { Workspace as WorkspaceIdentity } from "../../contracts/workspace/workspace"
import { Timestamps } from "../schema.sql"
import type { SystemContext } from "../../agents/context/system"
import type { Revert } from "../../contracts/session/revert"
import type { VerificationReceipt } from "../../contracts/execution/verification-receipt"
import type { ID as EventID } from "../../runtime/events/bus"
import type { SessionRunState } from "../../contracts/session/run-state"
import type { SessionInputOrigin } from "../../contracts/session/input-origin"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectRegistry.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceIdentity.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

/** Non-refundable admission estimates for one root session and its descendants. */
export const SessionTreeBudgetTable = sqliteTable("session_tree_budget", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  token_limit: integer().notNull(),
  cost_limit_micros: integer().notNull(),
  reserved_tokens: integer().notNull().default(0),
  reserved_cost_micros: integer().notNull().default(0),
})

/**
 * Minimal accounting ledger for usage already folded into `session` totals.
 * This is deliberately not a transcript projection: it stores only the
 * identity and numeric contribution required to apply updates, removals and
 * reverts without retaining message or part payloads.
 */
export const SessionUsageContributionTable = sqliteTable(
  "session_usage_contribution",
  {
    contribution_key: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    compatibility_message_id: text().$type<MessageID>(),
    compatibility_message_time_created: integer(),
    canonical_message_id: text().$type<SessionMessage.ID>(),
    part_id: text().$type<PartID>(),
    event_seq: integer().notNull(),
    cost: real().notNull(),
    tokens_input: integer().notNull(),
    tokens_output: integer().notNull(),
    tokens_reasoning: integer().notNull(),
    tokens_cache_read: integer().notNull(),
    tokens_cache_write: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_usage_contribution_part_idx").on(table.part_id),
    index("session_usage_contribution_session_seq_idx").on(table.session_id, table.event_seq),
    index("session_usage_contribution_session_compat_message_idx").on(table.session_id, table.compatibility_message_id),
    index("session_usage_contribution_session_canonical_message_idx").on(table.session_id, table.canonical_message_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

/** Origin receipts survive transcript reset/revert; only session deletion clears them. */
export const SessionInputOriginTable = sqliteTable(
  "session_input_origin",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    command_id: text().notNull(),
    admitted_seq: integer().notNull(),
    origin: text({ mode: "json" }).notNull().$type<(typeof SessionInputOrigin.Origin)["Encoded"]>(),
  },
  (table) => [
    index("session_input_origin_session_idx").on(table.session_id),
    uniqueIndex("session_input_origin_node_command_idx").on(table.node_id, table.command_id),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})

/**
 * Durable projection of the latest execution run for each session. `run_id`
 * fences retry and settlement updates so a superseded process cannot mutate
 * the current run.
 */
export const SessionRunStateTable = sqliteTable(
  "session_run_state",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    run_id: text().$type<SessionRunState.ID>().notNull(),
    input_id: text().$type<SessionMessage.ID>(),
    status: text().$type<SessionRunState.Status>().notNull(),
    attempt: integer(),
    next_retry_at: integer(),
    error: text({ mode: "json" }).$type<SessionRunState.RetryError | SessionMessage.UnknownError>(),
    time_started: integer().notNull(),
    time_settled: integer(),
  },
  (table) => [
    uniqueIndex("session_run_state_run_id_idx").on(table.run_id),
    index("session_run_state_retry_due_idx").on(table.status, table.next_retry_at, table.session_id),
  ],
)

export const VerificationLocationStateTable = sqliteTable("verification_location_state", {
  location_key: text().$type<VerificationReceipt.LocationKey>().primaryKey(),
  mutation_epoch: integer().notNull(),
  snapshot: text(),
  ...Timestamps,
})

export const VerificationRequestOutboxTable = sqliteTable(
  "verification_request_outbox",
  {
    receipt_id: text().$type<VerificationReceipt.ID>().primaryKey(),
    event_id: text().$type<EventID>().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>(),
    location_key: text()
      .$type<VerificationReceipt.LocationKey>()
      .notNull()
      .references(() => VerificationLocationStateTable.location_key),
    mode: text().$type<VerificationReceipt.Mode>().notNull(),
    mutation_epoch: integer().notNull(),
    subject_snapshot: text(),
    verifier: text({ mode: "json" }).$type<VerificationReceipt.Verifier>(),
    time_requested: integer().notNull(),
  },
  (table) => [
    uniqueIndex("verification_request_outbox_event_idx").on(table.event_id),
    index("verification_request_outbox_session_time_idx").on(table.session_id, table.time_requested),
    index("verification_request_outbox_time_session_idx").on(table.time_requested, table.session_id),
  ],
)

export const VerificationReceiptTable = sqliteTable(
  "verification_receipt",
  {
    id: text().$type<VerificationReceipt.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>(),
    location_key: text()
      .$type<VerificationReceipt.LocationKey>()
      .notNull()
      .references(() => VerificationLocationStateTable.location_key),
    mode: text().$type<VerificationReceipt.Mode>().notNull(),
    mutation_epoch: integer().notNull(),
    subject_snapshot: text(),
    verifier: text({ mode: "json" }).$type<VerificationReceipt.Verifier>(),
    verdict: text().$type<VerificationReceipt.Verdict>(),
    attempt_generation: integer().notNull().default(0),
    attempt_timeout_ms: integer(),
    attempt_token: text(),
    attempt_lease_expires: integer(),
    checks: text({ mode: "json" }).$type<VerificationReceipt.Check[]>().notNull(),
    reason: text(),
    attestation: text({ mode: "json" }).$type<VerificationReceipt.ExecutionAttestation>(),
    time_requested: integer().notNull(),
    time_started: integer(),
    time_completed: integer(),
  },
  (table) => [
    index("verification_receipt_session_time_idx").on(table.session_id, table.time_requested),
    index("verification_receipt_location_epoch_idx").on(table.location_key, table.mutation_epoch),
    index("verification_receipt_pending_time_idx").on(table.verdict, table.time_requested),
  ],
)

export type WorkContextCheckpoint = {
  readonly evidenceReplayPolicy?: "historical-v1"
  readonly version: number
  readonly stage?: "discovery" | "analysis" | "synthesis"
  readonly scope: readonly string[]
  readonly queue: readonly Record<string, unknown>[]
  readonly evidence: readonly Record<string, unknown>[]
  readonly openQuestions: readonly string[]
  readonly nextAction: string
  readonly currentRequest: string
  readonly sourceMessageCount: number
  readonly sourceHash: string
  readonly telemetry?: { readonly requestCount: number }
}

export const WorkContextEpochTable = sqliteTable(
  "work_context_epoch",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    epoch: integer().notNull(),
    phase: text().notNull(),
    status: text().$type<"open" | "closed">().notNull(),
    baseline_message_count: integer().notNull(),
    baseline_prefix_hash: text().notNull(),
    checkpoint: text({ mode: "json" }).notNull().$type<WorkContextCheckpoint>(),
    prefix_messages: text({ mode: "json" }).notNull().$type<unknown[]>(),
    selected_provider: text().notNull(),
    selected_model: text().notNull(),
    route_decision_id: text(),
    prompt_prefix_hash: text(),
    input_target_tokens: integer().notNull(),
    rollover_reserve_tokens: integer().notNull(),
    rollover_reason: text().notNull(),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    cached_input_tokens: integer().notNull().default(0),
    cost: real().notNull().default(0),
    ...Timestamps,
    time_closed: integer(),
  },
  (table) => [
    uniqueIndex("work_context_epoch_session_epoch_idx").on(table.session_id, table.epoch),
    index("work_context_epoch_session_status_idx").on(table.session_id, table.status, table.epoch),
  ],
)
