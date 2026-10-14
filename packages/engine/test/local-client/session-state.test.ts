import assert from "node:assert/strict";
import test from "node:test";
import {
  watchSessionState,
  type SessionClientState,
} from "../../src/transport/client/session-state.js";

const sessionID = "ses_state_fixture";
const assistantMessageID = "ses_message_fixture";
const connection = {
  url: "http://127.0.0.1:4096",
  generation: "state-generation",
  headers: { authorization: "Basic fixture-credential" },
};
const reset = { type: "session.live.reset", sessionID };
type Kind = "text" | "reasoning" | "tool-input";
const prefix = (kind: Kind) =>
  kind === "tool-input" ? "session.next.tool.input" : `session.next.${kind}`;
const field = (kind: Kind) =>
  kind === "text" ? "textID" : kind === "reasoning" ? "reasoningID" : "callID";
const part = (kind: Kind, id = "part", text = "") =>
  kind === "tool-input"
    ? {
        type: "tool",
        id,
        name: "read",
        time: { created: 1 },
        state: { status: "pending", input: text },
      }
    : { type: kind, id, text };
const snapshot = (after = -1, content: unknown[] = [], completed?: number) => ({
  data: {
    session: { id: sessionID },
    after,
    messages: {
      data: [
        {
          id: assistantMessageID,
          type: "assistant",
          agent: "fixture",
          model: { id: "fixture", providerID: "fixture" },
          time: {
            created: 1,
            ...(completed === undefined ? {} : { completed }),
          },
          content,
        },
      ],
      cursor: {},
    },
  },
});
const event = (
  seq: number,
  kind: Kind,
  action: "started" | "ended",
  id = "part",
  text = "",
) => ({
  id: `evt_${seq}`,
  type: `${prefix(kind)}.${action}`,
  data: {
    sessionID,
    timestamp: 1,
    assistantMessageID,
    [field(kind)]: id,
    text,
  },
  durable: { aggregateID: sessionID, seq, version: 1 },
});
const delta = (
  kind: Kind,
  text = "draft",
  id = "part",
  assistant = assistantMessageID,
) => ({
  type: "session.live.delta",
  event: {
    id: "evt_delta",
    type: `${prefix(kind)}.delta`,
    data: {
      sessionID,
      timestamp: 1,
      assistantMessageID: assistant,
      [field(kind)]: id,
      delta: text,
    },
  },
});

function feed() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let ready!: () => void;
  let cancels = 0;
  const opened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  return {
    opened,
    get cancels() {
      return cancels;
    },
    response() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          writer = controller;
          ready();
        },
        cancel() {
          cancels++;
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    send(value: unknown) {
      writer.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
      );
    },
    close() {
      writer.close();
    },
  };
}

