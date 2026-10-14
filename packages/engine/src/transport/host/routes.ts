/**
 * Điểm ghép route độc lập của package server V2.
 * Sở hữu auth config, handler graph, Core globals và Fetch web-handler adapter.
 * @module
 */
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { ServerRuntime } from "./runtime"
import { ServiceControl } from "./service-control"
import { serviceAdmissionLayer } from "./middleware/service-admission"

/** Tạo routes có password auth hoặc config auth mặc định. */
export function createRoutes(
  password?: string,
  control = ServiceControl.unmanagedLayer,
) {
  return makeRoutes(
    password
      ? ServerAuth.Config.layer({
          username: "phins",
          password: Option.some(password),
        })
      : ServerAuth.Config.defaultLayer,
    control,
  )
}

/** Tạo embedded routes không yêu cầu password nhưng vẫn giữ auth middleware. */
export function createEmbeddedRoutes() {
  return makeRoutes(
    ServerAuth.Config.layer({ username: "phins", password: Option.none() }),
  )
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  control = ServiceControl.unmanagedLayer,
) {
  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(serviceAdmissionLayer),
    Layer.provide(control),
    // Preserve the exact execution service for the standalone host's signal
    // drain; never build another runtime outside the HTTP graph.
    Layer.provideMerge(ServerRuntime.layer),
    Layer.provide(PtyEnvironment.defaultLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(FetchHttpClient.layer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
