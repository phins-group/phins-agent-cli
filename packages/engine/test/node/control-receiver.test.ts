import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "node:path"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import * as ControlCommand from "../../src/execution/control/command"
import * as Receiver from "../../src/execution/control/receiver"
import { PermissionOrigin } from "../../src/security/permissions/origin"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionInputOrigin } from "../../src/sessions/input/origin"
import { SessionProjector } from "../../src/sessions/projector"
import { SessionTable } from "../../src/storage/tables/sessions"
import { Workspace as WorkspaceIdentity } from "../../src/contracts/workspace/workspace"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"
import {
  counts,
  deadline,
  expected,
  identity,
  layer,
  location,
  node,
  proof,
  sessionID,
  setup,
} from "../fixture/node-control"

const it = testEffect(layer)

describe("authenticated record-only prompt receiver", () => {
  it.effect(
    "records the queue text and grantee identity without promotion or permission scope",
    () =>
      Effect.gen(function* () {
        yield* setup
        const result = yield* Receiver.receivePrompt(node(), expected)
        expect(result).toMatchObject({
          id: `msg_node_${expected.attempt.id}`,
          sessionID,
          prompt: { text: proof().command.payload.text },
          delivery: "queue",
          origin: {
            commandID: expected.attempt.id,
            userID: expected.scope.granteeUserId,
            nodeID: identity.nodeId,
            platformWorkspaceID: identity.workspaceId,
            loginID: identity.sessionId,
            grantID: expected.id,
            grantRevision: 1,
            attemptID: expected.attempt.leaseId,
          },
        })
        expect(result.origin?.userID).not.toBe(identity.userId)
        expect(DateTime.toEpochMillis(result.origin!.expiresAt)).toBe(
          Date.parse(deadline),
        )
        expect(result.promotedSeq).toBeUndefined()
        expect(result.origin?.location.workspaceID).toBeUndefined()
        expect(yield* PermissionOrigin.capture).toEqual([])
        expect(
          yield* SessionInputOrigin.requireLocal(
            (yield* Database.Service).db,
            sessionID,
          ).pipe(Effect.flip),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "exact concurrent retries reverify and retain one stable command expiry and input",
    () =>
      Effect.gen(function* () {
        yield* setup
        let reads = 0
        const client = node(async () => {
          reads++
          return {
            ...proof(),
            expiresAt: new Date(Date.now() + reads * 1000).toISOString(),
          }
        })
        const results = yield* Effect.all(
          [
            Receiver.receivePrompt(client, expected),
            Receiver.receivePrompt(client, expected),
          ],
          { concurrency: "unbounded" },
        )
        expect(results[0]).toEqual(results[1])
        expect(reads).toBe(2)
        expect(yield* Receiver.receivePrompt(client, expected)).toEqual(
          results[0],
        )
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  it.effect(
    "rejects nonexistent or mismatched local targets and Location before HTTP",
    () =>
      Effect.gen(function* () {
        yield* setup
        let calls = 0
        const client = node(async () => {
          calls++
          return proof()
        })
        for (const scope of [
          { ...expected.scope, targetSessionId: "ses_missing" },
          { ...expected.scope, targetSessionId: "opaque_invalid" },
          { ...expected.scope, projectId: "other" },
          { ...expected.scope, directory: "/elsewhere" },
          { ...expected.scope, syncWorkspaceId: "wrk_other" },
        ])
          expect(
            yield* Receiver.receivePrompt(client, { ...expected, scope }).pipe(
              Effect.flip,
            ),
          ).toBeInstanceOf(Receiver.ReceiverError)
        expect(
          yield* Receiver.receivePrompt(client, expected).pipe(
            Effect.provideService(Location.Service, {
              ...location,
              workspaceID: WorkspaceIdentity.ID.make("wrk_other"),
            }),
            Effect.flip,
          ),
        ).toBeInstanceOf(Receiver.ReceiverError)
        expect(calls).toBe(0)
        expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
      }),
  )

  it.effect(
    "checks each authenticated proof binding and redacts verification failures",
    () =>
      Effect.gen(function* () {
        yield* setup
        const base = proof()
        for (const change of [
          { id: identity.nodeId },
          { revision: 2 },
          { nodeId: expected.id },
          { ownerUserId: expected.scope.granteeUserId },
          { workspaceId: expected.id },
          { loginSessionId: expected.id },
          { actions: ["view"] },
          { scope: { ...expected.scope, granteeUserId: identity.userId } },
          { attempt: { ...expected.attempt, leaseId: expected.id } },
          { command: { ...base.command, payloadHash: "0".repeat(64) } },
          { expiresAt: new Date(Date.now() - 1).toISOString() },
          { authority: true },
        ])
          expect(
            yield* Receiver.receivePrompt(
              node(
                async () => ({ ...base, ...change }) as ControlCommand.Proof,
              ),
              expected,
            ).pipe(Effect.flip),
          ).toBeInstanceOf(Receiver.ReceiverError)
        const error = yield* Receiver.receivePrompt(
          node(async () => {
            throw new Error("PRIVATE_TOKEN_AND_PROMPT")
          }),
          expected,
        ).pipe(Effect.flip)
        expect(error.message).not.toContain("PRIVATE_TOKEN")
        expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
      }),
  )

  it.effect(
    "rechecks the local session after an HTTP wait without changing the requested target",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const client = node(async () => {
          await Effect.runPromise(
            db
              .update(SessionTable)
              .set({ directory: "/retargeted" })
              .where(eq(SessionTable.id, sessionID))
              .run()
              .pipe(Effect.orDie),
          )
          return proof()
        })
        expect(
          yield* Receiver.receivePrompt(client, expected).pipe(Effect.flip),
        ).toBeInstanceOf(Receiver.ReceiverError)
        expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
      }),
  )

  it.effect(
    "snapshots expectations before await and cancels only the verification request",
    () =>
      Effect.gen(function* () {
        yield* setup
        const started = Deferred.makeUnsafe<void>(),
          release = Deferred.makeUnsafe<void>()
        const value = structuredClone(expected)
        let supplied: ControlCommand.Expected | undefined,
          aborted = false
        const client = node(async (input, signal) => {
          supplied = input
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                reject(new Error("aborted"))
              },
              { once: true },
            )
            // Mark the wait after Effect has installed its async finalizer.
            queueMicrotask(() => {
              void Effect.runPromise(Deferred.succeed(started, undefined))
            })
            Effect.runPromise(Deferred.await(release)).then(resolve, reject)
          })
          return proof()
        })
        const fiber = yield* Receiver.receivePrompt(client, value).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        Object.assign(value.scope, { targetSessionId: "ses_swapped" })
        expect(supplied?.scope.targetSessionId).toBe(sessionID)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        expect(aborted).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(yield* counts).toEqual({ inputs: 0, origins: 0, events: 0 })
      }),
  )

  it.effect(
    "a command replay with another payload still conflicts at the durable receipt",
    () =>
      Effect.gen(function* () {
        yield* setup
        yield* Receiver.receivePrompt(node(), expected)
        const exit = yield* Receiver.receivePrompt(
          node(async () => proof("changed")),
          expected,
        ).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure")
          expect(
            exit.cause.reasons.some(
              (reason) =>
                Cause.isDieReason(reason) &&
                reason.defect instanceof SessionInput.InputLifecycleConflict,
            ),
          ).toBe(true)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }),
  )

  test("reopening SQLite requires a fresh command check and keeps the execution fence", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "receiver.sqlite")
    const persistent = () => {
      const database = Database.layerFromPath(filename)
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
      return proof()
    })
    const recorded = await Effect.runPromise(
      setup.pipe(
        Effect.andThen(Receiver.receivePrompt(client, expected)),
        Effect.provide(persistent()),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Receiver.receivePrompt(client, expected)).toEqual(
          recorded,
        )
        expect(reads).toBe(2)
        expect(
          yield* Receiver.receivePrompt(
            node(async () => {
              throw new Error("revoked")
            }),
            expected,
          ).pipe(Effect.flip),
        ).toBeInstanceOf(Receiver.ReceiverError)
        expect(
          yield* SessionInputOrigin.requireLocal(
            (yield* Database.Service).db,
            sessionID,
          ).pipe(Effect.flip),
        ).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        expect(yield* counts).toEqual({ inputs: 1, origins: 1, events: 1 })
      }).pipe(Effect.provide(persistent()), Effect.scoped),
    )
  })
})