function fixture() {
  const requests: Request[] = [];
  const events = [feed(), feed()];
  const live = [feed(), feed()];
  let eventIndex = 0;
  let liveIndex = 0;
  return {
    requests,
    events,
    live,
    current: snapshot(),
    generation: connection.generation,
    capabilities: [
      "session.snapshot.durable.v1",
      "session.events.durable.v1",
      "session.deltas.live.v1",
    ],
    state: "running",
    onSnapshot: undefined as
      | undefined
      | ((request: Request) => Promise<Response>),
    get reads() {
      return requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/snapshot"),
      ).length;
    },
    async fetch(request: Request) {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/capabilities")
        return Response.json({
          protocol: "phins.local-api.v1",
          capabilities: this.capabilities,
          nodeControl: false,
        });
      if (url.pathname === "/api/service")
        return Response.json({
          mode: "managed",
          id: this.generation,
          state: this.state,
        });
      assert.equal(url.searchParams.get("generation"), connection.generation);
      if (url.pathname === `/api/session/${sessionID}/snapshot`)
        return this.onSnapshot
          ? this.onSnapshot(request)
          : Response.json(this.current);
      if (url.pathname === `/api/session/${sessionID}/event`)
        return events[eventIndex++]!.response();
      assert.equal(url.pathname, `/api/session/${sessionID}/delta`);
      return live[liveIndex++]!.response();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Watch = ReturnType<typeof watchSessionState>;

async function next(watch: Watch) {
  const result = await watch.next();
  assert.equal(result.done, false);
  return result.value as SessionClientState;
}

async function observing(
  backend: Fixture,
  run: (
    watch: Watch,
    controller: AbortController,
    initial: SessionClientState,
  ) => Promise<void>,
) {
  const controller = new AbortController();
  const watch = watchSessionState(
    connection,
    { sessionID },
    {
      fetch: backend.fetch.bind(backend),
      signal: controller.signal,
      reconnects: 1,
      reconnectDelayMs: 0,
    },
  );
  try {
    const initial = await next(watch);
    assert.equal(initial.reason, "snapshot");
    await Promise.all([backend.events[0]!.opened, backend.live[0]!.opened]);
    backend.live[0]!.send(reset);
    assert.equal((await next(watch)).reason, "reset");
    await run(watch, controller, initial);
  } finally {
    controller.abort();
    await watch.return();
    for (const request of backend.requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      assert.equal(
        request.headers.get("authorization"),
        connection.headers.authorization,
      );
    }
    assert.equal(backend.events[0]!.cancels, 1);
    for (const request of backend.requests)
      if (/\/(event|delta)\?/.test(request.url))
        assert.equal(request.signal.aborted, true);
  }
}

async function open(
  backend: Fixture,
  watch: Watch,
  kind: Kind,
  seq = 0,
  id = "part",
) {
  backend.current = snapshot(seq, [part(kind, id)]);
  backend.events[0]!.send(event(seq, kind, "started", id));
  assert.equal((await next(watch)).reason, "event");
}

for (const kind of ["text", "reasoning", "tool-input"] as const) {
  test(`${kind} drafts stay separate and full-value settlement replaces, never appends`, async () => {
    const backend = fixture();
    backend.state = "draining";
    await observing(backend, async (watch) => {
      await open(backend, watch, kind);
      const reads = backend.reads;
      backend.live[0]!.send(delta(kind, "Tiếng Việt 🐈"));
      const first = await next(watch);
      assert.equal(first.reason, "delta");
      assert.deepEqual(first.drafts, [
        {
          kind,
          assistantMessageID,
          partID: "part",
          text: "Tiếng Việt 🐈",
          partial: true,
        },
      ]);
      assert.equal(backend.reads, reads, "tokens do not fetch snapshots");
      backend.live[0]!.send(delta(kind, " suffix"));
      const second = await next(watch);
      assert.equal(second.drafts[0]?.text, "Tiếng Việt 🐈 suffix");
      assert.equal(
        first.drafts[0]?.text,
        "Tiếng Việt 🐈",
        "prior states stay immutable",
      );
      backend.current = snapshot(1, [part(kind, "part", "canonical")]);
      backend.events[0]!.send(event(1, kind, "ended", "part", "canonical"));
      const settled = await next(watch);
      assert.equal(settled.drafts.length, 0);
      assert.deepEqual(
        settled.snapshot.messages.data[0],
        backend.current.data.messages.data[0],
      );
      assert.equal(Object.isFrozen(settled.snapshot.messages.data[0]), true);
      assert.equal(Object.isFrozen(first.drafts[0]), true);
      assert.equal(Object.isFrozen(first.drafts), true);
      assert.equal(Reflect.set(settled.snapshot, "after", 900), false);
    });
  });

  test(`${kind} empty settlement is terminal for late fragments`, async () => {
    const backend = fixture();
    await observing(backend, async (watch) => {
      await open(backend, watch, kind);
      backend.live[0]!.send(delta(kind));
      assert.equal((await next(watch)).drafts.length, 1);
      backend.current = snapshot(1, [part(kind)]);
      backend.events[0]!.send(event(1, kind, "ended"));
      assert.equal((await next(watch)).drafts.length, 0);
      backend.live[0]!.send(delta(kind, "late"));
      backend.live[0]!.send({ type: "session.live.gap", sessionID });
      const state = await next(watch);
      assert.equal(state.reason, "gap", "late fragment was not emitted");
      assert.equal(state.drafts.length, 0);
    });
  });
}

test("attaching mid-part does not infer an open part from empty persisted content", async () => {
  const backend = fixture();
  backend.current = snapshot(10, [part("text")]);
  await observing(backend, async (watch) => {
    backend.live[0]!.send(delta("text"));
    backend.live[0]!.send({ type: "session.live.gap", sessionID });
    assert.equal((await next(watch)).reason, "gap");
    assert.equal(
      new URL(
        backend.requests.find((request) =>
          request.url.includes("/event?"),
        )!.url,
      ).searchParams.get("after"),
      "10",
    );
  });
});

test("an ahead snapshot coalesces reads and suppresses drafts until all markers catch up", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    backend.current = snapshot(1, [part("text")]);
    backend.events[0]!.send(event(0, "text", "started"));
    const ahead = await next(watch);
    assert.equal(ahead.catchingUp, true);
    const reads = backend.reads;
    backend.live[0]!.send(delta("text", "stale"));
    backend.live[0]!.send({ type: "session.live.gap", sessionID });
    assert.equal((await next(watch)).reason, "gap");
    backend.events[0]!.send(event(1, "text", "ended"));
    const caughtUp = await next(watch);
    assert.equal(caughtUp.catchingUp, false);
    assert.equal(caughtUp.drafts.length, 0);
    assert.equal(backend.reads, reads, "covered events do not refetch");
  });
});

