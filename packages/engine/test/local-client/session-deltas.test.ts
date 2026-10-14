import assert from "node:assert/strict";
import test from "node:test";
import { watchSessionDeltas } from "../../src/transport/client/connection.js";

const sessionID = "ses_live_fixture";
const connection = {
  url: "http://127.0.0.1:4096",
  generation: "fixture-generation",
  headers: { authorization: "Basic fixture-credential" },
};
const reset = { type: "session.live.reset", sessionID };
const delta = (text = "Tiếng Việt 🐈", type = "session.next.text.delta") => ({
  type: "session.live.delta",
  event: {
    id: "evt_live_fixture",
    type,
    data: {
      sessionID,
      timestamp: 1,
      assistantMessageID: "ses_message_fixture",
      ...(type === "session.next.text.delta"
        ? { textID: "text" }
        : type === "session.next.reasoning.delta"
          ? { reasoningID: "reasoning" }
          : { callID: "tool" }),
      delta: text,
    },
  },
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const bytes = (value: string) => new TextEncoder().encode(value);

function response(
  chunks: Array<string | Uint8Array>,
  options: { open?: boolean; cancel?: () => void } = {},
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(typeof chunk === "string" ? bytes(chunk) : chunk);
        if (!options.open) controller.close();
      },
      cancel: options.cancel,
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function fixture(
  feed: (index: number, request: Request) => Response,
  options: {
    missingCapability?: boolean;
    replaced?: boolean;
    draining?: boolean;
  } = {},
) {
  const requests: Request[] = [];
  let streams = 0;
  let discoveries = 0;
  return {
    requests,
    fetch: async (request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/capabilities")
        return Response.json({
          protocol: "phins.local-api.v1",
          capabilities: options.missingCapability
            ? []
            : ["session.deltas.live.v1"],
          nodeControl: false,
        });
      if (path === "/api/service")
        return Response.json({
          mode: "managed",
          id:
            options.replaced && discoveries++ > 0
              ? "replacement"
              : connection.generation,
          state: options.draining ? "draining" : "running",
        });
      assert.equal(path, `/api/session/${sessionID}/delta`);
      return feed(streams++, request);
    },
  };
}

async function take<T>(source: AsyncIterable<T>, count: number) {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
    if (values.length === count) break;
  }
  return values;
}

test("live feed negotiates its capability and emits reset plus three isolated delta types", async () => {
  const events = [
    reset,
    delta(),
    delta("thought", "session.next.reasoning.delta"),
    delta('{"file":', "session.next.tool.input.delta"),
  ];
  const backend = fixture(() => response(events.map(frame), { open: true }), {
    draining: true,
  });
  assert.deepEqual(
    await take(watchSessionDeltas(connection, { sessionID }, backend), 4),
    events,
  );
  for (const request of backend.requests) {
    assert.equal(request.method, "GET");
    assert.equal(
      request.headers.get("authorization"),
      connection.headers.authorization,
    );
    assert.equal(request.redirect, "error");
  }
  const url = new URL(backend.requests.at(-1)!.url);
  assert.equal(url.searchParams.get("generation"), connection.generation);
  assert.equal(url.searchParams.has("after"), false);
});

test("live decoder shares strict split UTF-8 and CRLF framing without a durable cursor", async () => {
  const content = bytes(
    ": heartbeat\r\n\r\n" +
      frame(reset).replaceAll("\n", "\r\n") +
      frame(delta()),
  );
  const backend = fixture(() =>
    response(
      Array.from(content, (byte) => Uint8Array.of(byte)),
      { open: true },
    ),
  );
  assert.deepEqual(
    await take(watchSessionDeltas(connection, { sessionID }, backend), 2),
    [reset, delta()],
  );
});

test("EOF reconnects with a new reset, never a token cursor or replayed command", async () => {
  const backend = fixture((index) =>
    index === 0
      ? response([frame(reset), frame(delta("old draft"))])
      : response([frame(reset), frame(delta("new draft"))], { open: true }),
  );
  assert.deepEqual(
    await take(
      watchSessionDeltas(
        connection,
        { sessionID },
        { ...backend, reconnectDelayMs: 0 },
      ),
      4,
    ),
    [reset, delta("old draft"), reset, delta("new draft")],
  );
  assert.equal(
    backend.requests.filter(
      (request) => new URL(request.url).pathname === "/api/capabilities",
    ).length,
    2,
  );
  assert.ok(
    backend.requests.every(
      (request) =>
        request.method === "GET" &&
        !new URL(request.url).searchParams.has("after"),
    ),
  );
});

test("overflow emits an explicit gap, then retries read-only with a fresh reset", async () => {
  const gap = { type: "session.live.gap", sessionID };
  const backend = fixture((index) =>
    index === 0
      ? response([frame(reset), frame(gap)], { open: true })
      : response([frame(reset), frame(delta())], { open: true }),
  );
  assert.deepEqual(
    await take(
      watchSessionDeltas(
        connection,
        { sessionID },
        { ...backend, reconnectDelayMs: 0 },
      ),
      4,
    ),
    [reset, gap, reset, delta()],
  );
});

for (const [name, invalid] of [
  ["delta before reset", delta()],
  ["foreign reset", { ...reset, sessionID: "ses_other" }],
  ["duplicate reset", reset],
  ["foreign gap", { type: "session.live.gap", sessionID: "ses_other" }],
  [
    "foreign delta",
    {
      ...delta(),
      event: {
        ...delta().event,
        data: { ...delta().event.data, sessionID: "ses_other" },
      },
    },
  ],
  [
    "durable cursor on a live delta",
    {
      ...delta(),
      event: {
        ...delta().event,
        durable: { aggregateID: sessionID, seq: 0, version: 1 },
      },
    },
  ],
  ["invalid token type", delta("bad", "session.next.compaction.delta")],
  [
    "invalid token data",
    {
      ...delta(),
      event: { ...delta().event, data: { ...delta().event.data, delta: 7 } },
    },
  ],
  ["null frame", null],
] as const) {
  test(`rejects ${name} without reconnect or side effects`, async () => {
    const backend = fixture(() =>
      response(
        name === "delta before reset"
          ? [frame(invalid)]
          : [frame(reset), frame(invalid)],
      ),
    );
    await assert.rejects(async () => {
      for await (const _ of watchSessionDeltas(
        connection,
        { sessionID },
        { ...backend, reconnectDelayMs: 0 },
      )) {
      }
    }, /invalid live session|must start with a session reset/);
    assert.equal(backend.requests.length, 3);
    assert.ok(backend.requests.every((request) => request.method === "GET"));
  });
}

test("refuses a missing live capability before opening a stream", async () => {
  const backend = fixture(
    () => {
      throw new Error("must not open");
    },
    { missingCapability: true },
  );
  await assert.rejects(async () => {
    for await (const _ of watchSessionDeltas(
      connection,
      { sessionID },
      backend,
    )) {
    }
  }, /missing capability: session.deltas.live.v1/);
  assert.equal(backend.requests.length, 1);
});

test("generation replacement is terminal before reopening a token stream", async () => {
  const backend = fixture(() => response([frame(reset)]), { replaced: true });
  const source = watchSessionDeltas(
    connection,
    { sessionID },
    { ...backend, reconnectDelayMs: 0 },
  );
  assert.deepEqual((await source.next()).value, reset);
  await assert.rejects(source.next(), /generation changed/);
  assert.equal(
    backend.requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/delta"),
    ).length,
    1,
  );
});

