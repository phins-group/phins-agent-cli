/** Bounded SSE encoding and framing shared by HTTP event transports. @module */
import { Effect, Schema, Stream } from "effect"
import * as SseEncoding from "effect/unstable/encoding/Sse"
import { types } from "node:util"

/**
 * One frame may carry normal message/tool payloads, but must not grow without
 * bound. This remains above the repository's 10 MiB MCP resource allowance.
 */
export const MAX_EVENT_BYTES = 16 * 1024 * 1024

/** MIME types are case-insensitive and may include parameters. */
export function isEventStreamContentType(value: string | undefined) {
  return /^\s*text\/event-stream(?:\s*;|\s*$)/i.test(value ?? "")
}

export class EventTooLargeError extends Schema.TaggedErrorClass<EventTooLargeError>()("SseEventTooLargeError", {
  actualBytes: Schema.Number,
  maximumBytes: Schema.Number,
}) {}

export class EventEncodingError extends Schema.TaggedErrorClass<EventEncodingError>()("SseEventEncodingError", {
  message: Schema.String,
}) {}

export class InvalidUtf8Error extends Schema.TaggedErrorClass<InvalidUtf8Error>()("SseInvalidUtf8Error", {
  message: Schema.String,
}) {}

/** Decode an SSE byte stream strictly while retaining split UTF-8 sequences. */
export function decodeUtf8<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E | InvalidUtf8Error, R> {
  return Stream.suspend(() => {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const decode = (chunk?: Uint8Array, streaming = false) =>
      Effect.try({
        try: () => decoder.decode(chunk, { stream: streaming }),
        catch: () => new InvalidUtf8Error({ message: "SSE stream contained invalid UTF-8" }),
      })

    return stream.pipe(
      Stream.mapEffect((chunk) => decode(chunk, true)),
      Stream.concat(Stream.fromEffect(decode())),
    )
  })
}

const eventFrame = (data: string): SseEncoding.Event => ({
  _tag: "Event",
  event: "message",
  id: undefined,
  data,
})

const EVENT_FRAME_OVERHEAD_BYTES = Buffer.byteLength(SseEncoding.encoder.write(eventFrame("0")), "utf8") - 1
const JSON_CHUNK_BYTES = 4 * 1024
const ENCODING_FAILURE_MESSAGE = "SSE event data was not JSON serializable"

class BoundedJsonWriter {
  readonly #chunks: string[] = []
  readonly #pending: string[] = []
  #pendingBytes = 0
  #bytes = 0
  #overflow = false

  constructor(
    readonly maximumBytes: number,
    readonly contentMaximumBytes: number,
  ) {}

