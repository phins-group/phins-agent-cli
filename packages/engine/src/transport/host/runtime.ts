export * as ServerRuntime from "./runtime"

import { Database } from "../../storage/database"
import { ServiceGraph } from "../../runtime/effect/service-graph"
import { EventBus } from "../../runtime/events/bus"
import { SessionRuntimeLocal } from "../../sessions/runtime"

/**
 * Standalone server graph with root Event/Database services kept in output.
 *
 * SessionRuntimeLocal.defaultLayer is intentionally closed for standalone
 * consumers. HTTP handlers also consume EventBus and Database directly, so the
 * server graph must expose the exact nodes that SessionManager and its projectors
 * captured instead of installing a second pair outside that closed layer.
 */
export const graph = ServiceGraph.group([
  Database.node,
  EventBus.node,
  SessionRuntimeLocal.graph,
])

export const layer = ServiceGraph.build(graph)
