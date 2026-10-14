/** Health và capability discovery không phụ thuộc location. @module */
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { localCapabilities } from "../../api/resources/health"

export const HealthHandler = HttpApiBuilder.group(Api, "server.health", (handlers) =>
  handlers
    .handle("health.get", () => Effect.succeed({ healthy: true as const }))
    .handle("health.capabilities", () => Effect.succeed(localCapabilities)),
)
