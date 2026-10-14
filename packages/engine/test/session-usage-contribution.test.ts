import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AbsolutePath } from "../src/shared/schema"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { CatalogModel } from "../src/inference/catalog/model"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { SessionManager } from "../src/sessions/service"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import {
  SessionMessageTable,
  SessionTable,
  SessionUsageContributionTable,
} from "../src/storage/tables/sessions"
import { SessionV1 } from "../src/contracts/session/compat"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventBus.defaultLayer, SessionProjector.defaultLayer),
)
const model = {
  id: CatalogModel.ID.make("model"),
  providerID: CatalogProvider.ID.make("provider"),
}
const decodeAssistant = Schema.decodeUnknownSync(SessionV1.Assistant)
const decodeToolPart = Schema.decodeUnknownSync(SessionV1.ToolPart)
const decodeTextPart = Schema.decodeUnknownSync(SessionV1.TextPart)
const decodeStepFinishPart = Schema.decodeUnknownSync(SessionV1.StepFinishPart)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

const setup = Effect.fn("test.setupUsageContribution")(function* (
  ...sessionIDs: SessionManager.ID[]
) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectRegistry.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      sessionIDs.map((id) => ({
        id,
        project_id: ProjectRegistry.ID.global,
        slug: String(id),
        directory: "/project",
        title: String(id),
        version: "test",
      })),
    )
    .run()
    .pipe(Effect.orDie)
})

const usage = (value: number) => ({
  input: value,
  output: value + 1,
  reasoning: value + 2,
  cache: { read: value + 3, write: value + 4 },
})

const assistant = (
  id: string,
  sessionID: SessionManager.ID,
  input: { readonly completed?: number; readonly finish?: string; readonly usage?: number } = {},
) =>
  decodeAssistant({
    id,
    sessionID,
    role: "assistant",
    time: { created: 0, completed: input.completed },
    parentID: "msg_parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    finish: input.finish,
    cost: input.usage ?? 0,
    tokens: usage(input.usage ?? 0),
  })

const stepPart = (
  id: string,
  messageID: string,
  sessionID: SessionManager.ID,
  value: number,
) =>
  decodeStepFinishPart({
    id,
    messageID,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost: value,
    tokens: usage(value),
  })

