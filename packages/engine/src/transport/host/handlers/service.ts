import { SessionExecution } from "../../../sessions/run/execution"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServiceControl } from "../service-control"

export const ServiceHandler = HttpApiBuilder.group(
  Api,
  "server.service",
  (handlers) =>
    Effect.gen(function* () {
      const control = yield* ServiceControl.Service
      const execution = yield* SessionExecution.Service
      return handlers
        .handle("service.status", () => control.status)
        .handle(
          "service.shutdown",
          Effect.fn(function* (ctx) {
            yield* control.shutdown(ctx.payload.id, execution.awaitIdle)
            return { id: ctx.payload.id, state: "draining" as const }
          }),
        )
    }),
)