  append(value: string, bytes = Buffer.byteLength(value, "utf8")) {
    const next = this.#bytes + bytes
    this.#bytes = next
    // Once the frame is known to be too large, release every retained output
    // chunk but keep counting and traversing. This preserves the exact byte
    // report and lets later circular/BigInt failures retain JSON.stringify's
    // serialization-error precedence without materializing oversized JSON.
    if (this.#overflow) return
    if (next > this.contentMaximumBytes) {
      this.#chunks.length = 0
      this.#pending.length = 0
      this.#pendingBytes = 0
      this.#overflow = true
      return
    }
    if (this.#pendingBytes > 0 && this.#pendingBytes + bytes > JSON_CHUNK_BYTES) this.#flush()
    if (bytes >= JSON_CHUNK_BYTES) this.#chunks.push(value)
    else {
      this.#pending.push(value)
      this.#pendingBytes += bytes
    }
  }

  appendSlice(source: string, start: number, end: number, bytes: number) {
    if (this.#overflow || this.#bytes + bytes > this.contentMaximumBytes) {
      this.append("", bytes)
      return
    }
    this.append(source.slice(start, end), bytes)
  }

  #flush() {
    if (this.#pending.length === 0) return
    this.#chunks.push(this.#pending.join(""))
    this.#pending.length = 0
    this.#pendingBytes = 0
  }

  result() {
    if (this.#overflow)
      throw new EventTooLargeError({
        actualBytes: EVENT_FRAME_OVERHEAD_BYTES + this.#bytes,
        maximumBytes: this.maximumBytes,
      })
    this.#flush()
    return this.#chunks.join("")
  }
}

function utf8CodePointBytes(code: number, next: number | undefined) {
  if (code <= 0x7f) return { bytes: 1, codeUnits: 1 }
  if (code <= 0x7ff) return { bytes: 2, codeUnits: 1 }
  if (code >= 0xd800 && code <= 0xdbff && next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
    return { bytes: 4, codeUnits: 2 }
  }
  return { bytes: 3, codeUnits: 1 }
}

/** Append already-serialized text in bounded UTF-8 chunks. */
function appendRawText(writer: BoundedJsonWriter, value: string) {
  let start = 0
  let index = 0
  let bytes = 0

  const flush = () => {
    if (index === start) return
    writer.appendSlice(value, start, index, bytes)
    start = index
    bytes = 0
  }

  while (index < value.length) {
    const width = utf8CodePointBytes(value.charCodeAt(index), value.charCodeAt(index + 1))
    if (bytes > 0 && bytes + width.bytes > JSON_CHUNK_BYTES) flush()
    bytes += width.bytes
    index += width.codeUnits
  }
  flush()
}

function escapedControlCharacter(code: number) {
  if (code === 0x08) return "\\b"
  if (code === 0x09) return "\\t"
  if (code === 0x0a) return "\\n"
  if (code === 0x0c) return "\\f"
  if (code === 0x0d) return "\\r"
  return `\\u${code.toString(16).padStart(4, "0")}`
}

/** Match JSON.stringify's well-formed string escaping without a large copy. */
function appendJsonString(writer: BoundedJsonWriter, value: string) {
  writer.append('"', 1)
  let rawStart = 0
  let index = 0
  let rawBytes = 0

  const flush = () => {
    if (index === rawStart) return
    writer.appendSlice(value, rawStart, index, rawBytes)
    rawStart = index
    rawBytes = 0
  }

  while (index < value.length) {
    const code = value.charCodeAt(index)
    let escaped: string | undefined
    let codeUnits = 1
    let bytes = 0

    if (code === 0x22) escaped = '\\"'
    else if (code === 0x5c) escaped = "\\\\"
    else if (code <= 0x1f) escaped = escapedControlCharacter(code)
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        codeUnits = 2
        bytes = 4
      } else {
        escaped = `\\u${code.toString(16)}`
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escaped = `\\u${code.toString(16)}`
    } else {
      bytes = utf8CodePointBytes(code, undefined).bytes
    }

    if (escaped !== undefined) {
      flush()
      writer.append(escaped, escaped.length)
      index += 1
      rawStart = index
      continue
    }

    if (rawBytes > 0 && rawBytes + bytes > JSON_CHUNK_BYTES) flush()
    rawBytes += bytes
    index += codeUnits
  }
  flush()
  writer.append('"', 1)
}

function boxedPrimitive(value: object): { readonly matched: boolean; readonly value?: unknown } {
  // Ordinary event objects/arrays have no boxed slot. Avoid four thrown
  // exceptions per value without invoking user getters or coercion hooks.
  if (!types.isBoxedPrimitive(value)) return { matched: false }
  for (const extract of [
    Number.prototype.valueOf,
    String.prototype.valueOf,
    Boolean.prototype.valueOf,
    BigInt.prototype.valueOf,
  ]) {
    try {
      return { matched: true, value: Reflect.apply(extract, value, []) }
    } catch {
      // The intrinsic throws unless this object owns its corresponding slot.
    }
  }
  return { matched: false }
}

type JsonPosition = "top" | "object" | "array"

function boundedJsonStringify(data: unknown, maximumBytes: number) {
  const writer = new BoundedJsonWriter(maximumBytes, maximumBytes - EVENT_FRAME_OVERHEAD_BYTES)
  const ancestors = new Set<object>()
  const rawJson = JSON as typeof JSON & {
    isRawJSON?: (value: unknown) => boolean
  }

  const prepare = (initial: unknown, key: string) => {
    let value = initial
    const initialType = typeof value
    if (
      value !== null &&
      (initialType === "object" || initialType === "function" || initialType === "bigint")
    ) {
      const toJSON = Reflect.get(Object(value), "toJSON")
      if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key])
    }

    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      const boxed = boxedPrimitive(value)
      if (boxed.matched) value = boxed.value
    }
    return value
  }

  const unsupported = (value: unknown) =>
    value === undefined || typeof value === "function" || typeof value === "symbol"

  const serialize = (value: unknown, position: JsonPosition): boolean => {
    if (unsupported(value)) {
      if (position !== "array") return false
      writer.append("null", 4)
      return true
    }
    if (value === null) {
      writer.append("null", 4)
      return true
    }
    if (typeof value === "string") {
      appendJsonString(writer, value)
      return true
    }
    if (typeof value === "number") {
      const encoded = Number.isFinite(value) ? JSON.stringify(value) : "null"
      writer.append(encoded, encoded.length)
      return true
    }
    if (typeof value === "boolean") {
      writer.append(value ? "true" : "false", value ? 4 : 5)
      return true
    }
    if (typeof value === "bigint") throw new TypeError(ENCODING_FAILURE_MESSAGE)

    const object = value as object
    if (rawJson.isRawJSON?.(object)) {
      appendRawText(writer, Reflect.get(object, "rawJSON") as string)
      return true
    }
    if (ancestors.has(object)) throw new TypeError(ENCODING_FAILURE_MESSAGE)
    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        writer.append("[", 1)
        const length = object.length
        for (let index = 0; index < length; index++) {
          if (index > 0) writer.append(",", 1)
          serialize(prepare(Reflect.get(object, String(index)), String(index)), "array")
        }
        writer.append("]", 1)
        return true
      }

      writer.append("{", 1)
      let emitted = 0
      for (const property of Object.keys(object)) {
        const propertyValue = prepare(Reflect.get(object, property), property)
        if (unsupported(propertyValue)) continue
        if (emitted > 0) writer.append(",", 1)
        appendJsonString(writer, property)
        writer.append(":", 1)
        serialize(propertyValue, "object")
        emitted += 1
      }
      writer.append("}", 1)
      return true
    } finally {
      ancestors.delete(object)
    }
  }

  if (!serialize(prepare(data, ""), "top")) return undefined
  return writer.result()
}