test("generation admission conflict and wrong content type do not reconnect", async () => {
  for (const result of [
    new Response("replaced", { status: 409 }),
    new Response("not SSE"),
  ]) {
    const backend = fixture(() => result);
    await assert.rejects(async () => {
      for await (const _ of watchSessionDeltas(
        connection,
        { sessionID },
        backend,
      )) {
      }
    }, /409|did not return an SSE/);
    assert.equal(backend.requests.length, 3);
  }
});

test("abort cancels only the subscription while blocked on tokens", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const backend = fixture(() =>
    response([frame(reset)], {
      open: true,
      cancel: () => {
        cancelled = true;
      },
    }),
  );
  const source = watchSessionDeltas(
    connection,
    { sessionID },
    { ...backend, signal: controller.signal },
  );
  assert.deepEqual((await source.next()).value, reset);
  const pending = source.next();
  controller.abort(new Error("fixture abort"));
  await assert.rejects(pending, /fixture abort/);
  assert.equal(cancelled, true);
  assert.ok(backend.requests.every((request) => request.method === "GET"));
});

test("breaking early releases the reader and does not interrupt the session", async () => {
  let cancelled = false;
  const backend = fixture(() =>
    response([frame(reset), frame(delta())], {
      open: true,
      cancel: () => {
        cancelled = true;
      },
    }),
  );
  assert.deepEqual(
    await take(watchSessionDeltas(connection, { sessionID }, backend), 1),
    [reset],
  );
  assert.equal(cancelled, true);
  assert.equal(backend.requests.length, 3);
});

test("total retry budget bounds repeated EOF and retries only GET requests", async () => {
  const backend = fixture(() => response([frame(reset)]));
  const received: unknown[] = [];
  await assert.rejects(async () => {
    for await (const value of watchSessionDeltas(
      connection,
      { sessionID },
      { ...backend, reconnects: 1, reconnectDelayMs: 0 },
    ))
      received.push(value);
  }, /connection ended/);
  assert.deepEqual(received, [reset, reset]);
  assert.equal(backend.requests.length, 6);
  assert.ok(backend.requests.every((request) => request.method === "GET"));
});

test("invalid live watch arguments fail before discovery", async () => {
  for (const [input, options] of [
    [{ sessionID: "" }, {}],
    [{ sessionID }, { reconnects: 11 }],
    [{ sessionID }, { reconnectDelayMs: -1 }],
  ] as const) {
    let fetched = false;
    await assert.rejects(async () => {
      for await (const _ of watchSessionDeltas(connection, input, {
        ...options,
        fetch: async () => {
          fetched = true;
          throw new Error("unexpected fetch");
        },
      })) {
      }
    });
    assert.equal(fetched, false);
  }
});
