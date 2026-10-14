import assert from "node:assert/strict";
import test from "node:test";
import {
  readSessionSnapshot,
  watchSessionEvents,
} from "../../src/transport/client/connection.js";

const connection = {
  url: "http://127.0.0.1:4096",
  generation: "snapshot-generation",
  headers: { authorization: "Basic fixture-credential" },
};
const sessionID = "e3fb2ab8-68d4-4b5d-9286-f5acb0954570";
const snapshot = {
  data: {
    session: { id: sessionID },
    messages: { data: [], cursor: {} },
    after: 4,
  },
};

function fixture(
  overrides: {
    capabilities?: string[];
    generation?: string;
    state?: "running" | "draining";
    snapshot?: unknown;
    status?: number;
  } = {},
) {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (request: Request) => {
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/capabilities")
        return Response.json({
          protocol: "phins.local-api.v1",
          capabilities: overrides.capabilities ?? [
            "session.snapshot.durable.v1",
            "session.events.durable.v1",
          ],
          nodeControl: false,
        });
      if (pathname === "/api/service")
        return Response.json({
          mode: "managed",
          id: overrides.generation ?? connection.generation,
          state: overrides.state ?? "running",
        });
      if (pathname === `/api/session/${sessionID}/snapshot`)
        return Response.json(overrides.snapshot ?? snapshot, {
          status: overrides.status ?? 200,
        });
      if (pathname === `/api/session/${sessionID}/event`)
        return new Response(
          `data: ${JSON.stringify({
            id: "evt_after_snapshot",
            type: "session.next.synthetic",
            data: { sessionID, text: "committed during attach" },
            durable: { aggregateID: sessionID, seq: 5, version: 1 },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      throw new Error("Unexpected snapshot request");
    },
  };
}

test("snapshot negotiates read-only during drain and fences the bounded request by generation", async () => {
  const fx = fixture({ state: "draining" });
  assert.deepEqual(
    await readSessionSnapshot(connection, { sessionID }, { fetch: fx.fetch }),
    snapshot,
  );
  assert.deepEqual(
    fx.requests.map((request) => new URL(request.url).pathname),
    ["/api/capabilities", "/api/service", `/api/session/${sessionID}/snapshot`],
  );
  assert.equal(new URL(fx.requests[2]!.url).searchParams.get("limit"), "20");
  assert.equal(
    new URL(fx.requests[2]!.url).searchParams.get("generation"),
    connection.generation,
  );
  assert.equal(fx.requests[2]!.cache, "no-store");
  for (const request of fx.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.equal(
      request.headers.get("authorization"),
      connection.headers.authorization,
    );
  }
});

test("snapshot captures session, limit and generation before asynchronous discovery", async () => {
  const fx = fixture();
  const target = { ...connection };
  const input = { sessionID, limit: 1 };
  await readSessionSnapshot(target, input, {
    fetch: async (request) => {
      input.sessionID = "ses_replaced";
      input.limit = 200;
      target.generation = "replaced-generation";
      return fx.fetch(request);
    },
  });
  const query = new URL(fx.requests[2]!.url).searchParams;
  assert.equal(query.get("limit"), "1");
  assert.equal(query.get("generation"), connection.generation);
});

test("missing capability or changed identity rejects snapshot without legacy fallback", async () => {
  const missing = fixture({ capabilities: ["session.events.durable.v1"] });
  await assert.rejects(
    readSessionSnapshot(connection, { sessionID }, { fetch: missing.fetch }),
    /missing capability/,
  );
  assert.equal(missing.requests.length, 1);
  const changed = fixture({ generation: "replacement-generation" });
  await assert.rejects(
    readSessionSnapshot(connection, { sessionID }, { fetch: changed.fetch }),
    /generation changed/,
  );
  assert.equal(changed.requests.length, 2);
});

test("snapshot validates input before network I/O", async () => {
  const fx = fixture();
  for (const input of [
    { sessionID: "" },
    ...[0, -1, 201, 1.5, NaN, Infinity].map((limit) => ({ sessionID, limit })),
  ])
    await assert.rejects(
      readSessionSnapshot(connection, input, { fetch: fx.fetch }),
    );
  assert.equal(fx.requests.length, 0);
});

test("snapshot rejects malformed cursors, history and cross-session metadata", async () => {
  for (const data of [
    {},
    { ...snapshot.data, session: { id: "ses_other" } },
    { ...snapshot.data, after: -2 },
    { ...snapshot.data, after: 0.5 },
    { ...snapshot.data, after: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot.data, messages: { data: "not an array", cursor: {} } },
    { ...snapshot.data, messages: { data: [{}, {}], cursor: {} } },
    { ...snapshot.data, messages: { data: [], cursor: [] } },
    { ...snapshot.data, messages: { data: [], cursor: { next: 5 } } },
    { ...snapshot.data, runState: { sessionID: "ses_other" } },
  ]) {
    const fx = fixture({ snapshot: { data } });
    await assert.rejects(
      readSessionSnapshot(
        connection,
        { sessionID, limit: 1 },
        { fetch: fx.fetch },
      ),
      /invalid session snapshot/,
    );
    assert.equal(fx.requests.length, 3);
  }
});

test("snapshot HTTP failures are surfaced once and never trigger a mutation or retry", async () => {
  for (const status of [400, 401, 404, 409, 500, 503]) {
    const fx = fixture({ status, snapshot: { message: "fixture failure" } });
    await assert.rejects(
      readSessionSnapshot(connection, { sessionID }, { fetch: fx.fetch }),
    );
    assert.equal(fx.requests.length, 3);
    assert.equal(
      fx.requests.every((request) => request.method === "GET"),
      true,
    );
  }
});

test("aborting a snapshot cancels only the read transport", async () => {
  const fx = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const read = readSessionSnapshot(
    connection,
    { sessionID },
    {
      signal: controller.signal,
      fetch: (request) => {
        if (!request.url.includes("/snapshot?")) return fx.fetch(request);
        fx.requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
          started();
        });
      },
    },
  );
  await ready;
  controller.abort(new Error("fixture read cancelled"));
  await assert.rejects(read, /fixture read cancelled/);
  assert.equal(fx.requests.length, 3);
  assert.equal(fx.requests[2]!.signal.aborted, true);
  assert.equal(
    fx.requests.every((request) => request.method === "GET"),
    true,
  );
});

test("a snapshot cursor attaches to the existing durable feed without replaying history", async () => {
  const fx = fixture();
  const result = await readSessionSnapshot(
    connection,
    { sessionID },
    { fetch: fx.fetch },
  );
  const stream = watchSessionEvents(
    connection,
    { sessionID, after: result.data.after },
    { fetch: fx.fetch, reconnects: 0 },
  );
  try {
    assert.equal((await stream.next()).value?.durable.seq, 5);
  } finally {
    await stream.return();
  }
  assert.equal(new URL(fx.requests[5]!.url).searchParams.get("after"), "4");
  assert.equal(
    fx.requests.every((request) => request.method === "GET"),
    true,
  );
});
