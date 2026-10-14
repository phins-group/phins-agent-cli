/**
 * Compiler và runtime client của canonical LLM route.
 *
 * Luồng: hợp nhất default request → protocol body → kiểm tra schema → chuẩn bị
 * endpoint/auth/transport → giải mã frame → state machine protocol → `LLMEvent`.
 * @module
 */
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import * as Option from "effect/Option"
import { Auth, type Auth as AuthDef } from "./auth"
import { Endpoint, type EndpointPatch } from "./endpoint"
import { RequestExecutor } from "./executor"
import { ExecutionBoundary } from "./execution-boundary"
import * as Spending from "./spending"
import type { Framing } from "./framing"
import { HttpTransport } from "../transports/transport"
import type { Transport, TransportRuntime } from "../transports/transport"
import { WebSocketExecutor } from "../transports/transport"
import type { Protocol } from "./protocol"
import { applyCachePolicy } from "../cache-policy"
import * as ProviderShared from "../protocols/shared"
import type { LLMError, LLMEvent, PreparedRequestOf, ProtocolID, ProviderOptions } from "../schema"
import {
  GenerationOptions,
  HttpOptions,
  LLMRequest,
  LLMResponse,
  Model,
  ModelLimits,
  LLMError as LLMErrorClass,
  PreparedRequest,
  ProviderID,
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
} from "../schema"

export interface RouteBody<Body> {
  /** Schema for the validated provider-native body sent as the JSON request. */
  readonly schema: Schema.Codec<Body, unknown>
  /** Build the provider-native body from a common `LLMRequest`. */
  readonly from: (request: LLMRequest) => Effect.Effect<Body, LLMError>
}

export interface Route<Body, Prepared = unknown> {
  readonly id: string
  readonly provider?: ProviderID
  readonly protocol: ProtocolID
  readonly endpoint: Endpoint<Body>
  readonly auth: AuthDef
  readonly transport: Transport<Body, Prepared, unknown>
  readonly defaults: RouteDefaults
  readonly body: RouteBody<Body>
  readonly with: (patch: RoutePatch<Body, Prepared>) => Route<Body, Prepared>
  readonly model: (input: RouteMappedModelInput) => Model
  readonly prepareTransport: (body: Body, request: LLMRequest) => Effect.Effect<Prepared, LLMError>
  readonly streamPrepared: (
    prepared: Prepared,
    request: LLMRequest,
    runtime: TransportRuntime,
  ) => Stream.Stream<LLMEvent, LLMError>
}

// Route registries intentionally erase body generics after construction.
// Normal call sites use `OpenAIChat.route`; callers only need body types
// when preparing a request with a protocol-specific type assertion.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
export type AnyRoute = Route<any, any>

export type HttpOptionsInput = HttpOptions.Input

export type RouteModelInput = Omit<Model.Input, "provider" | "route">

export type RouteRoutedModelInput = Omit<Model.Input, "route">

export interface RouteDefaults {
  readonly headers?: Record<string, string>
  readonly limits?: ModelLimits
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions
}

export interface RouteDefaultsInput {
  readonly headers?: Record<string, string>
  readonly limits?: ModelLimits.Input
  readonly generation?: GenerationOptions.Input
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions.Input
}

export interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
  readonly id?: string
  readonly provider?: string | ProviderID
  readonly auth?: AuthDef
  readonly transport?: Transport<Body, Prepared, unknown>
  readonly endpoint?: EndpointPatch<Body>
}

type RouteMappedModelInput = RouteModelInput | RouteRoutedModelInput

const makeRouteModel = (route: AnyRoute, mapped: RouteMappedModelInput) => {
  const provider = route.provider ?? ("provider" in mapped ? mapped.provider : undefined)
  if (!provider) throw new Error(`Route.model(${route.id}) requires a provider`)
  if (!endpointBaseURL(route.endpoint))
    throw new Error(`Route.model(${route.id}) requires an endpoint baseURL — configure it on the route first`)
  return Model.make({
    ...mapped,
    provider,
    route,
  })
}

