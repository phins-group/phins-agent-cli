import { ServiceAdmission } from "../../api/middleware/service-admission"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { ServiceControl } from "../service-control"

export const serviceAdmissionLayer = Layer.effect(
  ServiceAdmission,
  Effect.gen(function* () {
    const control = yield* ServiceControl.Service
    return ServiceAdmission.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* control.withRequest(
          request.method,
          new URL(request.url, "http://localhost").pathname,
          effect,
          request.headers["x-phins-service-generation"],
        )
      }),
    )
  }),
)
