export * as SessionRunnerModel from "./model"

import { type Model } from "../../inference/api"

import * as OpenAICompatibleChat from "../../inference/protocols/openai-compatible-chat"

import { Auth, type AnyRoute } from "../../inference/request/api"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../inference/catalog/registry"
import { Credential } from "../../security/credentials"
import { Integration } from "../../extensions/integrations/service"
import { CatalogModel } from "../../inference/catalog/model"
import { CatalogProvider } from "../../inference/catalog/provider"
import { Session as SessionSchema } from "../../contracts/session/info"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: CatalogProvider.ID,
    modelID: CatalogModel.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: CatalogProvider.ID,
    modelID: CatalogModel.ID,
    variant: CatalogModel.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: CatalogProvider.ID,
    modelID: CatalogModel.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export type ResolvedModel = Model & { readonly cost?: CatalogModel.Info["cost"] }

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<ResolvedModel, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/SessionRunnerModel",
) {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) =>
  Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: CatalogModel.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: CatalogModel.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "apiKey"),
      )
    : body
  return route.with({
    provider: model.providerID,
    endpoint:
      model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: CatalogModel.Info,
  variantID: CatalogModel.VariantID | undefined,
): Effect.Effect<CatalogModel.Info, VariantUnavailableError> => {
  const id =
    variantID === "default" || variantID === undefined
      ? model.request.variant
      : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: CatalogModel.Info) =>
  model.api.type === "aisdk"
    ? `${model.api.type}:${model.api.package}`
    : model.api.type

export const fromCatalogModel = (
  model: CatalogModel.Info,
  credential?: Credential.Value,
): Effect.Effect<ResolvedModel, UnsupportedApiError> => {
  const resolved =
    credential?.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)

  if (
    resolved.api.type === "aisdk" &&
    resolved.api.package === "@ai-sdk/openai-compatible" &&
    resolved.api.url
  ) {
    return Effect.succeed(
      Object.assign(withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }), { cost: resolved.cost }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (
  session: SessionSchema.Info,
  model: CatalogModel.Info,
  credential?: Credential.Value,
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, credential)),
  )

export const supported = (model: CatalogModel.Info) =>
  model.api.type === "aisdk" &&
  model.api.package === "@ai-sdk/openai-compatible" &&
  model.api.url !== undefined

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Read the policy-filtered catalog belonging to this Location.
        const defaultModel = session.model
          ? undefined
          : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) =>
                model.providerID === session.model?.providerID &&
                model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected)
          return yield* new ModelNotSelectedError({ sessionID: session.id })

        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection
            ? yield* integrations.connection.resolve(connection)
            : undefined,
        )
      }),
    })
  }),
)