test("reset refreshes durable data and discards the old draft without replaying tokens", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    backend.live[0]!.send(delta("text", "old"));
    assert.equal((await next(watch)).drafts[0]?.text, "old");
    backend.live[0]!.close();
    const pending = next(watch);
    await backend.live[1]!.opened;
    backend.live[1]!.send(reset);
    const restored = await pending;
    assert.equal(restored.reason, "reset");
    assert.equal(restored.drafts.length, 0);
    backend.live[1]!.send(delta("text", "new suffix"));
    assert.equal((await next(watch)).drafts[0]?.text, "new suffix");
  });
});

test("gap clears drafts before recovery even when its snapshot is stalled", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    backend.live[0]!.send(delta("text"));
    assert.equal((await next(watch)).drafts.length, 1);
    backend.onSnapshot = () => {
      throw new Error("snapshot must not run before gap delivery");
    };
    backend.live[0]!.send({ type: "session.live.gap", sessionID });
    const gap = await next(watch);
    assert.equal(gap.reason, "gap");
    assert.equal(gap.drafts.length, 0);
  });
});

for (const completed of [0, 10]) {
  test(`completed assistant at timestamp ${completed} cannot acquire a draft`, async () => {
    const backend = fixture();
    await observing(backend, async (watch) => {
      backend.current = snapshot(0, [part("text")], completed);
      backend.events[0]!.send(event(0, "text", "started"));
      await next(watch);
      backend.live[0]!.send(delta("text"));
      backend.live[0]!.send({ type: "session.live.gap", sessionID });
      assert.equal((await next(watch)).reason, "gap");
    });
  });
}

for (const status of ["running", "completed", "error"]) {
  test(`tool ${status} prunes input drafts using the authoritative snapshot`, async () => {
    const backend = fixture();
    await observing(backend, async (watch) => {
      await open(backend, watch, "tool-input");
      backend.live[0]!.send(delta("tool-input"));
      assert.equal((await next(watch)).drafts.length, 1);
      backend.current = snapshot(1, [
        { ...part("tool-input"), state: { status, input: {} } },
      ]);
      backend.events[0]!.send({
        ...event(1, "text", "ended"),
        type: "session.next.synthetic",
      });
      assert.equal((await next(watch)).drafts.length, 0);
    });
  });
}

test("missing messages or parts prune drafts instead of inventing history", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    backend.live[0]!.send(delta("text"));
    assert.equal((await next(watch)).drafts.length, 1);
    backend.current = snapshot(1);
    backend.events[0]!.send({
      ...event(1, "text", "ended"),
      type: "session.next.synthetic",
    });
    assert.equal((await next(watch)).drafts.length, 0);
  });
});

test("draft identities isolate assistant, part and kind, including empty part IDs", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "reasoning", 0, "");
    backend.live[0]!.send(delta("text", "wrong kind", ""));
    backend.live[0]!.send(delta("reasoning", "wrong part", "other"));
    backend.live[0]!.send(
      delta("reasoning", "wrong assistant", "", "ses_other_message"),
    );
    backend.live[0]!.send(delta("reasoning", "valid", ""));
    const state = await next(watch);
    assert.equal(state.drafts[0]?.text, "valid");
    assert.equal(state.drafts[0]?.partID, "");
  });
});

