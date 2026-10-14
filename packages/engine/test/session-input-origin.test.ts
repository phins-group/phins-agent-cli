import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { EventTable } from "../src/storage/tables/events"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { AbsolutePath } from "../src/shared/schema"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionInputOrigin } from "../src/sessions/input/origin"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionProjector } from "../src/sessions/projector"
import { Session as SessionSchema } from "../src/contracts/session/info"
import { Prompt } from "../src/contracts/session/prompt"
import {
  SessionInputTable,
  SessionInputOriginTable,
  SessionTable,
} from "../src/storage/tables/sessions"
import { Workspace as WorkspaceIdentity } from "../src/contracts/workspace/workspace"
import { inputOrigin } from "./fixture/session-input-origin"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const layer = Layer.mergeAll(
  Database.defaultLayer,
  EventBus.defaultLayer,
  SessionProjector.defaultLayer,
)
const it = testEffect(layer)
const sessionID = SessionSchema.ID.make("ses_origin_fixture")
const id = SessionMessage.ID.make("msg_origin_fixture")
const input = () => ({
  id,
  sessionID,
  prompt: Prompt.make({ text: "Read the project" }),
  delivery: "steer" as const,
  origin: inputOrigin(),
})
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectRegistry.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      directory: "/project",
      slug: "origin",
      title: "Origin fixture",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})
const admit = (value = input()) =>
  Effect.gen(function* () {
    return yield* SessionInput.admit(
      (yield* Database.Service).db,
      yield* EventBus.Service,
      value,
    )
  })
const conflict = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.matchCause({
      onFailure: (cause) =>
        expect(
          cause.reasons.some(
            (reason) =>
              Cause.isDieReason(reason) &&
              reason.defect instanceof SessionInput.InputLifecycleConflict,
          ),
        ).toBe(true),
      onSuccess: () => {
        throw new Error("Expected an origin conflict")
      },
    }),
  )
const counts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    inputs: (yield* db
      .select()
      .from(SessionInputTable)
      .all()
      .pipe(Effect.orDie)).length,
    origins: (yield* db
      .select()
      .from(SessionInputOriginTable)
      .all()
      .pipe(Effect.orDie)).length,
    events: (yield* db.select().from(EventTable).all().pipe(Effect.orDie))
      .length,
  }
})

