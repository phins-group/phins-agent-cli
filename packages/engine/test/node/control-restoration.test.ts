import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import path from "node:path"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import * as ControlCommand from "../../src/execution/control/command"
import * as Receiver from "../../src/execution/control/receiver"
import * as Restoration from "../../src/execution/control/restoration"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { PermissionOrigin } from "../../src/security/permissions/origin"
import { PermissionSaved } from "../../src/security/permissions/saved"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { SessionInputOrigin } from "../../src/sessions/input/origin"
import { SessionInput } from "../../src/sessions/input/inbox"
import { Prompt } from "../../src/contracts/session/prompt"
import { SessionMessage } from "../../src/sessions/messages/service"
import { SessionProjector } from "../../src/sessions/projector"
import { Session as SessionSchema } from "../../src/contracts/session/info"
import {
  SessionInputOriginTable,
  SessionInputTable,
  SessionTable,
} from "../../src/storage/tables/sessions"
import {
  counts,
  expected,
  identity,
  layer,
  location,
  node,
  proof,
  sessionID,
  setup,
} from "../fixture/node-control"
import {
  permissionLayer,
  setup as setupPermissions,
  setRules,
} from "../fixture/permission"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(layer)
const target = {
  sessionID,
  messageID: SessionMessage.ID.make(`msg_node_${expected.attempt.id}`),
}
const readOnly: ControlCommand.Proof["rules"] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "src/*", effect: "allow" },
  { action: "read", resource: "src/private/*", effect: "deny" },
]
const granted = (): ControlCommand.Proof => ({ ...proof(), rules: readOnly })
const record = Effect.gen(function* () {
  yield* setup
  yield* Receiver.receivePrompt(node(), expected)
})
const permits = (
  constraint: PermissionOrigin.Constraint,
  action = "read",
  resources = ["src/index.ts"],
) => PermissionOrigin.permits({ sessionID, action, resources }, [constraint])

