export * as SessionRuntimeLocal from "./runtime"

import { Layer } from "effect"
import { Database } from "../storage/database"
import { ServiceGraph } from "../runtime/effect/service-graph"
import { EventBus } from "../runtime/events/bus"
import { locationServicesNode } from "../runtime/services"
import { ProjectRegistry } from "../workspace/projects/service"
import { SessionManager } from "./service"
import * as SessionExecutionLocal from "./run/local-executor"
import { SessionProjector } from "./projector"
import { SessionStore } from "./store"

// `provideMerge` deliberately keeps the exact execution coordinator consumed
// by SessionManager in the runtime output. A plain `provide` would hide it and make
// it easy for another graph edge to install a second coordinator.
const storeAndExecution = SessionExecutionLocal.layer.pipe(
  Layer.provideMerge(SessionStore.layer),
)

const projectorBarrier = Layer.effectDiscard(SessionProjector.Readiness)

/** Canonical local Session V2 runtime used by HTTP and recovery supervisors. */
export const layer = Layer.mergeAll(
  SessionManager.layer.pipe(Layer.provideMerge(storeAndExecution)),
  projectorBarrier,
)

export const node = ServiceGraph.node(layer, [
  locationServicesNode,
  Database.node,
  EventBus.node,
  ProjectRegistry.node,
  SessionProjector.node,
])

/** Includes the shared Location map for middleware that resolves request scope. */
export const graph = ServiceGraph.group([locationServicesNode, node])

export const defaultLayer = ServiceGraph.build(graph)