describe("durable input origins", () => {
  it.effect(
    "records provenance with a distinct replayable event, without promotion",
    () =>
      Effect.gen(function* () {
        yield* setup
        const recorded = yield* admit()
        expect(recorded).toMatchObject({
          id,
          sessionID,
          origin: inputOrigin(),
        })
        expect(recorded.promotedSeq).toBeUndefined()
        const { db } = yield* Database.Service
        expect(yield* SessionInput.find(db, id)).toEqual(recorded)
        expect(
          (yield* db.select().from(EventTable).all().pipe(Effect.orDie))[0]
            ?.type,
        ).toBe(EventBus.versionedType(SessionEvent.OriginPromptAdmitted.type, 1))
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect("returns one immutable binding for exact concurrent retries", () =>
    Effect.gen(function* () {
      yield* setup
      const results = yield* Effect.all([admit(), admit()], {
        concurrency: "unbounded",
      })
      expect(results[0]).toEqual(results[1])
      expect(yield* admit()).toEqual(results[0])
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
    }),
  )

  it.effect(
    "conflicts if the payload, delivery or any origin binding changes",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* admit()
        const changes: Partial<SessionInputOrigin.Origin>[] = [
          { source: "channel" },
          { commandID: "other" },
          { nodeID: "other" },
          { userID: "other" },
          { platformWorkspaceID: "other" },
          { loginID: "other" },
          { projectID: ProjectRegistry.ID.make("other") },
          { location: { directory: AbsolutePath.make("/other") } },
          {
            location: {
              directory: AbsolutePath.make("/project"),
              workspaceID: WorkspaceIdentity.ID.make("wrk_other"),
            },
          },
          { grantID: "other" },
          { grantRevision: 8 },
          { attemptID: "other" },
          { expiresAt: DateTime.makeUnsafe(2_000_000_000_001) },
        ]
        for (const change of changes)
          yield* conflict(admit({ ...input(), origin: inputOrigin(change) }))
        yield* conflict(
          admit({ ...input(), prompt: Prompt.make({ text: "Write instead" }) }),
        )
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        yield* conflict(
          SessionInput.admit(db, events, { ...input(), delivery: "queue" }),
        )
        expect(
          yield* SessionInput.admit(db, events, {
            ...input(),
            origin: undefined,
          }).pipe(Effect.flip),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect("does not admit one Node command under another message ID", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit()
      yield* conflict(admit({ ...input(), id: SessionMessage.ID.create() }))
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
    }),
  )

  it.effect("keeps command identities scoped to their Node", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit()
      yield* admit({
        ...input(),
        id: SessionMessage.ID.create(),
        origin: inputOrigin({ nodeID: "another_node" }),
      })
      expect(yield* counts).toEqual({ inputs: 2, origins: 2, events: 2 })
    }),
  )

  it.effect("rejects a project or Location mismatch atomically", () =>
    Effect.gen(function* () {
      yield* setup
      for (const change of [
        { projectID: ProjectRegistry.ID.make("other") },
        { location: { directory: AbsolutePath.make("/other") } },
        {
          location: {
            directory: AbsolutePath.make("/project"),
            workspaceID: WorkspaceIdentity.ID.make("wrk_other"),
          },
        },
      ])
        yield* conflict(admit({ ...input(), origin: inputOrigin(change) }))
      expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
    }),
  )

  it.effect(
    "snapshots caller-owned origin and prompt before waiting on publication",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const started = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()
        const value = input()
        const fiber = yield* SessionInput.admit(
          db,
          {
            ...events,
            publish: (definition, data, options) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(events.publish(definition, data, options)),
              ),
          },
          value,
        ).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        Object.assign(value.origin, {
          grantRevision: 99,
          commandID: "mutated",
        })
        Object.assign(value.origin.location, {
          directory: AbsolutePath.make("/outside"),
        })
        Object.assign(value.prompt, { text: "Mutated prompt" })
        value.id = SessionMessage.ID.create()
        yield* Deferred.succeed(release, undefined)
        const recorded = yield* Fiber.join(fiber)
        expect(recorded).toMatchObject({
          id,
          prompt: { text: "Read the project" },
          origin: inputOrigin(),
        })
        expect(yield* SessionInput.find(db, id)).toEqual(recorded)
      }),
  )

  it.effect(
    "fails closed before promoting even a mixed local/remote inbox",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const local = yield* SessionInput.admit(db, events, {
          ...input(),
          id: SessionMessage.ID.create(),
          origin: undefined,
        })
        yield* admit()
        const error = yield* SessionInput.promoteSteers(
          db,
          events,
          sessionID,
          100,
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(
          (yield* SessionInput.find(db, local.id))?.promotedSeq,
        ).toBeUndefined()
        expect((yield* SessionInput.find(db, id))?.promotedSeq).toBeUndefined()
        expect(yield* counts).toEqual({ inputs: 2, origins: 1, events: 2 })
      }),
  )

  it.effect(
    "refuses to promote a bound input through the legacy local event",
    () =>
      Effect.gen(function* () {
        yield* setup
        const recorded = yield* admit()
        const events = yield* EventBus.Service
        yield* conflict(
          events.publish(SessionEvent.Prompted, {
            sessionID,
            messageID: id,
            prompt: recorded.prompt,
            delivery: recorded.delivery,
            timestamp: recorded.timeCreated,
          }),
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "retains the origin fence when the input projection is removed",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* admit()
        const { db } = yield* Database.Service
        yield* db
          .delete(SessionInputTable)
          .where(eq(SessionInputTable.id, id))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        yield* conflict(admit())
        expect(yield* counts).toEqual({ inputs: 0, origins: 1, events: 1 })
      }),
  )

  it.effect("clears provenance only with deletion of its owning session", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit()
      const { db } = yield* Database.Service
      yield* db
        .delete(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* counts).toMatchObject({ inputs: 0, origins: 0 })
    }),
  )

  it.effect(
    "replays the entire origin projection without enabling execution",
    () =>
      Effect.gen(function* () {
        yield* setup
        const original = yield* admit()
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const journal = yield* db
          .select()
          .from(EventTable)
          .all()
          .pipe(Effect.orDie)
        // Rebuild all projections in this test-owned database from its journal.
        yield* events.remove(sessionID)
        yield* db.delete(SessionInputTable).run().pipe(Effect.orDie)
        yield* db.delete(SessionInputOriginTable).run().pipe(Effect.orDie)
        yield* events.replayAll(
          journal.map((event) => ({
            id: event.id,
            aggregateID: event.aggregate_id,
            seq: event.seq,
            type: event.type,
            data: event.data,
          })),
        )
        expect(yield* SessionInput.find(db, id)).toEqual(original)
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "retains provenance across actual transcript reset and revert events",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const boundary = SessionMessage.ID.create()
        const local = {
          sessionID,
          messageID: boundary,
          prompt: Prompt.make({ text: "Local boundary" }),
          delivery: "steer" as const,
          timestamp: DateTime.makeUnsafe(1),
        }
        yield* events.publish(SessionEvent.Prompted, local)
        yield* admit()
        yield* events.publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: boundary,
          timestamp: DateTime.makeUnsafe(2),
        })
        expect(yield* SessionInput.find(db, id)).toBeUndefined()
        expect(yield* counts).toMatchObject({ origins: 1 })
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        yield* events.publish(SessionEvent.Transcript.Reset, {
          sessionID,
          timestamp: DateTime.makeUnsafe(3),
        })
        expect(yield* counts).toMatchObject({ origins: 1 })
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        yield* conflict(admit())
      }),
  )

  it.effect("does not use malformed stored metadata as local authority", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionInputOriginTable)
        .set({ origin: { ...inputOrigin(), source: "invalid" } as never })
        .where(eq(SessionInputOriginTable.id, id))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(Effect.flip),
      ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
    }),
  )

  test("origin metadata rejects credential fields and unsafe revisions", () => {
    const decode = Schema.decodeUnknownSync(
      Schema.toType(SessionInputOrigin.Origin),
      { onExcessProperty: "error" },
    )
    expect(() =>
      decode({ ...inputOrigin(), token: "fixture_not_a_credential" }),
    ).toThrow()
    expect(() =>
      decode({ ...inputOrigin(), grantRevision: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow()
    expect(() => decode({ ...inputOrigin(), source: "local" })).toThrow()
    expect(() => decode({ ...inputOrigin(), commandID: "" })).toThrow()
  })

  test("restores provenance and its execution fence after reopening an on-disk database", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "origin.sqlite")
    const persistent = () => {
      const database = Database.layerFromPath(filename)
      const events = EventBus.layer.pipe(Layer.provide(database))
      return Layer.mergeAll(
        database,
        events,
        SessionProjector.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
        ),
      )
    }
    await Effect.runPromise(
      setup.pipe(
        Effect.andThen(admit()),
        Effect.provide(persistent()),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect((yield* SessionInput.find(db, id))?.origin).toEqual(
          inputOrigin(),
        )
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        yield* conflict(
          admit({
            ...input(),
            origin: inputOrigin({ attemptID: "new_attempt" }),
          }),
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }).pipe(Effect.provide(persistent()), Effect.scoped),
    )
  })
})
