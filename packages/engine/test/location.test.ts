import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Location } from "../src/workspace/location"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { Workspace as WorkspaceIdentity } from "../src/contracts/workspace/workspace"
import { testEffect } from "./lib/effect"

const workspaceID = WorkspaceIdentity.ID.make("wrk_test")
const ref = { directory: AbsolutePath.make("/repo/packages/app"), workspaceID }
const projectLayer = Layer.succeed(
  ProjectRegistry.Service,
  ProjectRegistry.Service.of({
    directories: () => Effect.succeed([]),
    resolve: () =>
      Effect.succeed({
        id: ProjectRegistry.ID.make("project"),
        directory: AbsolutePath.make("/repo"),
        vcs: { type: "git", store: AbsolutePath.make("/repo/.git") },
      }),
    commit: () => Effect.void,
  }),
)
const it = testEffect(Location.layer(ref).pipe(Layer.provide(projectLayer)))

describe("Location", () => {
  it.effect("resolves the current project and vcs information", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service

      expect(location.directory).toBe(AbsolutePath.make("/repo/packages/app"))
      expect(location.workspaceID).toBe(workspaceID)
      expect(location.project.id).toBe(ProjectRegistry.ID.make("project"))
      expect(location.project.directory).toBe(AbsolutePath.make("/repo"))
      expect(location.vcs).toEqual({
        type: "git",
        store: AbsolutePath.make("/repo/.git"),
      })
    }),
  )
})
