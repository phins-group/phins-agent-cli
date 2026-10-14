import { Location } from "../../src/workspace/location"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { AbsolutePath } from "../../src/shared/schema"
import { Effect, Layer } from "effect"
import { tmpdir } from "./tmpdir"

export function location(ref: Location.Ref, input: { projectDirectory?: AbsolutePath; vcs?: ProjectRegistry.Vcs } = {}) {
  return {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
    project: { id: ProjectRegistry.ID.global, directory: input.projectDirectory ?? ref.directory },
    vcs: input.vcs,
  } satisfies Location.Interface
}

export const tempLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)
