import assert from "node:assert/strict";
import test from "node:test";
import { connectLocalService, createLocalServiceFetch } from "../../src/transport/client/connection.js";

const connection = {
  url: "http://127.0.0.1:4096",
  generation: "fixture-generation",
  headers: { authorization: "Basic fixture-credential" },
};
const capabilities = {
  protocol: "phins.local-api.v1",
  capabilities: ["session.prompt.durable.v1", "session.wait.idle.v1"],
  nodeControl: false,
};
const service = {
  mode: "managed",
  id: connection.generation,
  state: "running",
};

test("presentation fetch captures credentials, generation and origin without session mutations", async () => {
  const fx = fixture();
  const headers = new Headers(connection.headers);
  const controller = new AbortController();
  const localFetch = createLocalServiceFetch({ ...connection, headers }, { fetch: fx.fetch, signal: controller.signal });
  headers.set("authorization", "changed-after-attach");
  await localFetch(new Request(`${connection.url}/api/tui`, { headers: {
    authorization: "request-override", "x-phins-service-generation": "request-override",
  } }));
  assert.equal(fx.requests[0]!.headers.get("authorization"), connection.headers.authorization);
  assert.equal(fx.requests[0]!.headers.get("x-phins-service-generation"), connection.generation);
  assert.equal(fx.requests[0]!.redirect, "error");
  await assert.rejects(localFetch(new Request("http://example.test/api/tui")), /registered origin/);
  controller.abort();
  await assert.rejects(localFetch(new Request(`${connection.url}/api/tui`)));
  assert.equal(fx.requests.length, 1);
});

function fixture(
  overrides: { capabilities?: unknown; service?: unknown } = {},
) {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (request: Request) => {
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/capabilities") {
        return Response.json(overrides.capabilities ?? capabilities);
      }
      if (pathname === "/api/service") {
        return Response.json(overrides.service ?? service);
      }
      return new Response(null, { status: 204 });
    },
  };
}

test("local attach negotiates only required capabilities and tolerates future additions", async () => {
  const fx = fixture({
    capabilities: {
      ...capabilities,
      capabilities: [...capabilities.capabilities, "future.extension.v1"],
    },
  });
  const headers = new Headers(connection.headers);
  const client = await connectLocalService(
    { ...connection, headers },
    {
      fetch: fx.fetch,
      required: ["session.wait.idle.v1"],
    },
  );
  await client.v2.session.wait(
    { sessionID: "ses_fixture" },
    { throwOnError: true },
  );
  assert.deepEqual(
    fx.requests.map((request) => new URL(request.url).pathname),
    ["/api/capabilities", "/api/service", "/api/session/ses_fixture/wait"],
  );
  for (const request of fx.requests) {
    assert.equal(
      request.headers.get("x-phins-service-generation"),
      connection.generation,
    );
    assert.equal(
      request.headers.get("authorization"),
      "Basic fixture-credential",
    );
    assert.equal(request.redirect, "error");
    assert.equal(new URL(request.url).searchParams.has("auth_token"), false);
  }
  assert.equal(headers.get("authorization"), "Basic fixture-credential");
  assert.equal(Array.from(headers).length, 1);
});

test("the registered generation is captured and cannot be overridden by per-request headers", async () => {
  const fx = fixture();
  const input = { ...connection };
  const client = await connectLocalService(input, { fetch: fx.fetch });
  input.generation = "changed-after-attach";
  await client.v2.session.interrupt(
    { sessionID: "ses_fixture" },
    {
      headers: { "x-phins-service-generation": "override" },
      throwOnError: true,
    },
  );
  assert.equal(
    fx.requests.at(-1)!.headers.get("x-phins-service-generation"),
    connection.generation,
  );
});

test("local attach rejects unsafe URLs and missing identity before any network request", async () => {
  for (const target of [
    { ...connection, url: "not a URL" },
    { ...connection, url: "https://127.0.0.1:4096" },
    { ...connection, url: "http://example.test:4096" },
    { ...connection, url: "http://secret:password@127.0.0.1:4096" },
    { ...connection, url: `${connection.url}/api` },
    { ...connection, url: `${connection.url}?auth_token=secret` },
    { ...connection, url: `${connection.url}#secret` },
    { ...connection, generation: "" },
    { ...connection, headers: {} },
  ]) {
    const fx = fixture();
    await assert.rejects(
      connectLocalService(target, { fetch: fx.fetch }),
      (error: Error) => {
        assert.equal(error.message.includes("secret"), false);
        assert.equal(error.message.includes("password"), false);
        return true;
      },
    );
    assert.equal(fx.requests.length, 0);
  }
});

