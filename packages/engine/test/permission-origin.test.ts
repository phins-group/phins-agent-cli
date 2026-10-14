import { describe, expect } from "bun:test"
import { AgentRegistry } from "../src/agents/registry"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { PermissionPolicy } from "../src/security/permissions/service"
import { PermissionOrigin } from "../src/security/permissions/origin"
import { PermissionSaved } from "../src/security/permissions/saved"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { SessionManager } from "../src/sessions/service"
import { SessionTable } from "../src/storage/tables/sessions"
import { eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import {
  assertion,
  permissionLayer,
  sessionID,
  setRules,
  setup,
} from "./fixture/permission"
import { testEffect } from "./lib/effect"

const it = testEffect(permissionLayer())
const allowAll: PermissionPolicy.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
]
const readOnly: PermissionOrigin.Constraint = {
  sessionID,
  rules: [{ action: "read", resource: "src/*", effect: "allow" }],
  valid: Effect.succeed(true),
}

const pending = (
  input: PermissionPolicy.AssertInput,
  origin?: PermissionOrigin.Constraint,
) =>
  Effect.gen(function* () {
    const permission = yield* PermissionPolicy.Service
    const asked = yield* Deferred.make<PermissionPolicy.Request>()
    const events = yield* EventBus.Service
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionPolicy.Event.Asked.type &&
      (event.data as PermissionPolicy.Request).id === input.id
        ? Deferred.succeed(asked, event.data as PermissionPolicy.Request).pipe(
            Effect.asVoid,
          )
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const work = permission.assert(input)
    const fiber = yield* (
      origin ? PermissionOrigin.restrict(origin, work) : work
    ).pipe(Effect.forkScoped)
    return { request: yield* Deferred.await(asked), fiber }
  })

