import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "../src/storage/drizzle/index"
import { Effect, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/storage/migration"
import { migrations } from "../src/storage/migration.gen"
import sessionUsageMigration from "../src/storage/migrations/20260510033149_session_usage"
import normalizeStoragePathsMigration from "../src/storage/migrations/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "../src/storage/migrations/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "../src/storage/migrations/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "../src/storage/migrations/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "../src/storage/migrations/20260611192811_lush_chimera"
import simplifySessionInputMigration from "../src/storage/migrations/20260622202450_simplify_session_input"
import { EventBus } from "../src/runtime/events/bus"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import runInputOwnerMigration from "../src/storage/migrations/20261005143808_session_run_input_owner"
import { Session as SessionSchema } from "../src/contracts/session/info"
import { SessionTable } from "../src/storage/tables/sessions"
import sessionMetadataMigration from "../src/storage/migrations/20260511173437_session-metadata"
import verificationReceiptMigration from "../src/storage/migrations/20260729010558_verification_receipt"
import verificationRequestOutboxMigration from "../src/storage/migrations/20260729040943_verification_request_outbox"
import verificationAttemptLeaseMigration from "../src/storage/migrations/20260731015112_verification_attempt_lease"
import verificationAttemptTimeoutMigration from "../src/storage/migrations/20260731022945_verification_attempt_timeout"
import eventOwnerGenerationMigration from "../src/storage/migrations/20260731023300_event_owner_generation"
import workspaceMutationLeaseMigration from "../src/storage/migrations/20260731073410_workspace-mutation-lease"
import workspaceSessionMutationFencesMigration from "../src/storage/migrations/20260731081000_workspace-session-mutation-fences"
import verificationExecutionAttestationMigration from "../src/storage/migrations/20260731074831_verification-execution-attestation"
import sessionRunStateMigration from "../src/storage/migrations/20260801155612_session_run_state"
import inputOriginMigration from "../src/storage/migrations/20261005065909_session_input_origin"
import nodeReceiptMigration from "../src/storage/migrations/20261006020515_node_command_receipt"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "../src/storage/database"
import { SessionProjector } from "../src/sessions/projector"
import { SessionV1 } from "../src/contracts/session/compat"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("adds a spent-command journal independently of session deletion without rewriting local data", async () => {
    await run(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text)`)
      yield* db.run(sql`INSERT INTO session VALUES ('ses_local', 'Keep local')`)
      yield* DatabaseMigration.applyOnly(db, [nodeReceiptMigration])
      yield* db.run(sql`INSERT INTO node_command_receipt VALUES ('spent', 'binding', 'unknown', '{"text":"result"}', 1)`)
      yield* DatabaseMigration.applyOnly(db, [nodeReceiptMigration])
      expect(yield* db.all(sql`SELECT * FROM session`)).toEqual([{ id: "ses_local", title: "Keep local" }])
      yield* db.run(sql`DELETE FROM session WHERE id='ses_local'`)
      expect(yield* db.all(sql`SELECT * FROM node_command_receipt`)).toEqual([
        { id: "spent", binding_hash: "binding", status: "unknown", result: '{"text":"result"}', time_updated: 1 },
      ])
      expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: nodeReceiptMigration.id }])
    }))
  })
  test("adds remote run ownership without changing existing local runs", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session_run_state (session_id text PRIMARY KEY, run_id text, status text)`)
        yield* db.run(sql`INSERT INTO session_run_state VALUES ('ses_local', 'run_local', 'busy')`)
        yield* DatabaseMigration.applyOnly(db, [runInputOwnerMigration])
        yield* DatabaseMigration.applyOnly(db, [runInputOwnerMigration])
        expect(yield* db.all(sql`SELECT * FROM session_run_state`)).toEqual([
          { session_id: "ses_local", run_id: "run_local", status: "busy", input_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: runInputOwnerMigration.id }])
      }),
    )
  })
  test("adds the origin ledger without rewriting legacy local input", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_input (id text PRIMARY KEY, session_id text, prompt text)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_local')`)
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt) VALUES ('msg_local', 'ses_local', '{"text":"Keep local input"}')`,
        )
        const before = yield* db.all(sql`SELECT * FROM session_input`)
        yield* DatabaseMigration.applyOnly(db, [inputOriginMigration])
        yield* DatabaseMigration.applyOnly(db, [inputOriginMigration])
        expect(yield* db.all(sql`SELECT * FROM session_input`)).toEqual(before)
        expect(yield* db.all(sql`SELECT * FROM session_input_origin`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: inputOriginMigration.id }])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'session_input_origin_%' ORDER BY name`,
          ),
        ).toEqual([{ name: "session_input_origin_node_command_idx" }, { name: "session_input_origin_session_idx" }])
      }),
    )
  })
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_state'`),
        ).toEqual({ name: "session_run_state" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_tree_budget'`),
        ).toEqual({ name: "session_tree_budget" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_usage_contribution'`,
          ),
        ).toEqual({ name: "session_usage_contribution" })
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name IN ('message', 'part')
          `),
        ).toEqual([])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_location_state'`,
          ),
        ).toEqual({ name: "verification_location_state" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_receipt'`),
        ).toEqual({ name: "verification_receipt" })
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'session_workspace_insert_guard',
                'session_workspace_update_guard',
                'workspace_session_delete_guard'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_workspace_insert_guard" },
          { name: "session_workspace_update_guard" },
          { name: "workspace_session_delete_guard" },
        ])
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_request_outbox'`,
          ),
        ).toEqual({ name: "verification_request_outbox" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name IN ('agent', 'replacement_seq', 'revision')`,
          ),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('verification_receipt_location_epoch_idx', 'verification_receipt_pending_time_idx', 'verification_receipt_session_time_idx', 'verification_request_outbox_event_idx', 'verification_request_outbox_session_time_idx', 'verification_request_outbox_time_session_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "verification_receipt_location_epoch_idx" },
          { name: "verification_receipt_pending_time_idx" },
          { name: "verification_receipt_session_time_idx" },
          { name: "verification_request_outbox_event_idx" },
          { name: "verification_request_outbox_session_time_idx" },
          { name: "verification_request_outbox_time_session_idx" },
        ])
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN ('session_run_state_retry_due_idx', 'session_run_state_run_id_idx')
            ORDER BY name
          `),
        ).toEqual([{ name: "session_run_state_retry_due_idx" }, { name: "session_run_state_run_id_idx" }])
      }),
    )
  })

  test("adds durable run state storage to an existing session database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [sessionRunStateMigration])

        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_state'`),
        ).toEqual({ name: "session_run_state" })
        expect(
          yield* db.all(sql`
            SELECT name
            FROM pragma_table_info('session_run_state')
            ORDER BY cid
          `),
        ).toEqual([
          { name: "session_id" },
          { name: "run_id" },
          { name: "status" },
          { name: "attempt" },
          { name: "next_retry_at" },
          { name: "error" },
          { name: "time_started" },
          { name: "time_settled" },
        ])
        expect(
          yield* db.all(sql`
            SELECT "from" AS source, "table" AS target, on_delete AS onDelete
            FROM pragma_foreign_key_list('session_run_state')
          `),
        ).toEqual([{ source: "session_id", target: "session", onDelete: "CASCADE" }])

        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_run_state_migration')`)
        yield* db.run(sql`
          INSERT INTO session_run_state
            (session_id, run_id, status, time_started)
          VALUES ('ses_run_state_migration', 'run_migration', 'busy', 10)
        `)
        expect(yield* db.get(sql`SELECT status, time_started AS started FROM session_run_state`)).toEqual({
          status: "busy",
          started: 10,
        })
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_run_state_migration'`)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_run_state`)).toEqual({ count: 0 })
      }),
    )
  })

  test("adds verification receipt recovery storage to an existing session database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [
          verificationReceiptMigration,
          verificationRequestOutboxMigration,
          verificationAttemptLeaseMigration,
          verificationAttemptTimeoutMigration,
        ])

        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verification_location_state', 'verification_receipt', 'verification_request_outbox') ORDER BY name`,
          ),
        ).toEqual([
          { name: "verification_location_state" },
          { name: "verification_receipt" },
          { name: "verification_request_outbox" },
        ])
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_verification')`)
        yield* db.run(sql`
          INSERT INTO verification_location_state
            (location_key, mutation_epoch, snapshot, time_created, time_updated)
          VALUES ('location', 2, 'tree', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO verification_receipt
            (id, session_id, location_key, mode, mutation_epoch, checks, time_requested)
          VALUES ('vrc_test', 'ses_verification', 'location', 'shadow', 2, '[]', 1)
        `)
        yield* db.run(sql`
          INSERT INTO verification_request_outbox
            (receipt_id, event_id, session_id, location_key, mode, mutation_epoch, time_requested)
          VALUES ('vrc_outbox', 'evt_outbox', 'ses_verification', 'location', 'shadow', 3, 2)
        `)
        expect(
          yield* db.get(sql`
            SELECT
              attempt_generation AS generation,
              attempt_timeout_ms AS timeout,
              attempt_token AS token,
              attempt_lease_expires AS expires
            FROM verification_receipt
          `),
        ).toEqual({ generation: 0, timeout: null, token: null, expires: null })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM verification_request_outbox`)).toEqual({ count: 1 })
        expect(
          yield* db.all(sql`
            SELECT "from" AS source, "table" AS target, on_delete AS onDelete
            FROM pragma_foreign_key_list('verification_receipt')
            ORDER BY source
          `),
        ).toEqual([
          {
            source: "location_key",
            target: "verification_location_state",
            onDelete: "NO ACTION",
          },
          { source: "session_id", target: "session", onDelete: "CASCADE" },
        ])
        expect(
          yield* db.all(sql`
            SELECT "from" AS source, "table" AS target, on_delete AS onDelete
            FROM pragma_foreign_key_list('verification_request_outbox')
            ORDER BY source
          `),
        ).toEqual([
          {
            source: "location_key",
            target: "verification_location_state",
            onDelete: "NO ACTION",
          },
          { source: "session_id", target: "session", onDelete: "CASCADE" },
        ])
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'verification_receipt_pending_time_idx',
                'verification_request_outbox_event_idx',
                'verification_request_outbox_session_time_idx',
                'verification_request_outbox_time_session_idx'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "verification_receipt_pending_time_idx" },
          { name: "verification_request_outbox_event_idx" },
          { name: "verification_request_outbox_session_time_idx" },
          { name: "verification_request_outbox_time_session_idx" },
        ])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(verification_request_outbox)`)).find(
            (index) => index.name === "verification_request_outbox_event_idx",
          ),
        ).toMatchObject({ unique: 1 })
      }),
    )
  })

  test("adds a zero owner generation to existing event sequences", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text)`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES ('session', 4, 'owner-a')`)

        yield* DatabaseMigration.applyOnly(db, [eventOwnerGenerationMigration])

        expect(
          yield* db.get(sql`
            SELECT
              aggregate_id AS aggregateID,
              owner_id AS ownerID,
              owner_generation AS ownerGeneration
            FROM event_sequence
          `),
        ).toEqual({ aggregateID: "session", ownerID: "owner-a", ownerGeneration: 0 })
      }),
    )
  })

  test("adds durable workspace mutation leases with monotonic generation storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb

        yield* DatabaseMigration.applyOnly(db, [workspaceMutationLeaseMigration])
        yield* db.run(sql`
          INSERT INTO workspace_mutation_lease
            (resource_key, resource_kind, resource_id, time_updated)
          VALUES ('session:ses_test', 'session', 'ses_test', 1)
        `)

        expect(
          yield* db.get(sql`
            SELECT
              operation,
              lease_token AS token,
              lease_generation AS generation,
              lease_expires_at AS expiresAt
            FROM workspace_mutation_lease
            WHERE resource_key = 'session:ses_test'
          `),
        ).toEqual({ operation: null, token: null, generation: 0, expiresAt: null })
        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'workspace_mutation_lease_expiry_idx',
                'workspace_mutation_lease_resource_idx'
              )
            ORDER BY name
          `),
        ).toEqual([{ name: "workspace_mutation_lease_expiry_idx" }, { name: "workspace_mutation_lease_resource_idx" }])
      }),
    )
  })

  test("adds execution attestation storage without rewriting existing receipts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE verification_receipt (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO verification_receipt (id) VALUES ('vrc_existing')`)

        yield* DatabaseMigration.applyOnly(db, [verificationExecutionAttestationMigration])

        expect(
          yield* db.get(sql`
            SELECT id, attestation
            FROM verification_receipt
            WHERE id = 'vrc_existing'
          `),
        ).toEqual({ id: "vrc_existing", attestation: null })
      }),
    )
  })

  test("fences Session workspace mutations and restricts workspace deletion in SQLite", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`
          CREATE TABLE workspace_mutation_lease (
            resource_key text PRIMARY KEY,
            operation text,
            lease_token text,
            lease_expires_at integer
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [workspaceSessionMutationFencesMigration])

        // A dedicated workspace process has its own SQLite database. Its
        // opaque workspace owner ID therefore need not have a local row.
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('remote', 'wrk_remote')`)

        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_source'), ('wrk_target')`)
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('ses_one', 'wrk_source')`)
        yield* db.run(sql`
          INSERT INTO workspace_mutation_lease
            (resource_key, operation, lease_token, lease_expires_at)
          VALUES (
            'workspace:wrk_source',
            'workspace-remove',
            'active-remove',
            9999999999999
          )
        `)

        const blockedInsert = yield* db
          .run(sql`INSERT INTO session (id, workspace_id) VALUES ('ses_two', 'wrk_source')`)
          .pipe(Effect.exit)
        expect(blockedInsert._tag).toBe("Failure")
        if (blockedInsert._tag === "Failure") {
          expect(String(blockedInsert.cause)).toContain("workspace removal in progress")
        }

        const blockedUpdate = yield* db
          .run(sql`UPDATE session SET workspace_id = 'wrk_target' WHERE id = 'ses_one'`)
          .pipe(Effect.exit)
        expect(blockedUpdate._tag).toBe("Failure")
        if (blockedUpdate._tag === "Failure") {
          expect(String(blockedUpdate.cause)).toContain("workspace removal in progress")
        }

        yield* db.run(sql`
          UPDATE workspace_mutation_lease
          SET lease_expires_at = 0
          WHERE resource_key = 'workspace:wrk_source'
        `)
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('ses_expired', 'wrk_source')`)
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_expired'`)

        // The same resource row is rewritten to session-warp by lease
        // acquisition, so the warp's own canonical projection is permitted.
        yield* db.run(sql`
          UPDATE workspace_mutation_lease
          SET operation = 'session-warp'
          WHERE resource_key = 'workspace:wrk_source'
        `)
        yield* db.run(sql`UPDATE session SET workspace_id = 'wrk_target' WHERE id = 'ses_one'`)

        const blockedDelete = yield* db.run(sql`DELETE FROM workspace WHERE id = 'wrk_target'`).pipe(Effect.exit)
        expect(blockedDelete._tag).toBe("Failure")
        if (blockedDelete._tag === "Failure") {
          expect(String(blockedDelete.cause)).toContain("workspace has attached sessions")
        }

        yield* db.run(sql`UPDATE session SET workspace_id = NULL WHERE id = 'ses_one'`)
        yield* db.run(sql`DELETE FROM workspace WHERE id = 'wrk_target'`)
        yield* db.run(sql`UPDATE session SET workspace_id = 'wrk_target' WHERE id = 'ses_one'`)
        expect(yield* db.get(sql`SELECT workspace_id AS workspaceID FROM session WHERE id = 'ses_one'`)).toEqual({
          workspaceID: "wrk_target",
        })
      }),
    )
  })

  test("accepts an opaque workspace owner in a dedicated Session database", async () => {
    // Controller database: the authoritative Workspace row lives here.
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_remote_owner')`)
      }),
    )

    // Remote process database: only the opaque owner ID is projected here.
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`
          CREATE TABLE workspace_mutation_lease (
            resource_key text PRIMARY KEY,
            operation text,
            lease_token text,
            lease_expires_at integer
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [workspaceSessionMutationFencesMigration])
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('ses_remote', 'wrk_remote_owner')`)
        expect(yield* db.get(sql`SELECT workspace_id AS workspaceID FROM session WHERE id = 'ses_remote'`)).toEqual({
          workspaceID: "wrk_remote_owner",
        })
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("preserves Session metadata and restarts its event stream after the beta reset", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace', 'local', 'global', 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'global', 'workspace', 'session', '/project', 'Before', 'test', 1, 1)`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event', 'session', 9, 'session.updated.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('input', 'session', '{}', 'steer', 9, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('projected', 'session', 'user', 9, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('session', 'baseline', '{}', 9)`,
        )
        yield* db.run(sql`DELETE FROM migration WHERE id = ${simplifySessionInputMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [simplifySessionInputMigration])

        const database = Layer.succeed(Database.Service, { db })
        const events = EventBus.layer.pipe(Layer.provide(database))
        yield* EventBus.Service.use((service) =>
          service.publish(SessionV1.Event.Updated, {
            sessionID: SessionSchema.ID.make("session"),
            info: {
              id: SessionSchema.ID.make("session"),
              slug: "session",
              projectID: ProjectRegistry.ID.global,
              directory: "/project",
              title: "After",
              version: "test",
              time: { created: 1, updated: 2 },
            },
          }),
        ).pipe(
          Effect.provide(
            Layer.merge(events, SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
          ),
        )

        expect(
          yield* db.get(sql`
            SELECT
              (SELECT title FROM session WHERE id = 'session') AS title,
              (SELECT workspace_id FROM session WHERE id = 'session') AS workspaceID,
              (SELECT COUNT(*) FROM sqlite_master
                WHERE type = 'table' AND name IN ('message', 'part')) AS legacyTranscriptTables,
              (SELECT COUNT(*) FROM workspace) AS workspaces,
              (SELECT COUNT(*) FROM session_input) AS sessionInputs,
              (SELECT COUNT(*) FROM session_message) AS sessionMessages,
              (SELECT COUNT(*) FROM session_context_epoch) AS contextEpochs,
              (SELECT seq FROM event_sequence WHERE aggregate_id = 'session') AS seq,
              (SELECT type FROM event WHERE aggregate_id = 'session') AS eventType
          `),
        ).toEqual({
          title: "After",
          workspaceID: null,
          legacyTranscriptTables: 0,
          workspaces: 0,
          sessionInputs: 0,
          sessionMessages: 0,
          contextEpochs: 0,
          seq: 0,
          eventType: "session.updated.1",
        })
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectRegistry.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectRegistry.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})
