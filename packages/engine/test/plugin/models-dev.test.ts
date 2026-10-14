import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "../../src/inference/catalog/registry"
import { Integration } from "../../src/extensions/integrations/service"
import { Credential } from "../../src/security/credentials"
import { EventBus } from "../../src/runtime/events/bus"
import { Flag } from "../../src/runtime/flags"
import { Location } from "../../src/workspace/location"
import { ModelMetadata } from "../../src/inference/catalog/metadata"
import { ModelsDevPlugin } from "../../src/extensions/models-dev"
import { Policy } from "../../src/security/policy"
import { AbsolutePath } from "../../src/shared/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const events = EventBus.defaultLayer
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const policy = Policy.layer.pipe(Layer.provide(locationLayer))
const connections = Credential.defaultLayer.pipe(Layer.fresh)
const integrations = Integration.locationLayer.pipe(Layer.provide(events), Layer.provide(connections))
const catalog = Catalog.layer.pipe(
  Layer.provide(Layer.mergeAll(events, locationLayer, policy, connections, integrations)),
)
const layer = Layer.mergeAll(catalog.pipe(Layer.provide(connections)), integrations, connections, events, locationLayer)
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.PHINS_MODELS_PATH,
          disabled: Flag.PHINS_DISABLE_MODELS_FETCH,
        }
        Flag.PHINS_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.PHINS_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(ModelMetadata.defaultLayer)),
      (previous) =>
        Effect.sync(() => {
          Flag.PHINS_MODELS_PATH = previous.path
          Flag.PHINS_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
