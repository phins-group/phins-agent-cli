import assert from "node:assert/strict";
import test from "node:test";
import { watchSessionEvents } from "../../src/transport/client/connection.js";

const sessionID = "ses_events";
const connection = {
  url: "http://127.0.0.1:4096",
  generation: "fixture-generation",
  headers: { authorization: "Basic fixture-credential" },
};
const event = (seq: number, aggregateID = sessionID) => ({
  id: `evt_fixture_${seq}`,
  type: "session.next.prompt.admitted",
  durable: { aggregateID, seq, version: 1 },
  data: {
    sessionID: aggregateID,
    timestamp: seq,
    prompt: { text: "Tiếng Việt 🐈" },
  },
});
const frame = (value: unknown) =>
  `event: message\ndata: ${JSON.stringify(value)}\n\n`;
const bytes = (text: string) => new TextEncoder().encode(text);

function stream(
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
  response: (index: number, request: Request) => Response | Promise<Response>,
  options: {
    sessionID?: string;
    replaced?: boolean;
    missingCapability?: boolean;
    draining?: boolean;
  } = {},
) {
  const requests: Request[] = [];
  let connections = 0;
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
            : ["session.events.durable.v1"],
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
      assert.equal(
        path,
        `/api/session/${options.sessionID ?? sessionID}/event`,
      );
      return response(connections++, request);
    },
  };
}

async function take<T>(source: AsyncIterable<T>, count: number) {
  const result: T[] = [];
  for await (const value of source) {
    result.push(value);
    if (result.length === count) break;
  }
  return result;
}

test("durable watch reconnects from the last complete sequence using authenticated GETs only", async () => {
  const fx = fixture((index) =>
    index === 0
      ? stream([
          ": connected\n\n",
          frame(event(0)),
          `data: ${JSON.stringify(event(1)).slice(0, -5)}`,
        ])
      : stream([frame(event(1))]),
  );
  const actual = await take(
    watchSessionEvents(
      connection,
      { sessionID },
      { fetch: fx.fetch, reconnectDelayMs: 0 },
    ),
    2,
  );
  assert.deepEqual(actual, [event(0), event(1)]);
  const feeds = fx.requests.filter((request) =>
    request.url.includes("/event?"),
  );
  assert.deepEqual(
    feeds.map((request) => new URL(request.url).searchParams.get("after")),
    ["-1", "0"],
  );
  assert.equal(
    fx.requests.filter((request) => request.url.endsWith("/api/service"))
      .length,
    2,
  );
  for (const request of fx.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.equal(
      request.headers.get("authorization"),
      "Basic fixture-credential",
    );
  }
  assert.ok(
    feeds.every(
      (request) =>
        new URL(request.url).searchParams.get("generation") ===
        connection.generation,
    ),
  );
});

test("UTF-8, CRLF split across chunks, comments and multiline JSON preserve one event", async () => {
  const payload = JSON.stringify(event(1), null, 2)
    .split("\n")
    .map((line) => `data: ${line}\r\n`)
    .join("");
  const wire = bytes(`: keepalive\r\n\r\nevent: message\r\n${payload}\r\n`);
  const fx = fixture(() =>
    stream(Array.from(wire, (byte) => Uint8Array.of(byte))),
  );
  assert.deepEqual(
    await take(
      watchSessionEvents(
        connection,
        { sessionID, after: 0 },
        { fetch: fx.fetch },
      ),
      1,
    ),
    [event(1)],
  );
});

test("watch accepts UUID session IDs created by V2 as well as legacy IDs", async () => {
  const id = "bb30943e-a2f6-46a6-9150-2d1b59c99166";
  const fx = fixture(() => stream([frame(event(0, id))]), { sessionID: id });
  assert.deepEqual(
    await take(
      watchSessionEvents(connection, { sessionID: id }, { fetch: fx.fetch }),
      1,
    ),
    [event(0, id)],
  );
});

test("returning after one event cancels and unlocks the reader, without interrupting session work", async () => {
  let cancelled = 0;
  const response = stream([frame(event(0)), frame(event(1))], {
    open: true,
    cancel: () => cancelled++,
  });
  const fx = fixture(() => response, { draining: true });
  assert.deepEqual(
    await take(
      watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }),
      1,
    ),
    [event(0)],
  );
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
  assert.equal(fx.requests.at(-1)!.signal.aborted, true);
  assert.ok(fx.requests.every((request) => request.method === "GET"));
});

test("watch stops on replaced generation before opening another feed", async () => {
  const fx = fixture(() => stream([frame(event(0))]), { replaced: true });
  const identity = { ...connection };
  const target = { sessionID };
  const watched = watchSessionEvents(identity, target, {
    fetch: fx.fetch,
    reconnectDelayMs: 0,
  });
  assert.equal((await watched.next()).value?.durable.seq, 0);
  identity.generation = "replacement";
  target.sessionID = "ses_other";
  await assert.rejects(watched.next(), /generation changed/);
  assert.equal(
    fx.requests.filter((request) => request.url.includes("/event?")).length,
    1,
  );
});