test("draft UTF-16 budget is cumulative and overflow cannot reopen the same part", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    backend.live[0]!.send(delta("text", "🐈".repeat(60_000)));
    assert.equal((await next(watch)).drafts[0]?.text.length, 120_000);
    backend.live[0]!.send(delta("text", "🐈".repeat(60_000)));
    assert.equal((await next(watch)).drafts[0]?.text.length, 240_000);
    backend.live[0]!.send(delta("text", "🐈".repeat(12_000)));
    assert.equal((await next(watch)).reason, "gap");
    backend.live[0]!.send(delta("text", "late"));
    backend.live[0]!.send({ type: "session.live.gap", sessionID });
    assert.equal((await next(watch)).reason, "gap");
  });
});

test("open-part count is bounded without unbounded terminal tombstones", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    const content: unknown[] = [];
    for (let seq = 0; seq < 129; seq++) {
      content.push(part("text", `part-${seq}`));
      backend.current = snapshot(seq, content);
      backend.events[0]!.send(event(seq, "text", "started", `part-${seq}`));
      await next(watch);
    }
    backend.live[0]!.send(delta("text", "too many", "part-128"));
    backend.live[0]!.send(delta("text", "old", "part-0"));
    backend.live[0]!.send({ type: "session.live.gap", sessionID });
    assert.equal((await next(watch)).reason, "gap");
  });
});

test("aborting a pending state read releases both subscriptions without an interrupt", async () => {
  const backend = fixture();
  await observing(backend, async (watch, controller) => {
    const pending = watch.next();
    controller.abort(new Error("fixture cancelled"));
    await assert.rejects(pending, /fixture cancelled/);
  });
});

for (const after of [-1, 0]) {
  test(`snapshot cursor ${after} behind a delivered event fails closed`, async () => {
    const backend = fixture();
    await observing(backend, async (watch) => {
      await open(backend, watch, "text");
      backend.current = snapshot(after, [part("text")]);
      backend.events[0]!.send(event(1, "text", "ended"));
      await assert.rejects(watch.next(), /cursor moved backwards/);
    });
  });
}

test("changed service generation during refresh terminates, without replaying work", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    backend.generation = "replacement";
    backend.events[0]!.send(event(0, "text", "started"));
    await assert.rejects(watch.next(), /generation changed/);
  });
});

test("invalid part marker scope and version are terminal", async () => {
  for (const invalid of [
    { data: { ...event(0, "text", "started").data, sessionID: "ses_other" } },
    { data: { ...event(0, "text", "started").data, textID: null } },
    { durable: { aggregateID: sessionID, seq: 0, version: 7 } },
  ]) {
    const backend = fixture();
    await observing(backend, async (watch) => {
      backend.events[0]!.send({ ...event(0, "text", "started"), ...invalid });
      await assert.rejects(watch.next(), /invalid session part marker/);
    });
  }
});

test("missing live capability terminates instead of starting a fallback service", async () => {
  const backend = fixture();
  backend.capabilities = [
    "session.snapshot.durable.v1",
    "session.events.durable.v1",
  ];
  const watch = watchSessionState(
    connection,
    { sessionID },
    { fetch: backend.fetch.bind(backend) },
  );
  await next(watch);
  await assert.rejects(watch.next(), /missing capability/);
  assert.equal(
    backend.requests.some((request) => request.url.includes("/delta?")),
    false,
  );
  assert.equal(
    backend.requests.every((request) => request.method === "GET"),
    true,
  );
});

