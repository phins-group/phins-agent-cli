import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "../contracts/workspace/location"
import { ProjectRegistry } from "./projects/service"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly scope?: "chat-v1"
  readonly vcs?: ProjectRegistry.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@phins/Location") {}

export const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* ProjectRegistry.Service
      const resolved =
        ref.scope === "chat-v1"
          ? (yield* Effect.promise(() => import("../sessions/run/chat-scope"))).project(
              ref.directory,
            )
          : yield* project.resolve(ref.directory)
      return Service.of({
        scope: ref.scope,
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
      })
    }),
  )
