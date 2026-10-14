import { define } from "./definition"
import { Effect, Stream } from "effect"
import { EventBus } from "../runtime/events/bus"
import { CatalogModel } from "../inference/catalog/model"
import { ModelMetadata } from "../inference/catalog/metadata"
import { CatalogProvider } from "../inference/catalog/provider"

function released(date: string) {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}

function cost(input: ModelMetadata.Model["cost"]) {
  if (!input) return []
  const base = {
    input: input.input,
    output: input.output,
    cache: {
      read: input.cache_read ?? input.input,
      write: input.cache_write ?? input.input,
    },
  }
  if (!input.context_over_200k) return [base]
  return [
    base,
    {
      tier: {
        type: "context" as const,
        size: 200_000,
      },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? input.context_over_200k.input,
        write: input.context_over_200k.cache_write ?? input.context_over_200k.input,
      },
    },
  ]
}

function variants(model: ModelMetadata.Model) {
  return Object.entries(model.experimental?.modes ?? {}).map(([id, item]) => ({
    id: CatalogModel.VariantID.make(id),
    headers: { ...(item.provider?.headers ?? {}) },
    body: { ...(item.provider?.body ?? {}) },
  }))
}

export const ModelsDevPlugin = define({
  id: "models-dev",
  effect: Effect.fn(function* (ctx) {
    const modelsDev = yield* ModelMetadata.Service
    const events = yield* EventBus.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const data = yield* modelsDev.get()
        for (const item of Object.values(data)) {
          if (item.env.length === 0) continue
          const integrationID = item.id
          integrations.update(integrationID, (integration) => (integration.name = item.name))
          integrations.method.update({
            integrationID,
            method: { type: "key" },
          })
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...item.env] },
          })
        }
      }),
    )
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const data = yield* modelsDev.get()
        for (const item of Object.values(data)) {
          const providerID = CatalogProvider.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.api = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "native",
                  url: item.api,
                  settings: {},
                }
          })

          for (const model of Object.values(item.models)) {
            const modelID = CatalogModel.ID.make(model.id)
            catalog.model.update(providerID, modelID, (draft) => {
              draft.name = model.name
              draft.family = model.family ? CatalogModel.Family.make(model.family) : undefined
              draft.api = model.provider?.npm
                ? {
                    id: draft.api.id,
                    type: "aisdk",
                    package: model.provider?.npm,
                    url: model.provider.api,
                  }
                : {
                    id: draft.api.id,
                    type: "native",
                    url: model.provider?.api,
                    settings: {},
                  }
              draft.capabilities = {
                tools: model.tool_call,
                input: [...(model.modalities?.input ?? [])],
                output: [...(model.modalities?.output ?? [])],
              }
              draft.variants = variants(model)
              draft.time.released = released(model.release_date)
              draft.cost = cost(model.cost)
              draft.status = model.status ?? "active"
              draft.enabled = true
              draft.limit = {
                context: model.limit.context,
                input: model.limit.input,
                output: model.limit.output,
              }
            })
          }
        }
      }),
    )
    yield* events.subscribe(ModelMetadata.Event.Refreshed).pipe(
      Stream.runForEach(() => ctx.integration.reload().pipe(Effect.andThen(ctx.catalog.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
