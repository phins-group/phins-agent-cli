import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { LLMClient, RequestExecutor } from "../../inference/request/api"
import { FetchHttpClient } from "effect/unstable/http"
import { ServiceGraph } from "./service-graph"

export const filesystem = ServiceGraph.node(NodeFileSystem.layer, [])
export const path = ServiceGraph.node(NodePath.layer, [])
export const httpClient = ServiceGraph.node(FetchHttpClient.layer, [])
export const requestExecutor = ServiceGraph.node(RequestExecutor.layer, [httpClient])
export const llmClient = ServiceGraph.node(LLMClient.layer, [requestExecutor])

export * as ServicePlatform from "./platform"
