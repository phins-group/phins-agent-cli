import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentRegistry } from "../src/agents/registry"
import { Location } from "../src/workspace/location"
import { PermissionPolicy } from "../src/security/permissions/service"
import { AgentPlugin } from "../src/extensions/agents"
import { AbsolutePath } from "../src/shared/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AgentRegistry.locationLayer)

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentRegistry.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      const id = AgentRegistry.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      const id = AgentRegistry.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      const id = AgentRegistry.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      const id = AgentRegistry.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      const id = AgentRegistry.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentRegistry.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies the effective built-in Bash policy", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRegistry.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "summary",
        "title",
      ])
      const effects = Object.fromEntries(
        agents.map((item) => [
          item.id,
          PermissionPolicy.evaluate("bash", "cat /outside/secret", item.permissions).effect,
        ]),
      )
      expect(effects).toEqual({
        build: "ask",
        compaction: "deny",
        explore: "deny",
        general: "ask",
        plan: "deny",
        summary: "deny",
        title: "deny",
      })
      for (const action of ["formatter"])
        expect(Object.fromEntries(agents.map((item) => [
          item.id, PermissionPolicy.evaluate(action, "configured-command", item.permissions).effect,
        ]))).toEqual(effects)

      const build = agents.find((item) => item.id === "build")
      expect(build?.permissions).toContainEqual({ action: "*", resource: "*", effect: "allow" })
      expect(PermissionPolicy.evaluate("bash", "pwd", build?.permissions ?? []).effect).toBe("ask")
      expect(PermissionPolicy.evaluate("doom_loop", "echo", build?.permissions ?? []).effect).toBe("ask")
    }),
  )
})
