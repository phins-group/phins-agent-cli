import { AgentRegistry } from "../../src/agents/registry"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import { LocationServiceRegistry } from "../../src/runtime/services"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { PermissionSaved } from "../../src/security/permissions/saved"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { ProjectTable } from "../../src/storage/tables/projects"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionExecution } from "../../src/sessions/run/execution"
import { SessionStore } from "../../src/sessions/store"
import { SessionTable } from "../../src/storage/tables/sessions"
import { Effect, Layer } from "effect"
import { location } from "./location"

export const sessionID = SessionManager.ID.make("ses_test")

export function permissionLayer(directory = "/project") {
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const sessions = SessionManager.layer.pipe(
    Layer.provide(LocationServiceRegistry.layer),
    Layer.provide(EventBus.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(SessionStore.defaultLayer),
    Layer.provide(ProjectRegistry.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  return PermissionPolicy.locationLayer.pipe(
    Layer.provideMerge(Database.defaultLayer),
    Layer.provideMerge(SessionStore.defaultLayer),
    Layer.provideMerge(EventBus.defaultLayer),
    Layer.provideMerge(current),
    Layer.provideMerge(sessions),
    Layer.provideMerge(SessionExecution.noopLayer),
    Layer.provideMerge(PermissionSaved.defaultLayer),
  )
}

export function setup(rules: PermissionPolicy.Ruleset = []) {
  return Effect.gen(function* () {
    const { directory } = yield* Location.Service
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectRegistry.ID.global,
        worktree: AbsolutePath.make(directory),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectRegistry.ID.global,
        slug: "test",
        directory,
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

export function setRules(rules: PermissionPolicy.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentRegistry.Service
    yield* agents.transform((editor) =>
      editor.update(AgentRegistry.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

export function assertion(input: Partial<PermissionPolicy.AssertInput> = {}) {
  return {
    id: PermissionPolicy.ID.create("per_test"),
    sessionID,
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionPolicy.AssertInput
}
