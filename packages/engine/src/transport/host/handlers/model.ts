/** Hiện thực model.list từ snapshot Catalog của location. @module */
import { Catalog } from "../../../inference/catalog/registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { ServiceUnavailableError } from "../../api/errors"
import { CatalogProvider } from "../../../inference/catalog/provider"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "model.list",
      Effect.fn(function* (ctx) {
        const catalog = yield* Catalog.Service
        if (ctx.query.refresh) yield* catalog.model.refresh(CatalogProvider.ID.make(ctx.query.refresh)).pipe(
          Effect.mapError(() => new ServiceUnavailableError({
            message: "Could not refresh provider models. Saved models remain available.",
          })),
        )
        return yield* response(catalog.model.available())
      }),
    )
  }),
)