const mergeRouteDefaults = (base: RouteDefaults | undefined, patch: RouteDefaultsInput): RouteDefaults => {
  const headers = mergeHeaders(base?.headers, patch.headers)
  return {
    ...base,
    ...patch,
    headers,
    limits: patch.limits === undefined ? base?.limits : ModelLimits.make(patch.limits),
    generation: mergeGenerationOptions(generationOptions(base?.generation), generationOptions(patch.generation)),
    providerOptions: mergeProviderOptions(base?.providerOptions, patch.providerOptions),
    http: mergeHttpOptions(
      base?.http,
      httpOptions(patch.http),
      headers === undefined ? undefined : new HttpOptions({ headers }),
    ),
  }
}

const endpointBaseURL = <Body>(endpoint: Endpoint<Body>) =>
  typeof endpoint.baseURL === "string" ? endpoint.baseURL : undefined

const mergeHeaders = (...items: ReadonlyArray<Record<string, string> | undefined>) => {
  const result: Record<string, string> = {}
  let size = 0
  for (const item of items) {
    if (item === undefined) continue
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue
      if (result[key] === undefined) size++
      result[key] = value
    }
  }
  return size === 0 ? undefined : result
}

export const generationOptions = (input: GenerationOptions.Input | undefined) =>
  input === undefined ? undefined : GenerationOptions.make(input)

export const httpOptions = (input: HttpOptionsInput | undefined) => {
  if (input === undefined) return input
  return HttpOptions.make(input)
}

export interface Interface {
  /**
   * Compile a request through protocol body construction, validation, and HTTP
   * preparation without sending it. Returns the prepared request including the
   * provider-native body.
   *
   * Pass a `Body` type argument to statically expose the route's body
   * shape (e.g. `prepare<OpenAIChatBody>(...)`) — the runtime body is
   * identical, so this is a type-level assertion the caller makes about which
   * route the request will resolve to.
   */
  readonly prepare: <Body = unknown>(request: LLMRequest) => Effect.Effect<PreparedRequestOf<Body>, LLMError>
  readonly stream: StreamMethod
  readonly generate: GenerateMethod
}

export interface StreamMethod {
  (request: LLMRequest, options?: RequestExecutor.ExecutionOptions): Stream.Stream<LLMEvent, LLMError>
}

