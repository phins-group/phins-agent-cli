import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AgentRegistry } from "../src/agents/registry"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { PermissionPolicy } from "../src/security/permissions/service"
import { PermissionTable } from "../src/storage/tables/permissions"
import { PermissionSaved } from "../src/security/permissions/saved"
import * as Delegation from "../src/security/permissions/delegation"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AgentPlugin } from "../src/extensions/agents"
import { SessionManager } from "../src/sessions/service"
import { SessionTable } from "../src/storage/tables/sessions"
import { eq } from "drizzle-orm"
import { assertion, permissionLayer, setRules, setup } from "./fixture/permission"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(permissionLayer())

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionPolicy.Service
    const events = yield* EventBus.Service
    const asked = yield* Deferred.make<PermissionPolicy.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionPolicy.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionPolicy.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  for (const action of ["formatter"] as const)
    it.effect(`default ${action} command waits for real approval despite allowed file read/edit`, () =>
      Effect.gen(function* () {
        yield* setup()
        const agents = yield* AgentRegistry.Service
        yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
        const service = yield* PermissionPolicy.Service
        const events = yield* EventBus.Service
        const input = { agent: AgentRegistry.ID.make("build"), resources: ["file.ts"] }
        for (const fileAction of ["read", "edit"])
          yield* service.assert(assertion({ ...input, action: fileAction }))
        let commands = 0
        for (const reply of ["reject", "once"] as const) {
          const asked = yield* Deferred.make<PermissionPolicy.Request>()
          const unsubscribe = yield* events.listen((event) =>
            event.type === PermissionPolicy.Event.Asked.type
              ? Deferred.succeed(asked, event.data as PermissionPolicy.Request).pipe(Effect.asVoid)
              : Effect.void)
          const fiber = yield* service.assert(assertion({
            agent: input.agent, action, resources: ["configured-command"],
            id: PermissionPolicy.ID.create(),
          })).pipe(Effect.andThen(Effect.sync(() => { commands++ })), Effect.forkScoped)
          const request = yield* Deferred.await(asked)
          expect(request.action).toBe(action)
          expect(commands).toBe(0)
          yield* service.reply({ requestID: request.id, reply })
          expect((yield* Fiber.await(fiber))._tag).toBe(reply === "reject" ? "Failure" : "Success")
          yield* unsubscribe
        }
        expect(commands).toBe(1)
        expect(yield* service.list()).toEqual([])
      }),
    )
  it.effect("foreground permission asks cannot persist or outlive their parent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      let valid = true
      const input = assertion()
      const service = yield* PermissionPolicy.Service
      const fiber = yield* Delegation.restrict({ sessionID: input.sessionID,
        rules: [{ action: "read", resource: "*", effect: "ask" }],
        valid: Effect.sync(() => valid),
      }, service.assert(input)).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const [request] = yield* service.list()
      expect(request).toBeDefined()
      if (!request) return yield* Effect.die("Missing child permission request")
      expect((yield* service.reply({ requestID: request.id, reply: "always" }).pipe(Effect.exit))._tag).toBe("Failure")
      valid = false
      expect((yield* service.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit))._tag).toBe("Failure")
      yield* service.reply({ requestID: request.id, reply: "reject" })
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }),
  )
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionPolicy.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionPolicy.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentRegistry.Service
      yield* agents.transform((editor) =>
        editor.update(AgentRegistry.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionPolicy.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentRegistry.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentRegistry.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentRegistry.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionPolicy.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionPolicy.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionPolicy.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionPolicy.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionManager.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentRegistry.Service
      yield* agents.transform((editor) =>
        editor.update(AgentRegistry.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionPolicy.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionPolicy.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionManager.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentRegistry.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentRegistry.ID.make("test"))
        editor.remove(AgentRegistry.ID.make("build"))
      })

      const service = yield* PermissionPolicy.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionPolicy.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionPolicy.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionPolicy.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: ProjectRegistry.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionPolicy.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionPolicy.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionPolicy.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionManager.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionPolicy.Service
      const asked = yield* Deferred.make<PermissionPolicy.Request>()
      const events = yield* EventBus.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionPolicy.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionPolicy.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ProjectRegistry.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: ProjectRegistry.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionPolicy.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
