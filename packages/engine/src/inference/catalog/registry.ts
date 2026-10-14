export * as Catalog from "./registry"

import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  pipe,
  Schema,
} from "effect"
import { Catalog } from "../../contracts/inference/catalog"
import { CatalogModel } from "./model"
import { CatalogProvider } from "./provider"
import { EventBus } from "../../runtime/events/bus"
import { Policy } from "../../security/policy"
import { State } from "../../runtime/state"
import { Integration } from "../../extensions/integrations/service"
import { AppPaths } from "../../runtime/paths"
import { createModelCatalog, mergeDiscoveredModel, supportsModelDiscovery } from "./discovery"
import { Credential } from "../../security/credentials"
import path from "node:path"

export type ProviderRecord = {
  provider: CatalogProvider.MutableInfo
  models: Map<CatalogModel.ID, CatalogModel.MutableInfo>
}

export type DefaultModel = { providerID: CatalogProvider.ID; modelID: CatalogModel.ID }

export const PolicyActions = Schema.Literals(["provider.use"])

export const Event = Catalog.Event

type Data = {
  providers: Map<CatalogProvider.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: CatalogProvider.ID) => ProviderRecord | undefined
    update: (
      providerID: CatalogProvider.ID,
      fn: (provider: CatalogProvider.MutableInfo) => void,
    ) => void
    remove: (providerID: CatalogProvider.ID) => void
  }
  model: {
    get: (
      providerID: CatalogProvider.ID,
      modelID: CatalogModel.ID,
    ) => CatalogModel.Info | undefined
    update: (
      providerID: CatalogProvider.ID,
      modelID: CatalogModel.ID,
      fn: (model: CatalogModel.MutableInfo) => void,
    ) => void
    remove: (providerID: CatalogProvider.ID, modelID: CatalogModel.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: CatalogProvider.ID, modelID: CatalogModel.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (
      providerID: CatalogProvider.ID,
    ) => Effect.Effect<CatalogProvider.Info | undefined>
    readonly all: () => Effect.Effect<CatalogProvider.Info[]>
    readonly available: () => Effect.Effect<CatalogProvider.Info[]>
  }
  readonly model: {
    readonly refresh: (providerID: CatalogProvider.ID) => Effect.Effect<void, Error>
    readonly get: (
      providerID: CatalogProvider.ID,
      modelID: CatalogModel.ID,
    ) => Effect.Effect<CatalogModel.Info | undefined>
    readonly all: () => Effect.Effect<CatalogModel.Info[]>
    readonly available: () => Effect.Effect<CatalogModel.Info[]>
    readonly default: () => Effect.Effect<CatalogModel.Info | undefined>
    readonly small: (
      providerID: CatalogProvider.ID,
    ) => Effect.Effect<CatalogModel.Info | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/Catalog",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventBus.Service
    const policy = yield* Policy.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const remoteModels = createModelCatalog(path.join(AppPaths.directories.cache, "provider-models"))
    const providerKey = Effect.fn(function* (provider: CatalogProvider.Info) {
      if (typeof provider.request.body.apiKey === "string") return provider.request.body.apiKey
      const connection = yield* integrations.connection.active(provider.integrationID ?? Integration.ID.make(provider.id))
      if (connection?.type === "env") return process.env[connection.name]
      const credential = connection && (yield* credentials.get(connection.id))?.value
      return credential?.type === "key" ? credential.key : undefined
    })
    const modelsFor = Effect.fn(function* (record: ProviderRecord) {
      if (!supportsModelDiscovery(record.provider)) return new Map<CatalogModel.ID, CatalogModel.Info>(record.models)
      const key = yield* providerKey(record.provider)
      const discovered = yield* Effect.promise(() => remoteModels.load(record.provider, key))
      const models = new Map<CatalogModel.ID, CatalogModel.Info>(record.models)
      for (const item of discovered) {
        const modelID = CatalogModel.ID.make(item.id)
        const model = models.get(modelID) ?? CatalogModel.Info.empty(record.provider.id, modelID)
        models.set(modelID, mergeDiscoveredModel(model, item))
      }
      return models
    })

    const available = (
      provider: CatalogProvider.Info,
      integration: Integration.Info | undefined,
    ) => {
      if (provider.disabled) return false
      if (typeof provider.request.body.apiKey === "string") return true
      if (typeof provider.api.settings?.nodeProfileProvider === "string")
        return true
      if (integration?.connections.length) return true
      return provider.integrationID === undefined && !integration
    }

    const projectModel = (model: CatalogModel.Info, provider: CatalogProvider.Info) => {
      const api =
        model.api.type === "native" &&
        !model.api.url &&
        Object.keys(model.api.settings).length === 0
          ? { ...provider.api, id: model.api.id }
          : model.api.type === "aisdk" &&
              provider.api.type === "aisdk" &&
              !model.api.url
            ? {
                ...model.api,
                url: provider.api.url,
                settings: { ...provider.api.settings, ...model.api.settings },
              }
            : model.api.type === "aisdk" && provider.api.type === "aisdk"
              ? {
                  ...model.api,
                  settings: { ...provider.api.settings, ...model.api.settings },
                }
              : model.api
      const request = {
        headers: { ...provider.request.headers, ...model.request.headers },
        body: { ...provider.request.body, ...model.request.body },
        variant: model.request.variant,
      }
      return CatalogModel.Info.make({
        ...model,
        api,
        request,
      })
    }

    const normalizeApi = (
      item: CatalogProvider.MutableInfo | CatalogModel.MutableInfo,
    ) => {
      if (typeof item.request.body.baseURL !== "string") return
      item.api.url = item.request.body.baseURL
      delete item.request.body.baseURL
    }

    const state = State.create<Data, Draft>({
      initial: () => ({ providers: new Map() }),
      draft: (draft) => {
        const result: Draft = {
          provider: {
            list: () =>
              Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = {
                  provider: CatalogProvider.Info.empty(
                    providerID,
                  ) as CatalogProvider.MutableInfo,
                  models: new Map<CatalogModel.ID, CatalogModel.MutableInfo>(),
                }
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
              normalizeApi(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) =>
              draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = {
                  provider: CatalogProvider.Info.empty(
                    providerID,
                  ) as CatalogProvider.MutableInfo,
                  models: new Map<CatalogModel.ID, CatalogModel.MutableInfo>(),
                }
                draft.providers.set(providerID, record)
              }
              const model =
                record.models.get(modelID) ??
                (CatalogModel.Info.empty(providerID, modelID) as CatalogModel.MutableInfo)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
              normalizeApi(model)
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("CatalogV2.finalize")(function* (catalog) {
        if (policy.hasStatements()) {
          for (const record of [...catalog.provider.list()]) {
            if (
              (yield* policy.evaluate(
                "provider.use",
                record.provider.id,
                "allow",
              )) === "deny"
            ) {
              catalog.provider.remove(record.provider.id)
            }
          }
        }
        yield* events.publish(Event.Updated, {})
      }),
    })
    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("CatalogV2.provider.get")(function* (providerID) {
          return state.get().providers.get(providerID)?.provider
        }),

        all: Effect.fn("CatalogV2.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map(
            (record) => record.provider,
          )
        }),

        available: Effect.fn("CatalogV2.provider.available")(function* () {
          const active = new Map(
            (yield* integrations.list()).map((integration) => [
              integration.id,
              integration,
            ]),
          )
          return (yield* result.provider.all()).filter((provider) =>
            available(
              provider,
              active.get(
                provider.integrationID ?? Integration.ID.make(provider.id),
              ),
            ),
          )
        }),
      },

      model: {
        refresh: Effect.fn("CatalogV2.model.refresh")(function* (providerID) {
          const provider = (yield* result.provider.available()).find((item) => item.id === providerID)
          if (!provider) return yield* Effect.fail(new Error("Provider is not connected or enabled."))
          if (!supportsModelDiscovery(provider)) return
          const key = yield* providerKey(provider)
          yield* Effect.tryPromise({
            try: (signal) => remoteModels.refresh(provider, key, signal),
            catch: () => new Error("Could not load provider models. Check the API key and connection."),
          })
          yield* events.publish(Event.Updated, {})
        }),
        get: Effect.fn("CatalogV2.model.get")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const model = record.models.get(modelID) ?? (yield* modelsFor(record)).get(modelID)
          return model && projectModel(model, record.provider)
        }),

        all: Effect.fn("CatalogV2.model.all")(function* () {
          const models = yield* Effect.forEach(
            Array.fromIterable(state.get().providers.values()),
            Effect.fn(function* (record) {
              return Array.fromIterable((yield* modelsFor(record)).values())
                .map((model) => projectModel(model, record.provider))
            }),
          )
          return pipe(
            Array.flatten(models),
            Array.sortWith(
              (item) => item.time.released,
              Order.flip(Order.Number),
            ),
          )
        }),

        available: Effect.fn("CatalogV2.model.available")(function* () {
          const providers = new Set(
            (yield* result.provider.available()).map((provider) => provider.id),
          )
          return (yield* result.model.all()).filter(
            (model) => providers.has(model.providerID) && model.enabled,
          )
        }),

        default: Effect.fn("CatalogV2.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (
              provider &&
              (yield* result.provider.available()).some(
                (item) => item.id === provider.id,
              )
            ) {
              const model = yield* result.model.get(
                defaultModel.providerID,
                defaultModel.modelID,
              )
              if (model?.enabled) return model
            }
          }

          return Option.getOrUndefined(
            pipe(
              yield* result.model.available(),
              Array.sortWith(
                (item) => item.time.released,
                Order.flip(Order.Number),
              ),
              Array.head,
            ),
          )
        }),

        small: Effect.fn("CatalogV2.model.small")(function* (providerID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const provider = record.provider

          if (providerID === CatalogProvider.ID.phins) {
            const gpt5Nano = record.models.get(CatalogModel.ID.make("gpt-5-nano"))
            if (gpt5Nano?.enabled && gpt5Nano.status === "active")
              return projectModel(gpt5Nano, provider)
          }

          const candidates = pipe(
            Array.fromIterable(record.models.values()),
            Array.filter(
              (model) =>
                model.providerID === providerID &&
                model.enabled &&
                model.status === "active" &&
                model.capabilities.input.some((item) =>
                  item.startsWith("text"),
                ) &&
                model.capabilities.output.some((item) =>
                  item.startsWith("text"),
                ),
            ),
            Array.map((model) => ({
              model,
              cost: model.cost[0]
                ? model.cost[0].input + model.cost[0].output
                : 999,
              age:
                (Date.now() - model.time.released) / (1000 * 60 * 60 * 24 * 30),
              small: SMALL_MODEL_RE.test(
                `${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase(),
              ),
            })),
            Array.filter((item) => item.cost > 0 && item.age <= 18),
          )

          const pick = (items: typeof candidates) => {
            const maxCost = Math.max(...items.map((item) => item.cost), 0.01)
            const maxAge = Math.max(...items.map((item) => item.age), 0.01)
            return pipe(
              items,
              Array.sortWith(
                (item) =>
                  (item.cost / maxCost) * 0.8 + (item.age / maxAge) * 0.2,
                Order.Number,
              ),
              Array.map((item) => projectModel(item.model, provider)),
              Array.head,
            )
          }

          return Option.getOrUndefined(
            pipe(
              candidates,
              Array.filter((item) => item.small),
              (items) => (items.length > 0 ? pick(items) : pick(candidates)),
            ),
          )
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const locationLayer = layer.pipe(
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Policy.locationLayer),
)
