export * as ConfigProvider from "./providers"

import { Schema } from "effect"
import { CatalogProvider } from "../inference/catalog/provider"
import { CatalogModel } from "../inference/catalog/model"

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

class Cache extends Schema.Class<Cache>("ConfigV2.Model.Cost.Cache")({
  read: Schema.Finite.pipe(Schema.optional),
  write: Schema.Finite.pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Cache.pipe(Schema.optional),
}) {}

class Limit extends Schema.Class<Limit>("ConfigV2.Model.Limit")({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
}) {}

const ModelApi = Schema.Union([
  Schema.Struct({
    id: CatalogModel.ID.pipe(Schema.optional),
    ...CatalogProvider.AISDK.fields,
  }),
  Schema.Struct({
    id: CatalogModel.ID.pipe(Schema.optional),
    ...CatalogProvider.Native.fields,
  }),
  Schema.Struct({
    id: CatalogModel.ID,
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  family: CatalogModel.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: CatalogModel.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: CatalogModel.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  api: CatalogProvider.Api.pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}