export interface GenerateMethod {
  (request: LLMRequest, options?: RequestExecutor.ExecutionOptions): Effect.Effect<LLMResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@phins/LLMClient") {}

const resolveRequestOptions = (request: LLMRequest) =>
  LLMRequest.update(request, {
    generation:
      mergeGenerationOptions(request.model.route.defaults.generation, request.generation) ?? new GenerationOptions({}),
    providerOptions: mergeProviderOptions(request.model.route.defaults.providerOptions, request.providerOptions),
    http: mergeHttpOptions(request.model.route.defaults.http, request.http),
  })

export interface MakeInput<Body, Frame, Event, State> {
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: AuthDef
  /** Stream framing — bytes -> frames before `protocol.stream.event` decoding. */
  readonly framing: Framing<Frame>
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

export interface MakeTransportInput<Body, Prepared, Frame, Event, State> {
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: AuthDef
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Runnable transport route. */
  readonly transport: Transport<Body, Prepared, Frame>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

const streamError = (route: string, message: string, cause: Cause.Cause<unknown>) => {
  const failed = cause.reasons.find(Cause.isFailReason)?.error
  if (failed instanceof LLMErrorClass) return failed
  return ProviderShared.eventError(route, message, Cause.pretty(cause))
}

function makeFromTransport<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> {
  const protocol = input.protocol
  const encodeBody = Schema.encodeSync(Schema.fromJsonString(protocol.body.schema))
  const decodeEventEffect = Schema.decodeUnknownEffect(protocol.stream.event)
  const decodeEvent = (route: string) => (frame: Frame) =>
    decodeEventEffect(frame).pipe(
      Effect.mapError(() =>
        ProviderShared.eventError(
          input.id,
          `Invalid ${route} stream event`,
          typeof frame === "string" ? frame : ProviderShared.encodeJson(frame),
        ),
      ),
    )

  type BuiltRouteInput = Omit<MakeTransportInput<Body, Prepared, Frame, Event, State>, "defaults"> & {
    readonly defaults?: RouteDefaults
  }

  const build = (routeInput: BuiltRouteInput): Route<Body, Prepared> => {
    const route: Route<Body, Prepared> = {
      id: routeInput.id,
      provider: routeInput.provider === undefined ? undefined : ProviderID.make(routeInput.provider),
      protocol: protocol.id,
      endpoint: routeInput.endpoint,
      auth: routeInput.auth ?? Auth.none,
      transport: routeInput.transport,
      defaults: routeInput.defaults ?? {},
      body: protocol.body,
      with: (patch: RoutePatch<Body, Prepared>) => {
        const { id, provider, auth, transport, endpoint, ...defaults } = patch
        return build({
          ...routeInput,
          id: id ?? routeInput.id,
          provider: provider ?? routeInput.provider,
          auth: auth ?? routeInput.auth,
          endpoint: endpoint ? Endpoint.merge(routeInput.endpoint, endpoint) : routeInput.endpoint,
          transport: (transport as Transport<Body, Prepared, Frame> | undefined) ?? routeInput.transport,
          defaults: mergeRouteDefaults(route.defaults, defaults),
        })
      },
      model: (input) => makeRouteModel(route, input),
      prepareTransport: (body, request) =>
        routeInput.transport.prepare({
          body,
          request,
          endpoint: routeInput.endpoint,
          auth: routeInput.auth ?? Auth.none,
          encodeBody,
          headers: routeInput.headers,
        }),
      streamPrepared: (prepared: Prepared, request: LLMRequest, runtime: TransportRuntime) => {
        const route = `${request.model.provider}/${request.model.route.id}`
        const events = routeInput.transport
          .frames(prepared, request, runtime)
          .pipe(
            Stream.mapEffect(decodeEvent(route)),
            protocol.stream.terminal ? Stream.takeUntil(protocol.stream.terminal) : (stream) => stream,
          )
        return events.pipe(
          Stream.mapAccumEffect(
            () => protocol.stream.initial(request),
            protocol.stream.step,
            protocol.stream.onHalt ? { onHalt: protocol.stream.onHalt } : undefined,
          ),
          Stream.catchCause((cause) => Stream.fail(streamError(route, `Failed to read ${route} stream`, cause))),
        )
      },
    } satisfies Route<Body, Prepared>
    return route
  }

  return build({
    ...input,
    defaults: mergeRouteDefaults(undefined, input.defaults ?? {}),
  })
}

export function make<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared>
/**
 * Build a `Route` by composing the four orthogonal pieces of a deployment:
 *
 * - `Protocol` — what is the API I'm speaking?
 * - `Endpoint` — where do I send the request?
 * - `Auth` — how do I authenticate it?
 * - `Framing` — how do I cut the response stream into protocol frames?
 *
 * Plus optional `headers` for cross-cutting deployment concerns (provider
 * version pins, per-deployment quirks).
 *
 * This is the canonical route constructor. If a new route does not fit
 * this four-axis model, add a purpose-built constructor rather than widening
 * the public surface preemptively.
 */
export function make<Body, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State>,
): Route<Body, HttpTransport.HttpPrepared<Frame>>
export function make<Body, Prepared, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State> | MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> | Route<Body, HttpTransport.HttpPrepared<Frame>> {
  if ("transport" in input) return makeFromTransport(input)
  const protocol = input.protocol
  return makeFromTransport({
    id: input.id,
    provider: input.provider,
    protocol,
    endpoint: input.endpoint,
    auth: input.auth,
    headers: input.headers,
    transport: HttpTransport.httpJson({ framing: input.framing }),
    defaults: input.defaults,
  })
}

// Boundary compile biến canonical request thành provider body đã validate và
// transport-private data, nhưng chưa thực hiện network IO.
const compile = Effect.fn("LLM.compile")(function* (request: LLMRequest) {
  const resolved = applyCachePolicy(resolveRequestOptions(request))
  const route = resolved.model.route

  yield* ExecutionBoundary.request(resolved)

  const body = yield* route.body
    .from(resolved)
    .pipe(Effect.flatMap(ProviderShared.validateWith(Schema.decodeUnknownEffect(route.body.schema))))
  const prepared = yield* route.prepareTransport(body, resolved)

  return {
    request: resolved,
    route,
    body,
    prepared,
  }
})

const prepareWith = Effect.fn("LLMClient.prepare")(function* (request: LLMRequest) {
  const compiled = yield* compile(request)

  return new PreparedRequest({
    id: compiled.request.id ?? "request",
    route: compiled.route.id,
    protocol: compiled.route.protocol,
    model: compiled.request.model,
    body: compiled.body,
    metadata: { transport: compiled.route.transport.id },
  })
})

/** Compile rồi chạy route stream bằng transport runtime được inject. */
const runtimeWithExecutionOptions = (
  runtime: TransportRuntime,
  options: RequestExecutor.ExecutionOptions | undefined,
): TransportRuntime =>
  options === undefined
    ? runtime
    : {
        ...runtime,
        // Retry policy applies only to HTTP response acquisition. The WebSocket
        // executor and response framing/parser streams remain untouched.
        http: {
          execute: (request) => runtime.http.execute(request, options),
        },
      }

const streamRequestWith =
  (runtime: TransportRuntime) => (request: LLMRequest, options?: RequestExecutor.ExecutionOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const compiled = yield* compile(request)
        if (Spending.guarded && compiled.route.transport.id !== "http-json")
          return Stream.fail(ProviderShared.eventError("Spending", "Allowance requires HTTP JSON transport"))
        return Spending.track(compiled.route.streamPrepared(
          compiled.prepared,
          compiled.request,
          runtimeWithExecutionOptions(runtime, options),
        ))
      }),
    )