describe("durable prompt permission restoration", () => {
  it.effect("never interprets a local pending input as a native command", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.make("msg_local")
      yield* SessionInput.admit(db, yield* EventBus.Service, {
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Local prompt" }),
        delivery: "queue",
      })
      let calls = 0
      const client = node(async () => {
        calls++
        return granted()
      })
      expect(
        yield* Restoration.restorePrompt(client, { sessionID, messageID }).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(Restoration.RestorationError)
      expect(calls).toBe(0)
      expect(yield* counts).toEqual({ inputs: 1, origins: 0, events: 1 })
    }),
  )

  it.effect(
    "restores only a fresh immutable ceiling without changing the input or installing authority",
    () =>
      Effect.gen(function* () {
        yield* record
        const before = yield* counts
        let calls = 0
        const client = node(async (input) => {
          expect(input).toEqual(expected)
          calls++
          return granted()
        })
        const constraint = yield* Restoration.restorePrompt(client, target)
        expect(constraint.sessionID).toBe(sessionID)
        expect(constraint.rules).toEqual(readOnly)
        expect(Object.isFrozen(constraint)).toBe(true)
        expect(Object.isFrozen(constraint.rules)).toBe(true)
        expect(Object.isFrozen(constraint.rules[0])).toBe(true)
        expect(yield* constraint.valid).toBe(true)
        expect(yield* constraint.valid).toBe(true)
        expect(calls).toBe(3)
        expect(yield* PermissionOrigin.capture).toEqual([])
        expect(yield* counts).toEqual(before)
        const { db } = yield* Database.Service
        expect(
          yield* db.select().from(SessionInputTable).get().pipe(Effect.orDie),
        ).toMatchObject({ promoted_seq: null })
        expect(
          yield* PermissionOrigin.restrict(
            constraint,
            SessionInputOrigin.requireLocal(db, sessionID),
          ).pipe(Effect.flip),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
      }),
  )

  it.effect(
    "keeps ordered rules and does not widen missing, denied or unrelated resources",
    () =>
      Effect.gen(function* () {
        yield* record
        const constraint = yield* Restoration.restorePrompt(
          node(async () => granted()),
          target,
        )
        expect(yield* permits(constraint)).toBe(true)
        expect(yield* permits(constraint, "read", ["src/private/key"])).toBe(
          false,
        )
        expect(
          yield* permits(constraint, "read", ["src/index.ts", "secrets.json"]),
        ).toBe(false)
        expect(yield* permits(constraint, "edit")).toBe(false)
        expect(yield* permits(constraint, "read", [])).toBe(false)
        expect(
          yield* PermissionOrigin.permits(
            {
              sessionID: SessionSchema.ID.make("ses_other"),
              action: "read",
              resources: ["src/index.ts"],
            },
            [constraint],
          ),
        ).toBe(false)
        const empty = yield* Restoration.restorePrompt(node(), target)
        expect(yield* permits(empty)).toBe(false)
      }),
  )

  it.effect(
    "rejects local, missing, removed, malformed and mismatched receipts before native verification",
    () =>
      Effect.gen(function* () {
        yield* record
        const { db } = yield* Database.Service
        let calls = 0
        const client = node(async () => {
          calls++
          return granted()
        })
        for (const value of [
          { ...target, messageID: SessionMessage.ID.make("msg_missing") },
          { ...target, sessionID: SessionSchema.ID.make("ses_other") },
          { ...target, origin: {} },
          { ...target, messageID: "invalid" },
        ])
          expect(
            yield* Restoration.restorePrompt(
              client,
              value as typeof target,
            ).pipe(Effect.flip),
          ).toBeInstanceOf(Restoration.RestorationError)
        const row = yield* db
          .select()
          .from(SessionInputOriginTable)
          .get()
          .pipe(Effect.orDie)
        for (const change of [
          { node_id: expected.id },
          { command_id: expected.id },
          { admitted_seq: row!.admitted_seq + 1 },
          { origin: { ...row!.origin, grantRevision: 0 } },
          { origin: { ...row!.origin, grantID: "invalid" } },
          { origin: { ...row!.origin, loginID: expected.id } },
          { origin: { ...row!.origin, nodeID: expected.id } },
          { origin: { ...row!.origin, platformWorkspaceID: expected.id } },
          { origin: { ...row!.origin, source: "local" } },
          { origin: { ...row!.origin, credential: "PRIVATE_SECRET" } },
          { origin: { ...row!.origin, expiresAt: 1 } },
        ]) {
          yield* db
            .update(SessionInputOriginTable)
            .set({ ...row!, ...change } as NonNullable<typeof row>)
            .where(eq(SessionInputOriginTable.id, target.messageID))
            .run()
            .pipe(Effect.orDie)
          expect(
            yield* Restoration.restorePrompt(client, target).pipe(Effect.flip),
          ).toBeInstanceOf(Restoration.RestorationError)
        }
        yield* db
          .update(SessionInputOriginTable)
          .set(row!)
          .where(eq(SessionInputOriginTable.id, target.messageID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(eq(SessionInputTable.id, target.messageID))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* Restoration.restorePrompt(client, target).pipe(Effect.flip),
        ).toBeInstanceOf(Restoration.RestorationError)
        expect(calls).toBe(0)
      }),
  )

  it.effect(
    "will not restore promoted, steer, changed or attachment-bearing inputs",
    () =>
      Effect.gen(function* () {
        yield* record
        const { db } = yield* Database.Service
        const row = yield* db
          .select()
          .from(SessionInputTable)
          .get()
          .pipe(Effect.orDie)
        for (const change of [
          { delivery: "steer" },
          { promoted_seq: 2 },
          { prompt: { text: "changed" } },
          { prompt: { ...row!.prompt, files: [] } },
          { prompt: { ...row!.prompt, agents: [] } },
          { prompt: { ...row!.prompt, model: "not-in-command" } },
        ]) {
          yield* db
            .update(SessionInputTable)
            .set({ ...row!, ...change } as NonNullable<typeof row>)
            .where(eq(SessionInputTable.id, target.messageID))
            .run()
            .pipe(Effect.orDie)
          expect(
            yield* Restoration.restorePrompt(
              node(async () => granted()),
              target,
            ).pipe(Effect.flip),
          ).toBeInstanceOf(Restoration.RestorationError)
        }
      }),
  )

  it.effect("rechecks the durable snapshot after an HTTP wait", () =>
    Effect.gen(function* () {
      yield* record
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionInputTable)
        .get()
        .pipe(Effect.orDie)
      for (const change of [
        { prompt: { text: "changed" } },
        { time_created: row!.time_created + 1 },
        { admitted_seq: row!.admitted_seq + 1 },
        { promoted_seq: 2 },
      ]) {
        yield* db
          .update(SessionInputTable)
          .set(row!)
          .where(eq(SessionInputTable.id, target.messageID))
          .run()
          .pipe(Effect.orDie)
        const client = node(async () => {
          await Effect.runPromise(
            db
              .update(SessionInputTable)
              .set(change)
              .where(eq(SessionInputTable.id, target.messageID))
              .run()
              .pipe(Effect.orDie),
          )
          return granted()
        })
        expect(
          yield* Restoration.restorePrompt(client, target).pipe(Effect.flip),
        ).toBeInstanceOf(Restoration.RestorationError)
      }
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
    }),
  )

  it.effect(
    "reverifies every permission boundary and never caches revocation, payload or widened rules",
    () =>
      Effect.gen(function* () {
        yield* record
        let current: ControlCommand.Proof | undefined = granted(),
          calls = 0
        const client = node(async () => {
          calls++
          if (!current) throw new Error("PRIVATE_TOKEN_AND_PROMPT")
          return current
        })
        const constraint = yield* Restoration.restorePrompt(client, target)
        const base = granted()
        for (const change of [
          undefined,
          { ...base, revision: 2 },
          { ...base, ownerUserId: expected.scope.granteeUserId },
          { ...base, nodeId: expected.id },
          { ...base, workspaceId: expected.id },
          { ...base, loginSessionId: expected.id },
          { ...base, actions: ["view"] },
          { ...base, scope: { ...base.scope, granteeUserId: identity.userId } },
          { ...base, attempt: { ...base.attempt, leaseId: expected.id } },
          { ...base, rules: [{ action: "*", resource: "*", effect: "allow" }] },
          { ...base, expiresAt: new Date(Date.now() - 1).toISOString() },
          {
            ...base,
            command: {
              ...base.command,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            },
          },
          { ...granted(), ...proof("changed"), rules: readOnly },
        ]) {
          current = change as ControlCommand.Proof | undefined
          expect(yield* permits(constraint)).toBe(false)
        }
        current = granted()
        expect(yield* permits(constraint)).toBe(true)
        expect(calls).toBe(15)
        current = undefined
        const error = yield* Restoration.restorePrompt(client, target).pipe(
          Effect.flip,
        )
        expect(error.message).not.toContain("PRIVATE_TOKEN")
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "invalidates a restored ceiling when the input or real target is changed or removed",
    () =>
      Effect.gen(function* () {
        yield* record
        const { db } = yield* Database.Service
        const constraint = yield* Restoration.restorePrompt(
          node(async () => granted()),
          target,
        )
        yield* db
          .update(SessionTable)
          .set({ directory: "/retargeted" })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* permits(constraint)).toBe(false)
        yield* db
          .update(SessionTable)
          .set({ directory: location.directory })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* permits(constraint)).toBe(true)
        yield* db
          .delete(SessionInputTable)
          .where(eq(SessionInputTable.id, target.messageID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* permits(constraint)).toBe(false)
        expect(
          yield* SessionInputOrigin.requireLocal(db, sessionID).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
      }),
  )

  it.effect("snapshots the target before awaiting a native proof", () =>
    Effect.gen(function* () {
      yield* record
      const started = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      const value = { ...target }
      const client = node(async () => {
        await Effect.runPromise(Deferred.succeed(started, undefined))
        await Effect.runPromise(Deferred.await(release))
        return granted()
      })
      const fiber = yield* Restoration.restorePrompt(client, value).pipe(
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      Object.assign(value, {
        sessionID: "ses_changed",
        messageID: "msg_changed",
      })
      yield* Deferred.succeed(release, undefined)
      const constraint = yield* Fiber.join(fiber)
      expect(constraint.sessionID).toBe(sessionID)
      expect(yield* constraint.valid).toBe(true)
      expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
    }),
  )

  it.effect(
    "aborting validity cancels its own reader without admitting or interrupting a session",
    () =>
      Effect.gen(function* () {
        yield* record
        const started = Deferred.makeUnsafe<void>(),
          release = Deferred.makeUnsafe<void>()
        let waiting = false,
          aborted = false
        const client = node(async (_, signal) => {
          if (waiting)
            await new Promise<void>((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true
                  reject(new Error("aborted"))
                },
                { once: true },
              )
              queueMicrotask(() => {
                void Effect.runPromise(Deferred.succeed(started, undefined))
              })
              Effect.runPromise(Deferred.await(release)).then(resolve, reject)
            })
          return granted()
        })
        const constraint = yield* Restoration.restorePrompt(client, target)
        waiting = true
        const fiber = yield* constraint.valid.pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
        expect(aborted).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  test("reopening SQLite restores fresh rights, not the previous fiber or closed database", async () => {
    await using tmp = await tmpdir()
    const persistent = () => {
      const database = Database.layerFromPath(
        path.join(tmp.path, "restoration.sqlite"),
      )
      const events = EventBus.layer.pipe(Layer.provide(database))
      return Layer.mergeAll(
        database,
        events,
        Layer.succeed(Location.Service, location),
        SessionProjector.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
        ),
      )
    }
    let reads = 0
    const client = node(async () => {
      reads++
      return granted()
    })
    const previous = await Effect.runPromise(
      record.pipe(
        Effect.andThen(Restoration.restorePrompt(client, target)),
        Effect.provide(persistent()),
        Effect.scoped,
      ),
    )
    expect(await Effect.runPromise(previous.valid)).toBe(false)
    await Effect.runPromise(
      Effect.gen(function* () {
        const restored = yield* Restoration.restorePrompt(client, target)
        expect(yield* permits(restored)).toBe(true)
        expect(reads).toBe(3)
        expect(yield* PermissionOrigin.capture).toEqual([])
        expect(
          yield* Restoration.restorePrompt(
            node(async () => {
              throw new Error("revoked")
            }),
            target,
          ).pipe(Effect.flip),
        ).toBeInstanceOf(Restoration.RestorationError)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }).pipe(Effect.provide(persistent()), Effect.scoped),
    )
  })
})

const permissions = testEffect(
  Layer.mergeAll(layer, permissionLayer(location.directory)),
)
permissions.effect(
  "restored grants still intersect local deny and cannot borrow saved edit permissions",
  () =>
    Effect.gen(function* () {
      yield* record
      yield* setupPermissions([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: "test" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* (yield* PermissionSaved.Service).add({
        projectID: ProjectRegistry.ID.global,
        action: "edit",
        resources: ["*"],
      })
      const permission = yield* PermissionPolicy.Service
      const constraint = yield* Restoration.restorePrompt(
        node(async () => granted()),
        target,
      )
      const input = { sessionID, action: "read", resources: ["src/index.ts"] }
      yield* PermissionOrigin.restrict(constraint, permission.assert(input))
      expect(
        yield* PermissionOrigin.restrict(
          constraint,
          permission.ask({ ...input, action: "edit" }),
        ),
      ).toMatchObject({ effect: "deny" })
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(
        yield* PermissionOrigin.restrict(constraint, permission.ask(input)),
      ).toMatchObject({ effect: "deny" })
    }),
)
