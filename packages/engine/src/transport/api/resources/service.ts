/** Opt-in local daemon lifecycle; embedded and legacy hosts stay unmanaged. @module */
import { Schema } from "effect"
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi"
import { ConflictError, ServiceUnavailableError } from "../errors"

export const ServiceStatus = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("unmanaged") }),
  Schema.Struct({
    mode: Schema.Literal("managed"),
    id: Schema.String,
    state: Schema.Literals(["running", "draining"]),
  }),
]).annotate({ identifier: "LocalServiceStatus" })

export const ServiceGroup = HttpApiGroup.make("server.service").add(
  HttpApiEndpoint.get("service.status", "/api/service", {
    success: ServiceStatus,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.service.status",
      summary: "Read local daemon lifecycle",
      description:
        "Only an explicitly registered standalone daemon exposes managed lifecycle. This is not remote Node Control.",
    }),
  ),
  HttpApiEndpoint.post("service.shutdown", "/api/service/shutdown", {
    payload: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
    success: Schema.Struct({
      id: Schema.String,
      state: Schema.Literal("draining"),
    }).pipe(HttpApiSchema.status(202)),
    error: [ConflictError, ServiceUnavailableError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.service.shutdown",
      summary: "Drain the registered local daemon",
      description:
        "Closes write admission and waits for accepted requests and current session owners before shutting down. The ID must match this daemon generation. 202 acknowledges draining, not stopped. Embedded and legacy hosts refuse this operation; no force kill or remote control is provided.",
    }),
  ),
)