/** JSON-encode one SSE message and reject it before the response emits bytes. */
export function encodeJsonEvent(data: unknown, maximumBytes = MAX_EVENT_BYTES) {
  return Effect.try({
    try: () => {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
        throw new EventEncodingError({ message: "maximumBytes must be a positive safe integer" })
      const json = boundedJsonStringify(data, maximumBytes)
      if (json === undefined) throw new EventEncodingError({ message: ENCODING_FAILURE_MESSAGE })
      return eventFrame(json)
    },
    catch: (cause) => {
      if (cause instanceof EventTooLargeError || cause instanceof EventEncodingError) return cause
      return new EventEncodingError({ message: ENCODING_FAILURE_MESSAGE })
    },
  })
}

interface FrameState {
  readonly eventBytes: number
  readonly lineBytes: number
  readonly pendingCarriageReturn: boolean
}

const initialFrameState = (): FrameState => ({
  eventBytes: 0,
  lineBytes: 0,
  pendingCarriageReturn: false,
})

/**
 * Pass through SSE response chunks while bounding every frame before text
 * decoding or line splitting. LF, CRLF, and CR blank-line delimiters reset the
 * counter; an unterminated peer-controlled line is therefore bounded too.
 */
export function boundEventFrames<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maximumBytes = MAX_EVENT_BYTES,
): Stream.Stream<Uint8Array, E | EventTooLargeError | EventEncodingError, R> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    return Stream.fail(new EventEncodingError({ message: "maximumBytes must be a positive safe integer" }))

  return stream.pipe(
    Stream.mapAccumEffect(initialFrameState, (state, chunk) =>
      Effect.gen(function* () {
        let eventBytes = state.eventBytes
        let lineBytes = state.lineBytes
        let pendingCarriageReturn = state.pendingCarriageReturn

        const finishLine = () => {
          if (lineBytes === 0) eventBytes = 0
          lineBytes = 0
          pendingCarriageReturn = false
        }
        const countByte = () => {
          eventBytes += 1
          return eventBytes <= maximumBytes
        }

        for (const byte of chunk) {
          if (pendingCarriageReturn) {
            if (byte === 0x0a) {
              if (!countByte()) return yield* new EventTooLargeError({ actualBytes: eventBytes, maximumBytes })
              finishLine()
              continue
            }
            finishLine()
          }

          if (!countByte()) return yield* new EventTooLargeError({ actualBytes: eventBytes, maximumBytes })
          if (byte === 0x0d) {
            pendingCarriageReturn = true
            continue
          }
          if (byte === 0x0a) {
            finishLine()
            continue
          }
          lineBytes += 1
        }

        return [{ eventBytes, lineBytes, pendingCarriageReturn }, [chunk]] as const
      }),
    ),
  )
}

export * as SseTransport from "./sse"
