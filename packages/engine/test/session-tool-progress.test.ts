import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { CatalogModel } from "../src/inference/catalog/model"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import { SessionTable, SessionMessageTable } from "../src/storage/tables/sessions"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer, SessionProjector.defaultLayer))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: CatalogModel.ID.make("model"), providerID: CatalogProvider.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }]

describe("Tool.Progress", () => {
  it.effect("projects durable progress and keeps final settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventBus.Service
      const sessionID = SessionManager.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectRegistry.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectRegistry.ID.global,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name: "bash",
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false },
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })

      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: { phase: "checkpoint" }, content: content("saved") },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "error",
          structured: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toContain(EventBus.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventBus.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventBus.versionedType(SessionEvent.Tool.Failed.type, 1))
    }),
  )
})
