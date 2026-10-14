export * as Reference from "./registry"

import { Context, Effect, Layer, Scope, Types } from "effect"
import { Reference } from "../../contracts/agents/reference"
import { AppPaths } from "../../runtime/paths"
import { EventBus } from "../../runtime/events/bus"
import { Repository } from "../../workspace/repository/reference"
import { RepositoryCache } from "../../workspace/repository/cache"
import { AbsolutePath } from "../../shared/schema"
import { State } from "../../runtime/state"

export const LocalSource = Reference.LocalSource
export type LocalSource = Reference.LocalSource

export const GitSource = Reference.GitSource
export type GitSource = Reference.GitSource

export const Source = Reference.Source
export type Source = Reference.Source

export const Event = Reference.Event

export const Info = Reference.Info
export type Info = Reference.Info

type Data = {
  sources: Map<string, Types.DeepMutable<Source>>
}

type Draft = {
  add(name: string, source: Source): void
  remove(name: string): void
  list(): readonly [string, Source][]
}

export interface Interface extends State.Transformable<Draft> {
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/Reference") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* AppPaths.Service
    const events = yield* EventBus.Service
    const cache = yield* RepositoryCache.Service
    const scope = yield* Scope.Scope
    const materialized = new Map<string, Info>()
    const state = State.create<Data, Draft>({
      initial: () => ({ sources: new Map() }),
      draft: (draft) => ({
        add: (name, source) => draft.sources.set(name, source as Types.DeepMutable<Source>),
        remove: (name) => draft.sources.delete(name),
        list: () => Array.from(draft.sources.entries()) as [string, Source][],
      }),
      finalize: (draft) =>
        Effect.gen(function* () {
          materialized.clear()
          const seen = new Map<string, string | undefined>()
          for (const [name, source] of draft.list()) {
            if (source.type === "local") {
              materialized.set(
                name,
                new Info({
                  name,
                  path: source.path,
                  description: source.description,
                  hidden: source.hidden,
                  source,
                }),
              )
              continue
            }
            const repository = Repository.parse(source.repository)
            if (!repository || !Repository.isRemote(repository)) continue
            if (source.branch) {
              try {
                Repository.validateBranch(source.branch)
              } catch {
                continue
              }
            }
            const target = Repository.cachePath(global.repos, repository)
            if (seen.has(target) && seen.get(target) !== source.branch) continue
            seen.set(target, source.branch)
            materialized.set(
              name,
              new Info({
                name,
                path: AbsolutePath.make(target),
                description: source.description,
                hidden: source.hidden,
                source,
              }),
            )
            yield* cache.ensure({ reference: repository, branch: source.branch, refresh: true }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to materialize reference", {
                  name,
                  repository: source.repository,
                  cause,
                }),
              ),
              Effect.forkIn(scope),
            )
          }
          yield* events.publish(Event.Updated, {})
        }),
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: Effect.fn("Reference.list")(function* () {
        return Array.from(materialized.values())
      }),
    })
  }),
)

export const locationLayer = layer