test("protocol mismatch, malformed discovery and missing capabilities do not reach session APIs", async () => {
  for (const body of [
    { ...capabilities, protocol: "other.v1" },
    { ...capabilities, capabilities: "session.prompt.durable.v1" },
    { ...capabilities, capabilities: [1] },
    { ...capabilities, capabilities: [] },
  ]) {
    const fx = fixture({ capabilities: body });
    await assert.rejects(
      connectLocalService(connection, {
        fetch: fx.fetch,
        required: ["session.prompt.durable.v1"],
      }),
    );
    assert.equal(fx.requests.length, 1);
  }
});

test("unmanaged, replaced, draining or malformed service status is rejected without mutation", async () => {
  for (const body of [
    { mode: "unmanaged" },
    { ...service, id: "replacement-generation" },
    { ...service, state: "draining" },
    { ...service, state: "unexpected" },
  ]) {
    const fx = fixture({ service: body });
    await assert.rejects(connectLocalService(connection, { fetch: fx.fetch }));
    assert.deepEqual(
      fx.requests.map((request) => request.method),
      ["GET", "GET"],
    );
  }
});

test("observation and settlement can opt into a draining service without weakening identity checks", async () => {
  const fx = fixture({ service: { ...service, state: "draining" } });
  const client = await connectLocalService(connection, {
    fetch: fx.fetch,
    allowDraining: true,
  });
  await client.v2.session.wait(
    { sessionID: "ses_fixture" },
    { throwOnError: true },
  );
  assert.equal(fx.requests[2]!.url.endsWith("/wait"), true);
  const changed = fixture({
    service: { ...service, id: "replacement", state: "draining" },
  });
  await assert.rejects(
    connectLocalService(connection, {
      fetch: changed.fetch,
      allowDraining: true,
    }),
  );
});

test("authentication errors and redirects cannot result in an attached client", async () => {
  for (const status of [401, 403, 302]) {
    const requests: Request[] = [];
    await assert.rejects(
      connectLocalService(connection, {
        fetch: async (request) => {
          requests.push(request);
          return status === 302
            ? new Response(null, {
                status,
                headers: { location: "https://outside.test" },
              })
            : Response.json({ message: "Authentication required" }, { status });
        },
      }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.redirect, "error");
  }
});

test("per-request URL overrides cannot forward the credential off the registered origin", async () => {
  const fx = fixture();
  const client = await connectLocalService(connection, { fetch: fx.fetch });
  await assert.rejects(
    client.v2.health.get({
      baseUrl: "http://outside.test",
      throwOnError: true,
    }),
  );
  assert.equal(fx.requests.length, 2);
});

test("lost mutation responses are reported once and are never automatically replayed", async () => {
  const fx = fixture();
  const client = await connectLocalService(connection, {
    fetch: async (request) => {
      if (request.method === "POST") {
        fx.requests.push(request);
        throw new Error("Fixture response was lost");
      }
      return fx.fetch(request);
    },
  });
  await assert.rejects(
    client.v2.session.prompt(
      {
        sessionID: "ses_fixture",
        id: "msg_recoverable",
        prompt: { text: "fixture" },
      },
      { throwOnError: true },
    ),
  );
  assert.equal(
    fx.requests.filter((request) => request.method === "POST").length,
    1,
  );
  assert.deepEqual(await fx.requests[2]!.json(), {
    id: "msg_recoverable",
    prompt: { text: "fixture" },
  });
});

test("aborting a client wait only aborts transport and never sends an interrupt", async () => {
  const fx = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = await connectLocalService(connection, {
    signal: controller.signal,
    fetch: async (request) => {
      if (!request.url.endsWith("/wait")) return fx.fetch(request);
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
  });
  const result = client.v2.session.wait(
    { sessionID: "ses_fixture" },
    { throwOnError: true },
  );
  const rejected = assert.rejects(result);
  await waiting;
  controller.abort(new Error("Fixture client closed"));
  await rejected;
  assert.deepEqual(
    fx.requests.map((request) => new URL(request.url).pathname),
    ["/api/capabilities", "/api/service", "/api/session/ses_fixture/wait"],
  );
});

test("a client already closed cannot issue discovery requests", async () => {
  const fx = fixture();
  const controller = new AbortController();
  controller.abort(new Error("Fixture client already closed"));
  await assert.rejects(
    connectLocalService(connection, {
      fetch: fx.fetch,
      signal: controller.signal,
    }),
  );
  assert.equal(fx.requests.length, 0);
});