test("identity, headers, input and options are captured before asynchronous discovery", async () => {
  const backend = fixture();
  const headers = new Headers(connection.headers);
  const identity = { ...connection, headers };
  const target = { sessionID, limit: 1 };
  const options = {
    fetch: async (request: Request) => {
      identity.url = "http://outside.example";
      identity.generation = "replacement";
      headers.set("authorization", "replacement");
      target.sessionID = "ses_other";
      target.limit = 200;
      return backend.fetch(request);
    },
    reconnects: 0,
  };
  const watch = watchSessionState(identity, target, options);
  try {
    await next(watch);
    await Promise.all([backend.events[0]!.opened, backend.live[0]!.opened]);
    backend.live[0]!.send(reset);
    assert.equal((await next(watch)).snapshot.session.id, sessionID);
    for (const request of backend.requests) {
      assert.equal(new URL(request.url).origin, connection.url);
      assert.equal(
        request.headers.get("authorization"),
        connection.headers.authorization,
      );
      if (request.url.includes("/snapshot?"))
        assert.equal(new URL(request.url).searchParams.get("limit"), "1");
    }
  } finally {
    await watch.return();
  }
});

test("invalid assistant metadata is rejected before any state is yielded", async () => {
  const backend = fixture();
  backend.current = snapshot(-1, [{ type: "text", id: "part", text: null }]);
  await assert.rejects(
    watchSessionState(
      connection,
      { sessionID },
      { fetch: backend.fetch.bind(backend) },
    ).next(),
    /invalid session state metadata/,
  );
  assert.equal(backend.requests.length, 3);
});

for (const action of ["ended", "failed"]) {
  test(`step ${action} closes all drafts even before completion metadata is visible`, async () => {
    const backend = fixture();
    await observing(backend, async (watch) => {
      await open(backend, watch, "text");
      backend.live[0]!.send(delta("text"));
      assert.equal((await next(watch)).drafts.length, 1);
      backend.current = snapshot(1, [part("text")]);
      backend.events[0]!.send({
        ...event(1, "text", "ended"),
        type: `session.next.step.${action}`,
        durable: { aggregateID: sessionID, seq: 1, version: 2 },
      });
      assert.equal((await next(watch)).drafts.length, 0);
      backend.live[0]!.send(delta("text", "late"));
      backend.live[0]!.send({ type: "session.live.gap", sessionID });
      assert.equal((await next(watch)).reason, "gap");
    });
  });
}

test("snapshot failure terminates both feeds without retrying a command or read", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    const reads = backend.reads;
    backend.onSnapshot = async () =>
      Response.json({ message: "fixture failure" }, { status: 503 });
    backend.events[0]!.send(event(0, "text", "started"));
    await assert.rejects(watch.next());
    assert.equal(backend.reads, reads + 1);
  });
});

test("abort while refreshing cancels the snapshot request and both feeds", async () => {
  const backend = fixture();
  await observing(backend, async (watch, controller) => {
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    backend.onSnapshot = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
        ready();
      });
    backend.events[0]!.send(event(0, "text", "started"));
    const pending = watch.next();
    await entered;
    controller.abort(new Error("fixture refresh cancelled"));
    await assert.rejects(pending, /fixture refresh cancelled/);
    assert.equal(backend.requests.at(-1)!.signal.aborted, true);
  });
});

test("oversized raw or escaped part identities consume the budget before tokens arrive", async () => {
  for (const id of ["i".repeat(256 * 1024), "\u0000".repeat(50_000)]) {
    const backend = fixture();
    await observing(backend, async (watch) => {
      await open(backend, watch, "text", 0, id);
      backend.live[0]!.send(delta("text", "x", id));
      backend.live[0]!.send({ type: "session.live.gap", sessionID });
      assert.equal((await next(watch)).reason, "gap");
    });
  }
});

test("empty token fragments do not emit states or refetch history", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    const reads = backend.reads;
    backend.live[0]!.send(delta("text", ""));
    backend.live[0]!.send(delta("text", "valid"));
    assert.equal((await next(watch)).drafts[0]?.text, "valid");
    assert.equal(backend.reads, reads);
  });
});

test("a long live burst does not poll or starve a quiet durable feed", async () => {
  const backend = fixture();
  await observing(backend, async (watch) => {
    await open(backend, watch, "text");
    const reads = backend.reads;
    for (let index = 0; index < 1_000; index++) {
      backend.live[0]!.send(delta("text", "x"));
      assert.equal((await next(watch)).drafts[0]?.text.length, index + 1);
    }
    assert.equal(backend.reads, reads);
    backend.current = snapshot(1, [part("text", "part", "canonical")]);
    backend.events[0]!.send(event(1, "text", "ended", "part", "canonical"));
    assert.equal((await next(watch)).drafts.length, 0);
  });
});
