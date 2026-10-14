import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_warp_outbox\` (
          \`delivery_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`transfer_seq\` integer NOT NULL,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_attempt_at\` integer NOT NULL,
          \`lease_token\` text,
          \`lease_expires_at\` integer,
          \`last_error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_warp_outbox_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`),
          CONSTRAINT \`fk_session_warp_outbox_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workspace_mutation_lease\` (
          \`resource_key\` text PRIMARY KEY,
          \`resource_kind\` text NOT NULL,
          \`resource_id\` text NOT NULL,
          \`operation\` text,
          \`lease_token\` text,
          \`lease_generation\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_command_receipt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`signature\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_command_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text,
          \`owner_generation\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`node_command_receipt\` (
          \`id\` text PRIMARY KEY,
          \`binding_hash\` text NOT NULL,
          \`status\` text NOT NULL,
          \`result\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input_origin\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`command_id\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`origin\` text NOT NULL,
          CONSTRAINT \`fk_session_input_origin_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_run_state\` (
          \`session_id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`input_id\` text,
          \`status\` text NOT NULL,
          \`attempt\` integer,
          \`next_retry_at\` integer,
          \`error\` text,
          \`time_started\` integer NOT NULL,
          \`time_settled\` integer,
          CONSTRAINT \`fk_session_run_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tree_budget\` (
          \`session_id\` text PRIMARY KEY,
          \`token_limit\` integer NOT NULL,
          \`cost_limit_micros\` integer NOT NULL,
          \`reserved_tokens\` integer DEFAULT 0 NOT NULL,
          \`reserved_cost_micros\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_tree_budget_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage_contribution\` (
          \`contribution_key\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`compatibility_message_id\` text,
          \`compatibility_message_time_created\` integer,
          \`canonical_message_id\` text,
          \`part_id\` text,
          \`event_seq\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`tokens_cache_write\` integer NOT NULL,
          CONSTRAINT \`fk_session_usage_contribution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`verification_location_state\` (
          \`location_key\` text PRIMARY KEY,
          \`mutation_epoch\` integer NOT NULL,
          \`snapshot\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`verification_receipt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text,
          \`location_key\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`mutation_epoch\` integer NOT NULL,
          \`subject_snapshot\` text,
          \`verifier\` text,
          \`verdict\` text,
          \`attempt_generation\` integer DEFAULT 0 NOT NULL,
          \`attempt_timeout_ms\` integer,
          \`attempt_token\` text,
          \`attempt_lease_expires\` integer,
          \`checks\` text NOT NULL,
          \`reason\` text,
          \`attestation\` text,
          \`time_requested\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_verification_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_verification_receipt_location_key_verification_location_state_location_key_fk\` FOREIGN KEY (\`location_key\`) REFERENCES \`verification_location_state\`(\`location_key\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`verification_request_outbox\` (
          \`receipt_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text,
          \`location_key\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`mutation_epoch\` integer NOT NULL,
          \`subject_snapshot\` text,
          \`verifier\` text,
          \`time_requested\` integer NOT NULL,
          CONSTRAINT \`fk_verification_request_outbox_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_verification_request_outbox_location_key_verification_location_state_location_key_fk\` FOREIGN KEY (\`location_key\`) REFERENCES \`verification_location_state\`(\`location_key\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_context_epoch\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`epoch\` integer NOT NULL,
          \`phase\` text NOT NULL,
          \`status\` text NOT NULL,
          \`baseline_message_count\` integer NOT NULL,
          \`baseline_prefix_hash\` text NOT NULL,
          \`checkpoint\` text NOT NULL,
          \`prefix_messages\` text NOT NULL,
          \`selected_provider\` text NOT NULL,
          \`selected_model\` text NOT NULL,
          \`route_decision_id\` text,
          \`prompt_prefix_hash\` text,
          \`input_target_tokens\` integer NOT NULL,
          \`rollover_reserve_tokens\` integer NOT NULL,
          \`rollover_reason\` text NOT NULL,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`cached_input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_closed\` integer,
          CONSTRAINT \`fk_work_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_warp_outbox_event_role_idx\` ON \`session_warp_outbox\` (\`event_id\`,\`role\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_warp_outbox_due_idx\` ON \`session_warp_outbox\` (\`next_attempt_at\`,\`delivery_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_warp_outbox_session_seq_idx\` ON \`session_warp_outbox\` (\`session_id\`,\`transfer_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workspace_mutation_lease_expiry_idx\` ON \`workspace_mutation_lease\` (\`lease_expires_at\`,\`resource_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workspace_mutation_lease_resource_idx\` ON \`workspace_mutation_lease\` (\`resource_kind\`,\`resource_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_command_receipt_session\` ON \`session_command_receipt\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_input_origin_session_idx\` ON \`session_input_origin\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_origin_node_command_idx\` ON \`session_input_origin\` (\`node_id\`,\`command_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_run_state_run_id_idx\` ON \`session_run_state\` (\`run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_run_state_retry_due_idx\` ON \`session_run_state\` (\`status\`,\`next_retry_at\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_usage_contribution_part_idx\` ON \`session_usage_contribution\` (\`part_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_seq_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`event_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_compat_message_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`compatibility_message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_contribution_session_canonical_message_idx\` ON \`session_usage_contribution\` (\`session_id\`,\`canonical_message_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_session_time_idx\` ON \`verification_receipt\` (\`session_id\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_location_epoch_idx\` ON \`verification_receipt\` (\`location_key\`,\`mutation_epoch\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_receipt_pending_time_idx\` ON \`verification_receipt\` (\`verdict\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`verification_request_outbox_event_idx\` ON \`verification_request_outbox\` (\`event_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_request_outbox_session_time_idx\` ON \`verification_request_outbox\` (\`session_id\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_request_outbox_time_session_idx\` ON \`verification_request_outbox\` (\`time_requested\`,\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_context_epoch_session_epoch_idx\` ON \`work_context_epoch\` (\`session_id\`,\`epoch\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_context_epoch_session_status_idx\` ON \`work_context_epoch\` (\`session_id\`,\`status\`,\`epoch\`);`,
      )
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
