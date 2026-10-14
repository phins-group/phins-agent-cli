import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { LLM, Model } from "../../src/inference/api"
import {
  Auth,
  ExecutionBoundary,
  LLMClient,
  RequestExecutor,
  WebSocketExecutor,
} from "../../src/inference/request/api"
import * as OpenAIChat from "../../src/inference/protocols/openai-chat"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/chat")
const model = Model.make({
  id: "fixture",
  provider: "fixture",
  route: OpenAIChat.route.with({ auth: Auth.none }),
})
const denied = {
  request: () => Effect.die("denied"),
  attempt: Effect.die("denied"),
}
const allowed = { request: () => Effect.void, attempt: Effect.void }
const http = (
  send: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, send(request))),
        ),
      ),
    ),
  )
const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.tap((exit) => Effect.sync(() => expect(exit._tag).toBe("Failure"))),
  )

describe("consumer-owned execution boundaries", () => {
  it.effect("leaves ordinary request execution unchanged", () =>
    Effect.gen(function* () {
      let sends = 0
      yield* RequestExecutor.Service.use((executor) =>
        executor.execute(request),
      ).pipe(
        Effect.provide(
          http(() => {
            sends++
            return new Response("ok")
          }),
        ),
      )
      expect(sends).toBe(1)
    }),
  )

  it.effect("checks resolved defaults before lowering and signing", () =>
    Effect.gen(function* () {
      let signed = 0
      let sawDefaults = false
      const configured = model.route
        .with({
          http: { body: { tools: [{ type: "web_search" }] } },
          auth: {
            ...Auth.none,
            apply: (input) =>
              Effect.sync(() => {
                signed++
                return input.headers
              }),
          },
        })
        .model({ id: "fixture" })
      yield* failed(
        ExecutionBoundary.restrict(
          {
            ...allowed,
            request: (request) =>
              Effect.sync(() => {
                sawDefaults = request.http?.body?.tools !== undefined
              }).pipe(Effect.andThen(Effect.die("denied"))),
          },
          LLMClient.prepare(
            LLM.request({ model: configured, prompt: "fixture" }),
          ),
        ),
      )
      expect(sawDefaults).toBe(true)
      expect(signed).toBe(0)
    }),
  )

  it.effect("does not acquire HTTP when the initial attempt is denied", () =>
    Effect.gen(function* () {
      let sends = 0
      yield* failed(
        ExecutionBoundary.restrict(
          denied,
          RequestExecutor.Service.use((executor) => executor.execute(request)),
        ).pipe(
          Effect.provide(
            http(() => {
              sends++
              return new Response("ok")
            }),
          ),
        ),
      )
      expect(sends).toBe(0)
    }),
  )

  it.effect(
    "rechecks after retry backoff rather than trusting the retry notice",
    () =>
      Effect.gen(function* () {
        let valid = true
        let sends = 0
        let checks = 0
        const retry = yield* Deferred.make<void>()
        const execution = ExecutionBoundary.restrict(
          {
            ...allowed,
            attempt: Effect.suspend(() => {
              checks++
              return valid ? Effect.void : Effect.die("revoked")
            }),
          },
          RequestExecutor.Service.use((executor) =>
            executor.execute(request, {
              retryPolicy: RequestExecutor.RetryPolicy.make({
                baseDelayMs: 1_000,
                maxDelayMs: 1_000,
              }),
              onRetry: () =>
                Deferred.succeed(retry, undefined).pipe(Effect.asVoid),
            }),
          ),
        ).pipe(
          Effect.provide(
            http(() => {
              sends++
              return new Response("busy", {
                status: 503,
                headers: { "retry-after": "1" },
              })
            }),
          ),
        )
        const fiber = yield* Effect.forkChild(execution.pipe(Effect.exit))
        yield* Deferred.await(retry)
        valid = false
        yield* TestClock.adjust("1 second")
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
        expect(sends).toBe(1)
        expect(checks).toBe(2)
      }),
  )

  it.effect("nested scopes cannot replace a parent's denied check", () =>
    Effect.gen(function* () {
      let sends = 0
      yield* failed(
        ExecutionBoundary.restrict(
          denied,
          ExecutionBoundary.restrict(
            allowed,
            RequestExecutor.Service.use((executor) =>
              executor.execute(request),
            ),
          ),
        ).pipe(
          Effect.provide(
            http(() => {
              sends++
              return new Response("ok")
            }),
          ),
        ),
      )
      expect(sends).toBe(0)
    }),
  )

  it.effect(
    "does not leak a restricted scope into sibling or later requests",
    () =>
      Effect.gen(function* () {
        let sends = 0
        const layer = http(() => {
          sends++
          return new Response("ok")
        })
        yield* Effect.all(
          [
            failed(
              ExecutionBoundary.restrict(
                denied,
                RequestExecutor.Service.use((executor) =>
                  executor.execute(request),
                ),
              ),
            ),
            RequestExecutor.Service.use((executor) =>
              executor.execute(request),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(layer))
        yield* RequestExecutor.Service.use((executor) =>
          executor.execute(request),
        ).pipe(Effect.provide(layer))
        expect(sends).toBe(2)
      }),
  )

  it.effect("preserves interruption while checking an attempt", () =>
    Effect.gen(function* () {
      let sends = 0
      yield* failed(
        ExecutionBoundary.restrict(
          { ...allowed, attempt: Effect.interrupt },
          RequestExecutor.Service.use((executor) => executor.execute(request)),
        ).pipe(
          Effect.provide(
            http(() => {
              sends++
              return new Response("ok")
            }),
          ),
        ),
      )
      expect(sends).toBe(0)
    }),
  )

  it.effect(
    "denies WebSocket acquisition before constructing a connection",
    () =>
      Effect.gen(function* () {
        yield* failed(
          ExecutionBoundary.restrict(
            denied,
            WebSocketExecutor.open({
              url: "wss://provider.test/fixture",
              headers: Headers.empty,
            }),
          ),
        )
      }),
  )

  it.effect("rechecks each WebSocket send and still permits cleanup", () =>
    Effect.gen(function* () {
      let sends = 0
      let closes = 0
      class Socket extends EventTarget {
        readyState = globalThis.WebSocket.OPEN
        send() {
          sends++
        }
        close() {
          closes++
        }
      }
      const connection = yield* WebSocketExecutor.fromWebSocket(
        new Socket() as unknown as globalThis.WebSocket,
        {
          url: "wss://provider.test/fixture",
          headers: Headers.empty,
        },
      )
      yield* failed(
        ExecutionBoundary.restrict(denied, connection.sendText("private")),
      )
      yield* ExecutionBoundary.restrict(denied, connection.close)
      expect(sends).toBe(0)
      expect(closes).toBe(1)
    }),
  )

  it.effect(
    "checks the canonical stream's request even with an injected executor",
    () =>
      Effect.gen(function* () {
        let sends = 0
        yield* failed(
          ExecutionBoundary.restrict(
            denied,
            LLMClient.stream(LLM.request({ model, prompt: "fixture" })).pipe(
              Stream.runDrain,
            ),
          ).pipe(
            Effect.provide(
              LLMClient.layer.pipe(
                Layer.provide(
                  http(() => {
                    sends++
                    return new Response("unused")
                  }),
                ),
              ),
            ),
          ),
        )
        expect(sends).toBe(0)
      }),
  )
})