test("missing capability fails before the feed and does not fall back to global events", async () => {
  const fx = fixture(
    () => {
      throw new Error("unexpected feed");
    },
    { missingCapability: true },
  );
  await assert.rejects(
    watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }).next(),
    /missing capability/,
  );
  assert.equal(fx.requests.length, 1);
});

test("auth, missing session, cursor and admission-generation errors are terminal", async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const fx = fixture(() =>
      Response.json({ message: "fixture rejection" }, { status }),
    );
    await assert.rejects(
      watchSessionEvents(
        connection,
        { sessionID },
        { fetch: fx.fetch, reconnectDelayMs: 0 },
      ).next(),
      new RegExp(`\\(${status}\\)`),
    );
    assert.equal(fx.requests.length, 3);
  }
});

test("transient feed failures have a finite reconnect budget and never repeat a mutation", async () => {
  const fx = fixture(() => new Response(null, { status: 503 }));
  await assert.rejects(
    watchSessionEvents(
      connection,
      { sessionID },
      { fetch: fx.fetch, reconnects: 2, reconnectDelayMs: 0 },
    ).next(),
    /503/,
  );
  assert.equal(fx.requests.length, 9);
  assert.ok(fx.requests.every((request) => request.method === "GET"));
});

test("network and discovery failures consume the same reconnect budget", async () => {
  const requests: Request[] = [];
  await assert.rejects(
    watchSessionEvents(
      connection,
      { sessionID },
      {
        reconnects: 2,
        reconnectDelayMs: 0,
        fetch: async (request) => {
          requests.push(request);
          throw new Error("fixture offline");
        },
      },
    ).next(),
    /fixture offline/,
  );
  assert.equal(requests.length, 3);
});

test("bad content types and redirects fail closed without reconnecting", async () => {
  for (const response of [
    Response.json(event(0)),
    new Response(null, { headers: { "content-type": "text/event-stream" } }),
    new Response(null, {
      status: 302,
      headers: { location: "http://outside.test/" },
    }),
  ]) {
    const fx = fixture(() => response);
    await assert.rejects(
      watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }).next(),
    );
    assert.equal(fx.requests.length, 3);
  }
});

test("malformed JSON, cross-session envelopes and sequence gaps never advance the cursor", async () => {
  for (const wire of [
    "data: not json\n\n",
    frame(null),
    frame({}),
    frame(event(0, "ses_other")),
    frame(event(1)),
    frame({ ...event(0), durable: undefined }),
    frame({ ...event(0), durable: { ...event(0).durable, seq: 0.5 } }),
    frame({ ...event(0), durable: { ...event(0).durable, version: 0 } }),
    `event: other\n${frame(event(0)).replace("event: message\n", "")}`,
  ]) {
    const fx = fixture(() => stream([wire]));
    await assert.rejects(
      watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }).next(),
    );
    assert.equal(fx.requests.length, 3);
  }
  const fx = fixture(() => stream([frame(event(0)), frame(event(0))]));
  const watched = watchSessionEvents(
    connection,
    { sessionID },
    { fetch: fx.fetch },
  );
  await watched.next();
  await assert.rejects(watched.next(), /sequence gap/);
  assert.equal(fx.requests.length, 3);
});

test("invalid or truncated UTF-8 is rejected without a reconnect loop", async () => {
  for (const chunk of [Uint8Array.of(0xff), Uint8Array.of(0xe2, 0x82)]) {
    const fx = fixture(() => stream([chunk]));
    await assert.rejects(
      watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }).next(),
    );
    assert.equal(fx.requests.length, 3);
  }
});

test("unterminated oversized frames are bounded before JSON parsing", async () => {
  const fx = fixture(() => stream(["data: " + "x".repeat(16 * 1024 * 1024)]));
  await assert.rejects(
    watchSessionEvents(connection, { sessionID }, { fetch: fx.fetch }).next(),
    /16 MiB/,
  );
  assert.equal(fx.requests.length, 3);
});

test("aborting a pending reader releases the subscription and sends no interrupt", async () => {
  let ready!: () => void;
  const reading = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let cancelled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          ready();
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "text/event-stream" } },
  );
  const controller = new AbortController();
  const fx = fixture(() => response);
  const pending = watchSessionEvents(
    connection,
    { sessionID },
    { fetch: fx.fetch, signal: controller.signal },
  ).next();
  await reading;
  controller.abort(new Error("fixture caller cancelled"));
  await assert.rejects(pending, /fixture caller cancelled/);
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
  assert.ok(fx.requests.every((request) => request.method === "GET"));
});

test("invalid cursor and reconnect options fail before transport", async () => {
  for (const invalid of [-2, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const fx = fixture(() => {
      throw new Error("unexpected feed");
    });
    await assert.rejects(
      watchSessionEvents(
        connection,
        { sessionID, after: invalid },
        { fetch: fx.fetch },
      ).next(),
      /cursor/,
    );
    assert.equal(fx.requests.length, 0);
  }
  for (const reconnects of [-1, 1.5, 11]) {
    const fx = fixture(() => {
      throw new Error("unexpected feed");
    });
    await assert.rejects(
      watchSessionEvents(
        connection,
        { sessionID },
        { fetch: fx.fetch, reconnects },
      ).next(),
      /budget/,
    );
    assert.equal(fx.requests.length, 0);
  }
});
