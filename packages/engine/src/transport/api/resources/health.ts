/** Health và capability discovery local không cần location. @module */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const LocalCapabilities = Schema.Struct({
  protocol: Schema.Literal("phins.local-api.v1"),
  capabilities: Schema.Tuple([
    Schema.Literal("session.prompt.durable.v1"),
    Schema.Literal("session.resume.scheduled.v1"),
    Schema.Literal("session.interrupt.cleanup.v1"),
    Schema.Literal("session.wait.idle.v1"),
    Schema.Literal("session.shell.local.v1"),
    Schema.Literal("session.skill.durable.v1"),
    Schema.Literal("session.compact.manual.v1"),
    Schema.Literal("session.events.durable.v1"),
    Schema.Literal("session.snapshot.durable.v1"),
    Schema.Literal("session.deltas.live.v1"),
    Schema.Literal("service.generation.fence.v1"),
    Schema.Literal("node.connect.browser.v1"),
    Schema.Literal("node.chat.runtime.v1"),
  ]),
  nodeControl: Schema.Literal(false),
}).annotate({ identifier: "LocalCapabilities" })

export const localCapabilities = LocalCapabilities.make({
  protocol: "phins.local-api.v1",
  capabilities: [
    "session.prompt.durable.v1",
    "session.resume.scheduled.v1",
    "session.interrupt.cleanup.v1",
    "session.wait.idle.v1",
    "session.shell.local.v1",
    "session.skill.durable.v1",
    "session.compact.manual.v1",
    "session.events.durable.v1",
    "session.snapshot.durable.v1",
    "session.deltas.live.v1",
    "service.generation.fence.v1",
    "node.connect.browser.v1",
    "node.chat.runtime.v1",
  ],
  nodeControl: false,
})

export const HealthGroup = HttpApiGroup.make("server.health").add(
  HttpApiEndpoint.get("health.get", "/api/health", {
    success: Schema.Struct({ healthy: Schema.Literal(true) }),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.health.get",
      summary: "Check server health",
      description: "Check whether the API server is ready to accept requests.",
    }),
  ),
  HttpApiEndpoint.get("health.capabilities", "/api/capabilities", {
    success: LocalCapabilities,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.health.capabilities",
      summary: "Discover local session control capabilities",
      description:
        "Advertises implemented local session control only, not full runtime parity or remote Node Control. Requires the same authentication as other API routes.",
    }),
  ),
)
