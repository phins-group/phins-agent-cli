/** Strict, bounded SSE decoding for opt-in local session feeds. */
import type { SessionLiveFrame, V2Event } from "./generated/types.gen.js";

export type { SessionLiveFrame } from "./generated/types.gen.js";

export type DurableSessionEvent = V2Event & {
  durable: { aggregateID: string; seq: number; version: number };
};

export class SessionEventConnectionError extends Error {}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Cancelling the reader only releases this subscription, never session work. */
export async function* readSessionEvents(
  body: ReadableStream<Uint8Array>,
  sessionID: string,
  after: number,
  signal: AbortSignal,
): AsyncGenerator<DurableSessionEvent> {
  let sequence = after;
  for await (const value of readSessionFrames(body, signal)) {
    const event = value as DurableSessionEvent;
    if (
      event === null ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      !event.id.startsWith("evt_") ||
      typeof event.type !== "string" ||
      !event.type ||
      event.data === null ||
      typeof event.data !== "object" ||
      Array.isArray(event.data) ||
      event.durable?.aggregateID !== sessionID ||
      !Number.isSafeInteger(event.durable.seq) ||
      event.durable.seq !== sequence + 1 ||
      !Number.isSafeInteger(event.durable.version) ||
      event.durable.version < 1
    )
      throw new Error(
        "Node Service returned an invalid session event or sequence gap",
      );
    sequence = event.durable.seq;
    yield event;
  }
}

export async function* readSessionDeltas(
  body: ReadableStream<Uint8Array>,
  sessionID: string,
  signal: AbortSignal,
): AsyncGenerator<SessionLiveFrame> {
  let ready = false;
  for await (const value of readSessionFrames(body, signal)) {
    const frame = value as SessionLiveFrame;
    if (frame === null || typeof frame !== "object" || Array.isArray(frame))
      throw new Error("Node Service returned an invalid live session frame");
    if (
      frame.type === "session.live.reset" &&
      frame.sessionID === sessionID &&
      !ready
    ) {
      ready = true;
      yield frame;
      continue;
    }
    if (!ready)
      throw new Error(
        "Node Service token stream must start with a session reset",
      );
    if (frame.type === "session.live.gap" && frame.sessionID === sessionID) {
      yield frame;
      throw new SessionEventConnectionError(
        "Node Service live token queue overflowed",
      );
    }
    if (frame.type !== "session.live.delta")
      throw new Error("Node Service returned an invalid live session frame");
    const event = frame.event;
    const data = event?.data;
    if (
      event === null ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof event.id !== "string" ||
      !event.id.startsWith("evt_") ||
      "durable" in event ||
      "metadata" in event ||
      "location" in event ||
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.sessionID !== sessionID ||
      !Number.isFinite(data.timestamp) ||
      typeof data.assistantMessageID !== "string" ||
      !data.assistantMessageID ||
      typeof data.delta !== "string" ||
      !(
        (event.type === "session.next.text.delta" &&
          typeof event.data.textID === "string") ||
        (event.type === "session.next.reasoning.delta" &&
          typeof event.data.reasoningID === "string") ||
        (event.type === "session.next.tool.input.delta" &&
          typeof event.data.callID === "string")
      )
    )
      throw new Error("Node Service returned an invalid live session delta");
    yield frame;
  }
}

/** Framing is shared; durable sequence checks and live reset checks stay separate. */
async function* readSessionFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let frameBytes = 0;
  let lineBytes = 0;
  let pendingCR = false;
  let skipLF = false;
  let line = "";
  let data: string[] = [];
  let eventType = "";

  const bound = (chunk: Uint8Array) => {
    const finishLine = () => {
      if (lineBytes === 0) frameBytes = 0;
      lineBytes = 0;
      pendingCR = false;
    };
    for (const byte of chunk) {
      if (pendingCR && byte !== 10) finishLine();
      if (++frameBytes > MAX_FRAME_BYTES)
        throw new Error("Node Service event exceeds the 16 MiB frame limit");
      if (pendingCR) finishLine();
      else if (byte === 13) pendingCR = true;
      else if (byte === 10) finishLine();
      else lineBytes++;
    }
  };
  const finishLine = (): { value: unknown } | undefined => {
    const value = line;
    line = "";
    if (value === "") {
      const fields = data;
      data = [];
      const type = eventType;
      eventType = "";
      if (fields.length === 0) return;
      if (type && type !== "message")
        throw new Error("Node Service returned an unexpected SSE event type");
      try {
        return { value: JSON.parse(fields.join("\n")) };
      } catch {
        throw new Error("Node Service returned invalid event JSON");
      }
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const name = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (name === "data") data.push(content);
    else if (name === "event") eventType = content;
  };
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (cause) {
        signal.throwIfAborted();
        throw new SessionEventConnectionError(
          "Node Service event connection was lost",
          { cause },
        );
      }
      signal.throwIfAborted();
      if (next.done) {
        // Validate UTF-8, but do not acknowledge an unterminated SSE frame.
        decoder.decode();
        return;
      }
      // Bound raw bytes before decoding; never accumulate an unbounded frame.
      for (let offset = 0; offset < next.value.length; offset += 8192) {
        const chunk = next.value.subarray(offset, offset + 8192);
        bound(chunk);
        const text = decoder.decode(chunk, { stream: true });
        let start = 0;
        for (let index = 0; index < text.length; index++) {
          const char = text[index];
          if (skipLF) {
            skipLF = false;
            if (char === "\n") {
              start = index + 1;
              continue;
            }
          }
          if (char !== "\r" && char !== "\n") continue;
          line += text.slice(start, index);
          const event = finishLine();
          start = index + 1;
          skipLF = char === "\r";
          if (event) yield event.value;
        }
        line += text.slice(start);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