const totals = Effect.fn("test.usageTotals")(function* (sessionID: SessionManager.ID) {
  const { db } = yield* Database.Service
  return yield* db
    .select({
      cost: SessionTable.cost,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

describe("compatibility checkpoint validation", () => {
  it.effect("rejects mismatched semantic content atomically", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionManager.ID.make("ses_checkpoint_validation")
      const assistantID = SessionMessage.ID.make("msg_checkpoint_validation")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        agent: "build",
        model,
        timestamp: DateTime.makeUnsafe(0),
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: assistantID,
        textID: "text-1",
        timestamp: DateTime.makeUnsafe(1),
      })
      const legacy = assistant(String(assistantID), sessionID)
      const part = decodeTextPart({
        id: "prt_checkpoint_validation",
        sessionID,
        messageID: legacy.id,
        type: "text",
        text: "tampered",
        time: { start: 1, end: 2 },
      })
      const exit = yield* events
        .publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID: assistantID,
          textID: "text-1",
          text: "expected",
          legacyPartID: part.id,
          timestamp: DateTime.makeUnsafe(2),
          legacyProjection: {
            version: 1,
            canonicalMessageID: assistantID,
            message: legacy,
            parts: [{ part, time: 2 }],
          },
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("Missing canonical assistant")
      expect(decodeMessage({ ...row.data, id: row.id, type: row.type })).toMatchObject({
        content: [{ type: "text", text: "" }],
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, EventBus.versionedType(SessionEvent.Text.Ended.type, 1)))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("rejects a tool checkpoint at the wrong lifecycle state", () =>
    Effect.gen(function* () {
      const sessionID = SessionManager.ID.make("ses_checkpoint_tool_lifecycle")
      const assistantID = SessionMessage.ID.make("msg_checkpoint_tool_lifecycle")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        agent: "build",
        model,
        timestamp: DateTime.makeUnsafe(0),
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID: assistantID,
        callID: "call-1",
        name: "read",
        timestamp: DateTime.makeUnsafe(1),
      })
      const legacy = assistant(String(assistantID), sessionID)
      const pending = decodeToolPart({
        id: "prt_checkpoint_tool_lifecycle",
        sessionID,
        messageID: legacy.id,
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: { status: "pending", input: {}, raw: "" },
      })
      expect(
        (yield* events
          .publish(SessionEvent.Tool.Called, {
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-1",
            tool: "read",
            input: {},
            provider: { executed: false },
            timestamp: DateTime.makeUnsafe(2),
            legacyProjection: {
              version: 1,
              canonicalMessageID: assistantID,
              message: legacy,
              parts: [{ part: pending, time: 2 }],
            },
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  )
})

describe("session usage contribution projection", () => {
  it.effect("deduplicates semantic and transcript step-finish updates and applies deltas", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionManager.ID.make("ses_usage_dedup")
      const assistantID = SessionMessage.ID.make("msg_usage_dedup")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        agent: "build",
        model,
        timestamp: DateTime.makeUnsafe(0),
      })
      const legacy = assistant(String(assistantID), sessionID, {
        completed: 2,
        finish: "stop",
        usage: 1,
      })
      const part = stepPart("prt_usage_dedup", legacy.id, sessionID, 1)
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 1,
        tokens: usage(1),
        timestamp: DateTime.makeUnsafe(2),
        legacyProjection: {
          version: 1,
          canonicalMessageID: assistantID,
          message: legacy,
          parts: [{ part, time: 2 }],
        },
      })
      yield* events.publish(SessionEvent.Transcript.PartUpdated, {
        sessionID,
        part,
        time: 2,
      })
      expect(yield* totals(sessionID)).toEqual({
        cost: 1,
        input: 1,
        output: 2,
        reasoning: 3,
        cacheRead: 4,
        cacheWrite: 5,
      })
      expect(
        yield* db
          .select({ count: SessionUsageContributionTable.contribution_key })
          .from(SessionUsageContributionTable)
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)

      const updated = stepPart(part.id, legacy.id, sessionID, 3)
      yield* events.publish(SessionEvent.Transcript.PartUpdated, {
        sessionID,
        part: updated,
        time: 3,
      })
      expect(yield* totals(sessionID)).toEqual({
        cost: 3,
        input: 3,
        output: 4,
        reasoning: 5,
        cacheRead: 6,
        cacheWrite: 7,
      })
      yield* events.publish(SessionEvent.Transcript.PartRemoved, {
        sessionID,
        messageID: legacy.id,
        partID: part.id,
      })
      expect(yield* totals(sessionID)).toEqual({
        cost: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
    }),
  )

  it.effect("projects V1 parts, message removal, semantic-only usage, and reset", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionManager.ID.make("ses_usage_compatibility")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      const legacy = assistant("msg_usage_compatibility", sessionID)
      const part = stepPart("prt_usage_compatibility", legacy.id, sessionID, 2)
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: legacy })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part, time: 1 })
      expect((yield* totals(sessionID))?.cost).toBe(2)
      yield* events.publish(SessionEvent.Transcript.MessageRemoved, {
        sessionID,
        messageID: legacy.id,
      })
      expect((yield* totals(sessionID))?.cost).toBe(0)

      const assistantID = SessionMessage.ID.make("msg_usage_semantic_only")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        agent: "build",
        model,
        timestamp: DateTime.makeUnsafe(2),
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 5,
        tokens: usage(5),
        timestamp: DateTime.makeUnsafe(3),
      })
      expect((yield* totals(sessionID))?.cost).toBe(5)
      yield* events.publish(SessionEvent.Transcript.Reset, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect((yield* totals(sessionID))?.cost).toBe(0)
      expect(
        yield* db
          .select()
          .from(SessionUsageContributionTable)
          .where(eq(SessionUsageContributionTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("removes only contributions after a canonical revert boundary", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionManager.ID.make("ses_usage_revert")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      const publishStep = Effect.fn("test.publishUsageStep")(function* (
        canonicalID: SessionMessage.ID,
        value: number,
      ) {
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: canonicalID,
          agent: "build",
          model,
          timestamp: DateTime.makeUnsafe(value * 10),
        })
        const legacy = assistant(String(canonicalID), sessionID, {
          completed: value * 10 + 1,
          finish: "stop",
          usage: value,
        })
        const part = stepPart(`prt_usage_revert_${value}`, legacy.id, sessionID, value)
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID: canonicalID,
          finish: "stop",
          cost: value,
          tokens: usage(value),
          timestamp: DateTime.makeUnsafe(value * 10 + 1),
          legacyProjection: {
            version: 1,
            canonicalMessageID: canonicalID,
            message: legacy,
            parts: [{ part, time: value * 10 + 1 }],
          },
        })
      })
      const first = SessionMessage.ID.make("msg_usage_revert_1")
      const second = SessionMessage.ID.make("msg_usage_revert_2")
      yield* publishStep(first, 1)
      yield* publishStep(second, 2)
      expect((yield* totals(sessionID))?.cost).toBe(3)
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: first,
        timestamp: DateTime.makeUnsafe(30),
      })
      expect((yield* totals(sessionID))?.cost).toBe(1)
      expect(
        yield* db
          .select({ canonical: SessionUsageContributionTable.canonical_message_id })
          .from(SessionUsageContributionTable)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ canonical: first }])
    }),
  )

  it.effect("rebuilds semantic-only contributions deterministically", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionManager.ID.make("ses_usage_replay")
      const assistantID = SessionMessage.ID.make("msg_usage_replay")
      yield* setup(sessionID)
      const events = yield* EventBus.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        agent: "build",
        model,
        timestamp: DateTime.makeUnsafe(0),
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 4,
        tokens: usage(4),
        timestamp: DateTime.makeUnsafe(1),
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      yield* events.remove(sessionID)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(SessionUsageContributionTable)
        .where(eq(SessionUsageContributionTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const replay = recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      yield* events.replayAll(replay)
      yield* events.replayAll(replay)
      expect((yield* totals(sessionID))?.cost).toBe(4)
      expect(
        yield* db
          .select()
          .from(SessionUsageContributionTable)
          .where(eq(SessionUsageContributionTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )
})