/** Fold stream thành response đầy đủ mà không đổi semantics của event sequence. */
const generateWith = (stream: Interface["stream"]) =>
  Effect.fn("LLM.generate")(function* (request: LLMRequest, options?: RequestExecutor.ExecutionOptions) {
    return new LLMResponse(
      yield* stream(request, options).pipe(
        Stream.runFold(
          () => ({
            events: [] as LLMEvent[],
            usage: undefined as LLMResponse["usage"],
          }),
          (acc, event) => {
            acc.events.push(event)
            if ("usage" in event && event.usage !== undefined) acc.usage = event.usage
            return acc
          },
        ),
      ),
    )
  })

export const prepare = <Body = unknown>(request: LLMRequest) =>
  prepareWith(request) as Effect.Effect<PreparedRequestOf<Body>, LLMError>

export function stream(
  request: LLMRequest,
  options?: RequestExecutor.ExecutionOptions,
): Stream.Stream<LLMEvent, LLMError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request, options)
    }),
  ) as Stream.Stream<LLMEvent, LLMError>
}

export function generate(
  request: LLMRequest,
  options?: RequestExecutor.ExecutionOptions,
): Effect.Effect<LLMResponse, LLMError> {
  return Effect.gen(function* () {
    return yield* (yield* Service).generate(request, options)
  }) as Effect.Effect<LLMResponse, LLMError>
}

export const streamRequest = (request: LLMRequest, options?: RequestExecutor.ExecutionOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request, options)
    }),
  )

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const stream = streamRequestWith({
      http: yield* RequestExecutor.Service,
      webSocket: Option.getOrUndefined(yield* Effect.serviceOption(WebSocketExecutor.Service)),
    })
    return Service.of({
      prepare: prepareWith as Interface["prepare"],
      stream,
      generate: generateWith(stream),
    })
  }),
)

export const Route = { make } as const

export const LLMClient = {
  Service,
  layer,
  prepare,
  stream,
  generate,
} as const