describe("PermissionOrigin", () => {
  it.effect(
    "intersects remote grants with local and saved permissions without altering local calls",
    () =>
      Effect.gen(function* () {
        yield* setup(allowAll)
        const permission = yield* PermissionPolicy.Service
        const saved = yield* PermissionSaved.Service
        for (const action of [
          "edit",
          "bash",
          "process_session",
          "plugin_write",
          "mcp_write",
        ])
          yield* saved.add({
            projectID: ProjectRegistry.ID.global,
            action,
            resources: ["*"],
          })

        yield* PermissionOrigin.restrict(
          readOnly,
          Effect.gen(function* () {
            expect(yield* permission.ask(assertion())).toMatchObject({
              effect: "allow",
            })
            for (const action of [
              "edit",
              "bash",
              "process_session",
              "plugin_write",
              "mcp_write",
            ]) {
              const input = assertion({ action, resources: ["*"] })
              expect(yield* permission.ask(input)).toMatchObject({
                effect: "deny",
              })
              expect(
                yield* permission.assert(input).pipe(Effect.flip),
              ).toBeInstanceOf(PermissionPolicy.DeniedError)
            }
          }),
        )
        expect(yield* permission.list()).toEqual([])
        expect(
          yield* permission.ask(assertion({ action: "edit" })),
        ).toMatchObject({ effect: "allow" })
      }),
  )

  it.effect(
    "fails closed for missing, ask-only, empty and partially authorized resources",
    () =>
      Effect.gen(function* () {
        yield* setup(allowAll)
        const permission = yield* PermissionPolicy.Service
        for (const [origin, input] of [
          [{ ...readOnly, rules: [] }, assertion()],
          [
            {
              ...readOnly,
              rules: [
                { action: "read", resource: "*", effect: "ask" as const },
              ],
            },
            assertion(),
          ],
          [readOnly, assertion({ resources: [] })],
          [
            readOnly,
            assertion({ resources: ["src/index.ts", "secrets.json"] }),
          ],
        ] as const)
          expect(
            yield* PermissionOrigin.restrict(origin, permission.ask(input)),
          ).toMatchObject({ effect: "deny" })
        expect(yield* permission.list()).toEqual([])
      }),
  )

  it.effect(
    "preserves local deny precedence and the explicit provider-turn agent",
    () =>
      Effect.gen(function* () {
        yield* setup([{ action: "read", resource: "*", effect: "deny" }])
        const permission = yield* PermissionPolicy.Service
        yield* (yield* PermissionSaved.Service).add({
          projectID: ProjectRegistry.ID.global,
          action: "read",
          resources: ["*"],
        })
        expect(
          yield* PermissionOrigin.restrict(
            readOnly,
            permission.ask(assertion()),
          ),
        ).toMatchObject({ effect: "deny" })
        yield* setRules(allowAll)
        yield* (yield* AgentRegistry.Service).transform((editor) =>
          editor.update(AgentRegistry.ID.make("reviewer"), (agent) => {
            agent.permissions = [
              { action: "read", resource: "*", effect: "deny" },
            ]
          }),
        )
        expect(
          yield* PermissionOrigin.restrict(
            readOnly,
            permission.ask(assertion({ agent: AgentRegistry.ID.make("reviewer") })),
          ),
        ).toMatchObject({ effect: "deny" })
      }),
  )

  it.effect("keeps ordered grant rules and snapshots caller-owned rules", () =>
    Effect.gen(function* () {
      yield* setup(allowAll)
      const permission = yield* PermissionPolicy.Service
      const rules: PermissionPolicy.Ruleset = [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "src/*", effect: "allow" },
        { action: "read", resource: "src/private/*", effect: "deny" },
      ]
      const work = PermissionOrigin.restrict(
        { ...readOnly, rules },
        Effect.gen(function* () {
          expect(yield* permission.ask(assertion())).toMatchObject({
            effect: "allow",
          })
          expect(
            yield* permission.ask(
              assertion({ resources: ["src/private/key"] }),
            ),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask(assertion({ action: "edit" })),
          ).toMatchObject({ effect: "deny" })
        }),
      )
      Object.assign(rules[2]!, { effect: "allow" })
      rules.push(...allowAll)
      yield* work
    }),
  )

  it.effect("cannot widen a parent scope with a nested origin", () =>
    Effect.gen(function* () {
      yield* setup(allowAll)
      const permission = yield* PermissionPolicy.Service
      yield* PermissionOrigin.restrict(
        readOnly,
        PermissionOrigin.restrict(
          { ...readOnly, rules: allowAll },
          Effect.gen(function* () {
            expect(yield* permission.ask(assertion())).toMatchObject({
              effect: "allow",
            })
            expect(
              yield* permission.ask(assertion({ action: "edit" })),
            ).toMatchObject({ effect: "deny" })
          }),
        ),
      )
    }),
  )

  it.effect(
    "isolates concurrent local and restricted fibers and restores the parent",
    () =>
      Effect.gen(function* () {
        yield* setup(allowAll)
        const permission = yield* PermissionPolicy.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const remote = yield* PermissionOrigin.restrict(
          readOnly,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* permission.ask(assertion({ action: "edit" }))
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        expect(
          yield* permission.ask(assertion({ action: "edit" })),
        ).toMatchObject({ effect: "allow" })
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(remote)).toMatchObject({ effect: "deny" })
        expect(yield* PermissionOrigin.capture).toEqual([])
      }),
  )

  it.effect(
    "denies another session or a session placed outside this Location",
    () =>
      Effect.gen(function* () {
        yield* setup(allowAll)
        const permission = yield* PermissionPolicy.Service
        expect(
          yield* PermissionOrigin.restrict(
            { ...readOnly, sessionID: SessionManager.ID.make("ses_other") },
            permission.ask(assertion()),
          ),
        ).toMatchObject({ effect: "deny" })
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ directory: "/other-project" })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* PermissionOrigin.restrict(
            readOnly,
            permission.ask(assertion()),
          ),
        ).toMatchObject({ effect: "deny" })
      }),
  )

  it.effect(
    "checks live validity for every assertion including saved local approvals",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        yield* (yield* PermissionSaved.Service).add({
          projectID: ProjectRegistry.ID.global,
          action: "read",
          resources: ["*"],
        })
        let active = true
        let checks = 0
        const origin = {
          ...readOnly,
          valid: Effect.sync(() => {
            checks++
            return active
          }),
        }
        yield* PermissionOrigin.restrict(
          origin,
          Effect.gen(function* () {
            yield* permission.assert(assertion())
            active = false
            expect(
              yield* permission.assert(assertion()).pipe(Effect.flip),
            ).toBeInstanceOf(PermissionPolicy.DeniedError)
          }),
        )
        expect(checks).toBe(2)
      }),
  )

  it.effect(
    "refuses remote always without changing pending state or saved rules",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const { request, fiber } = yield* pending(
          assertion({ save: ["*"] }),
          readOnly,
        )
        expect(
          yield* permission
            .reply({ requestID: request.id, reply: "always" })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PermissionV2.ReplyForbiddenError",
          message:
            "Remote permissions cannot be remembered; approve this request only once",
        })
        expect(yield* permission.list()).toEqual([request])
        expect(yield* (yield* PermissionSaved.Service).list()).toEqual([])
        yield* permission.reply({ requestID: request.id, reply: "once" })
        yield* Fiber.join(fiber)
        expect(yield* permission.list()).toEqual([])
        expect(yield* (yield* PermissionSaved.Service).list()).toEqual([])
      }),
  )

  it.effect(
    "does not resolve remote pending requests through a local always reply",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const remote = yield* pending(
          assertion({
            id: PermissionPolicy.ID.create("per_remote"),
            save: ["src/*"],
          }),
          readOnly,
        )
        const local = yield* pending(
          assertion({
            id: PermissionPolicy.ID.create("per_local"),
            save: ["src/*"],
          }),
        )
        yield* permission.reply({
          requestID: local.request.id,
          reply: "always",
        })
        yield* Fiber.join(local.fiber)
        expect(yield* permission.list()).toEqual([remote.request])
        yield* permission.reply({ requestID: remote.request.id, reply: "once" })
        yield* Fiber.join(remote.fiber)
        expect(yield* permission.list()).toEqual([])
      }),
  )

  it.effect(
    "keeps rejection decisions separate between local and remote requests",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const remote = yield* pending(
          assertion({ id: PermissionPolicy.ID.create("per_remote") }),
          readOnly,
        )
        const local = yield* pending(
          assertion({ id: PermissionPolicy.ID.create("per_local") }),
        )
        yield* permission.reply({
          requestID: local.request.id,
          reply: "reject",
        })
        expect(yield* Fiber.join(local.fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.RejectedError,
        )
        expect(yield* permission.list()).toEqual([remote.request])
        yield* permission.reply({
          requestID: remote.request.id,
          reply: "reject",
          message: "Do not proceed",
        })
        expect(yield* Fiber.join(remote.fiber).pipe(Effect.flip)).toMatchObject(
          { _tag: "PermissionV2.CorrectedError", feedback: "Do not proceed" },
        )
      }),
  )

  it.effect(
    "refuses an expired or revoked approval while allowing explicit rejection",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        let active = true
        const { request, fiber } = yield* pending(assertion(), {
          ...readOnly,
          valid: Effect.sync(() => active),
        })
        active = false
        expect(
          yield* permission
            .reply({ requestID: request.id, reply: "once" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(PermissionPolicy.ReplyForbiddenError)
        expect(yield* permission.get(request.id)).toEqual(request)
        yield* permission.reply({ requestID: request.id, reply: "reject" })
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.RejectedError,
        )
      }),
  )

  it.effect(
    "owns one remote reply while validity is checked asynchronously",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let checks = 0
        const { request, fiber } = yield* pending(assertion(), {
          ...readOnly,
          valid: Effect.gen(function* () {
            if (++checks === 2) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return true
          }),
        })
        const replied: PermissionPolicy.Reply[] = []
        const unsubscribe = yield* (yield* EventBus.Service).listen((event) =>
          event.type === PermissionPolicy.Event.Replied.type
            ? Effect.sync(() => {
                replied.push(
                  (event.data as { reply: PermissionPolicy.Reply }).reply,
                )
              })
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const first = yield* permission
          .reply({ requestID: request.id, reply: "once" })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        expect(
          yield* permission
            .reply({ requestID: request.id, reply: "reject" })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PermissionV2.ReplyForbiddenError",
          message: "Another reply is already in progress for this request",
        })
        expect(yield* permission.list()).toEqual([request])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(fiber)
        expect(replied).toEqual(["once"])
        expect(
          yield* permission
            .reply({ requestID: request.id, reply: "once" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(PermissionPolicy.NotFoundError)
      }),
  )

  it.effect("does not reject local work when rejecting a remote request", () =>
    Effect.gen(function* () {
      yield* setup()
      const permission = yield* PermissionPolicy.Service
      const remote = yield* pending(
        assertion({ id: PermissionPolicy.ID.create("per_remote") }),
        readOnly,
      )
      const local = yield* pending(
        assertion({ id: PermissionPolicy.ID.create("per_local") }),
      )
      yield* permission.reply({ requestID: remote.request.id, reply: "reject" })
      expect(yield* Fiber.join(remote.fiber).pipe(Effect.flip)).toBeInstanceOf(
        PermissionPolicy.RejectedError,
      )
      expect(yield* permission.list()).toEqual([local.request])
      yield* permission.reply({ requestID: local.request.id, reply: "once" })
      yield* Fiber.join(local.fiber)
    }),
  )

  it.effect(
    "checks local deny again when approving a remote pending request",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const { request, fiber } = yield* pending(assertion(), readOnly)
        yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
        expect(
          yield* permission
            .reply({ requestID: request.id, reply: "once" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(PermissionPolicy.ReplyForbiddenError)
        yield* permission.reply({ requestID: request.id, reply: "reject" })
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.RejectedError,
        )
      }),
  )

  it.effect(
    "rechecks the ceiling after the approval event and before returning to the tool",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        let active = true
        const { request, fiber } = yield* pending(assertion(), {
          ...readOnly,
          valid: Effect.sync(() => active),
        })
        const unsubscribe = yield* (yield* EventBus.Service).listen((event) =>
          event.type === PermissionPolicy.Event.Replied.type
            ? Effect.sync(() => {
                active = false
              })
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* permission.reply({ requestID: request.id, reply: "once" })
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.DeniedError,
        )
        expect(yield* permission.list()).toEqual([])
      }),
  )

  it.effect("preserves interruption and defects from the validity gate", () =>
    Effect.gen(function* () {
      yield* setup(allowAll)
      const permission = yield* PermissionPolicy.Service
      const defect = yield* PermissionOrigin.restrict(
        { ...readOnly, valid: Effect.die("invalid authority") },
        permission.assert(assertion()),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(defect) && Cause.squash(defect.cause)).toBe(
        "invalid authority",
      )
      const interrupted = yield* PermissionOrigin.restrict(
        { ...readOnly, valid: Effect.interrupt },
        permission.assert(assertion()),
      ).pipe(Effect.exit)
      expect(
        Exit.isFailure(interrupted) &&
          Cause.hasInterruptsOnly(interrupted.cause),
      ).toBe(true)
    }),
  )

  it.effect(
    "can interrupt an assertion waiting on origin validity without creating pending state",
    () =>
      Effect.gen(function* () {
        yield* setup(allowAll)
        const permission = yield* PermissionPolicy.Service
        const entered = yield* Deferred.make<void>()
        const fiber = yield* PermissionOrigin.restrict(
          {
            ...readOnly,
            valid: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          },
          permission.assert(assertion()),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true)
        expect(yield* permission.list()).toEqual([])
      }),
  )

  it.effect(
    "releases an interrupted reply's ownership without approving or dropping the request",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const entered = yield* Deferred.make<void>()
        let checks = 0
        const { request, fiber } = yield* pending(assertion(), {
          ...readOnly,
          valid: Effect.gen(function* () {
            if (++checks === 2) {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }
            return true
          }),
        })
        const reply = yield* permission
          .reply({ requestID: request.id, reply: "once" })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(reply)
        expect(yield* permission.list()).toEqual([request])
        yield* permission.reply({ requestID: request.id, reply: "reject" })
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.RejectedError,
        )
      }),
  )

  it.effect(
    "does not publish an approval after its waiting assertion was interrupted",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let checks = 0
        const { request, fiber } = yield* pending(assertion(), {
          ...readOnly,
          valid: Effect.gen(function* () {
            if (++checks === 2) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return true
          }),
        })
        const replies: unknown[] = []
        const unsubscribe = yield* (yield* EventBus.Service).listen((event) =>
          event.type === PermissionPolicy.Event.Replied.type
            ? Effect.sync(() => {
                replies.push(event.data)
              })
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const reply = yield* permission
          .reply({ requestID: request.id, reply: "once" })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(reply).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.NotFoundError,
        )
        expect(replies).toEqual([])
        expect(yield* permission.list()).toEqual([])
      }),
  )

  it.effect(
    "checks a local deny introduced while the remote approval event is published",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const permission = yield* PermissionPolicy.Service
        const { request, fiber } = yield* pending(assertion(), readOnly)
        const deny = setRules([
          { action: "read", resource: "*", effect: "deny" },
        ]).pipe(
          Effect.provideService(AgentRegistry.Service, yield* AgentRegistry.Service),
          Scope.provide(yield* Scope.Scope),
        )
        const unsubscribe = yield* (yield* EventBus.Service).listen((event) =>
          event.type === PermissionPolicy.Event.Replied.type ? deny : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* permission.reply({ requestID: request.id, reply: "once" })
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
          PermissionPolicy.DeniedError,
        )
        expect(yield* permission.list()).toEqual([])
      }),
  )
})
