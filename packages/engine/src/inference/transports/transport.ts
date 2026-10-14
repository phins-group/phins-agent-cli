/** Hợp đồng transport: chuẩn bị provider request rồi phát response unit có frame. @module */
import type { Effect, Stream } from "effect"
import type { Endpoint } from "../request/endpoint"
import type { Auth } from "../request/auth"
import type { Interface as RequestExecutorInterface } from "../request/executor"
import type { Interface as WebSocketExecutorInterface } from "./websocket"
import type { LLMError, LLMRequest } from "../schema"

export interface TransportRuntime {
  readonly http: RequestExecutorInterface
  readonly webSocket?: WebSocketExecutorInterface
}

export interface Transport<Body, Prepared, Frame> {
  readonly id: string
  readonly prepare: (input: TransportPrepareInput<Body>) => Effect.Effect<Prepared, LLMError>
  readonly frames: (
    prepared: Prepared,
    request: LLMRequest,
    runtime: TransportRuntime,
  ) => Stream.Stream<Frame, LLMError>
}

export interface TransportPrepareInput<Body> {
  readonly body: Body
  readonly request: LLMRequest
  readonly endpoint: Endpoint<Body>
  readonly auth: Auth
  readonly encodeBody: (body: Body) => string
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
}

export * as HttpTransport from "./http"
export { WebSocketExecutor, WebSocketTransport } from "./websocket"
