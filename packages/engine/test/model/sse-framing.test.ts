import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import * as ProviderShared from "../../src/inference/protocols/shared"
import { LLMError } from "../../src/inference/schema"
import { it } from "./lib/effect"

const encoder = new TextEncoder()
const byteStream = (...chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk)))

describe("provider SSE framing", () => {
  it.effect("keeps a single-line CRLF event intact across chunk boundaries", () =>
    Effect.gen(function* () {
      const events = yield* ProviderShared.sseFraming(
        byteStream("data: one\r", "\n\r", "\n"),
        32,
      ).pipe(Stream.runCollect)

      expect(Array.from(events)).toEqual(["one"])
    }),
  )

  it.effect("keeps a multi-line CRLF event intact across chunk boundaries", () =>
    Effect.gen(function* () {
      const events = yield* ProviderShared.sseFraming(
        byteStream("data: a\r", "\ndata: b\r", "\n\r", "\ndata: c\r\n\r\n"),
        32,
      ).pipe(Stream.runCollect)

      expect(Array.from(events)).toEqual(["a\nb", "c"])
    }),
  )

  it.effect("flushes trailing carriage returns when the byte stream ends", () =>
    Effect.gen(function* () {
      const events = yield* ProviderShared.sseFraming(byteStream("data: tail\r", "\r"), 32).pipe(
        Stream.runCollect,
      )

      expect(Array.from(events)).toEqual(["tail"])
    }),
  )

  it.effect("does not accumulate carriage-return-only chunks", () =>
    Effect.gen(function* () {
      const carriageReturns = Array.from({ length: 4096 }, () => encoder.encode("\r"))
      const source = Stream.fromIterable([...carriageReturns, encoder.encode("data: ready\r\r")])
      const events = yield* ProviderShared.sseFraming(source, 32).pipe(Stream.runCollect)

      expect(Array.from(events)).toEqual(["ready"])
    }),
  )

  it.effect("bounds split multi-line events independently", () =>
    Effect.gen(function* () {
      const events = yield* ProviderShared.sseFraming(
        byteStream("data:", " a\ndata: b\n", "\ndata: c", "\n\n"),
        17,
      ).pipe(Stream.runCollect)

      expect(Array.from(events)).toEqual(["a\nb", "c"])
    }),
  )

  it.effect("rejects an oversized multi-line event split across chunks", () =>
    Effect.gen(function* () {
      const error = yield* ProviderShared.sseFraming(
        byteStream("data: 1234\r", "\ndata: ", "5678\r", "\n\r", "\n"),
        17,
      ).pipe(Stream.runDrain, Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({
        _tag: "InvalidProviderOutput",
        message: "Provider SSE event exceeds the 17 byte limit",
      })
      expect(error.retryable).toBe(false)
      expect("raw" in error.reason ? error.reason.raw : undefined).toBeUndefined()
    }),
  )

  it.effect("rejects an oversized unterminated line before UTF-8 decoding", () =>
    Effect.gen(function* () {
      const payload = encoder.encode("data: éé")
      const error = yield* ProviderShared.sseFraming(
        Stream.fromIterable([payload.subarray(0, 7), payload.subarray(7, 9), payload.subarray(9)]),
        9,
      ).pipe(Stream.runDrain, Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({
        _tag: "InvalidProviderOutput",
        message: "Provider SSE event exceeds the 9 byte limit",
      })
    }),
  )
})
