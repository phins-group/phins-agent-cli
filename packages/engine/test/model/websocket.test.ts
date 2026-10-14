import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError } from "../../src/inference/api"
import { WebSocketExecutor } from "../../src/inference/request/api"
import { it } from "./lib/effect"

const queueCapacity = 128

class TestWebSocket extends EventTarget {
  readyState: number = globalThis.WebSocket.OPEN
  readonly closeCalls: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []

  send(_message: string) {}

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason })
    this.readyState = globalThis.WebSocket.CLOSING
  }

  emitMessage(data: string | Uint8Array) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }

  emitClose(code: number) {
    this.readyState = globalThis.WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code }))
  }
}

const connect = (socket: TestWebSocket) =>
  WebSocketExecutor.fromWebSocket(socket as unknown as globalThis.WebSocket, {
    url: "wss://api.openai.test/v1/responses",
    headers: Headers.empty,
  })

describe("WebSocket executor", () => {
  it.effect("preserves inbound message order through queue capacity", () =>
    Effect.gen(function* () {
      const socket = new TestWebSocket()
      const connection = yield* connect(socket)
      const expected = Array.from({ length: queueCapacity }, (_, index) => `frame-${index}`)

      for (const frame of expected) socket.emitMessage(frame)
      socket.emitClose(1000)

      const received = Array.from(yield* connection.messages.pipe(Stream.runCollect))

      expect(received).toEqual(expected)
      expect(socket.closeCalls).toEqual([])
    }),
  )

  it.effect("fails and closes the socket when the inbound message queue overflows", () =>
    Effect.gen(function* () {
      const socket = new TestWebSocket()
      const connection = yield* connect(socket)
      const expected = Array.from({ length: queueCapacity }, (_, index) => `frame-${index}`)
      const received: Array<string | Uint8Array> = []

      for (const frame of [...expected, "overflow"]) socket.emitMessage(frame)

      const error = yield* connection.messages.pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => {
            received.push(message)
          }),
        ),
        Effect.flip,
      )

      expect(received).toEqual(expected)
      expect(error).toBeInstanceOf(LLMError)
      expect(error).toMatchObject({
        module: "WebSocketExecutor",
        method: "message",
        reason: {
          _tag: "Transport",
          kind: "overflow",
          url: "wss://api.openai.test/v1/responses",
          message: "WebSocket inbound message queue exceeded capacity 128",
        },
      })
      expect(socket.closeCalls).toEqual([{ code: 1011, reason: "Inbound message queue overflow" }])
    }),
  )
})
