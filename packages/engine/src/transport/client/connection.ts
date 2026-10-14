/** Authenticated, attach-only client for a registered local Node Service. */
import { createPHINsClient, type LocalCapabilities } from "./create.js";
import {
  readSessionEvents,
  readSessionDeltas,
  SessionEventConnectionError,
} from "./events.js";
export type { DurableSessionEvent } from "./events.js";
export type { SessionLiveFrame } from "./events.js";

export interface LocalServiceConnection {
  url: string;
  generation: string;
  headers: HeadersInit;
}

export type LocalCapability = LocalCapabilities["capabilities"][number];

type TransportOptions = {
  signal?: AbortSignal;
  fetch?: (request: Request) => Promise<Response>;
};

function localTransport(
  connection: LocalServiceConnection,
  options: TransportOptions,
) {
  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    throw new Error("Node Service must use a loopback HTTP endpoint");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Node Service must use a loopback HTTP endpoint");
  }
  const headers = new Headers(connection.headers);
  const generation = connection.generation;
  if (!generation || !headers.get("authorization")) {
    throw new Error(
      "Node Service requires a registered generation and credential",
    );
  }
  const transport = options.fetch ?? ((request: Request) => fetch(request));
  return {
    baseUrl: url.origin,
    headers,
    fetch: async (request: Request) => {
      if (new URL(request.url).origin !== url.origin) {
        throw new Error(
          "Node Service request must stay on its registered origin",
        );
      }
      const signal = options.signal
        ? AbortSignal.any([request.signal, options.signal])
        : request.signal;
      signal.throwIfAborted();
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("x-phins-service-generation", generation);
      requestHeaders.set("authorization", headers.get("authorization")!);
      const next = new Request(request, {
        redirect: "error",
        signal,
        headers: requestHeaders,
      });
      (next as Request & { timeout?: boolean }).timeout = false;
      const response = await transport(next);
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Node Service redirects are not allowed");
      }
      return response;
    },
  };
}

async function attach(
  local: ReturnType<typeof localTransport>,
  generation: string,
  options: {
    required?: ReadonlyArray<LocalCapability>;
    allowDraining?: boolean;
  },
) {
  const client = createPHINsClient({
    ...local,
    throwOnError: true,
    fetch: local.fetch as NonNullable<
      Parameters<typeof createPHINsClient>[0]
    >["fetch"],
  });
  // Only discovery has a deadline. Waiting on accepted work must not acquire
  // a client timeout that could be mistaken for cancellation or completion.
  const discovery = {
    signal: AbortSignal.timeout(5_000),
    throwOnError: true,
  } as const;
  const { data: capabilities } = await client.v2.health.capabilities(discovery);
  if (
    capabilities?.protocol !== "phins.local-api.v1" ||
    !Array.isArray(capabilities.capabilities) ||
    !capabilities.capabilities.every(
      (capability) => typeof capability === "string",
    )
  ) {
    throw new Error("Node Service does not support the local session protocol");
  }
  for (const capability of options.required ?? []) {
    if (!capabilities.capabilities.includes(capability)) {
      throw new Error(`Node Service is missing capability: ${capability}`);
    }
  }
  const { data: service } = await client.v2.service.status(discovery);
  if (service?.mode !== "managed" || service.id !== generation) {
    throw new Error(
      "Node Service generation changed; rediscover before sending commands",
    );
  }
  if (service.state === "draining" && !options.allowDraining) {
    throw new Error(
      "Node Service is draining; no new session client was attached",
    );
  }
  if (service.state !== "running" && service.state !== "draining") {
    throw new Error("Node Service returned an invalid lifecycle state");
  }
  return client;
}

/** Negotiation is read-only; it never starts, upgrades or stops a service. */
export async function connectLocalService(
  connection: LocalServiceConnection,
  options: TransportOptions & {
    required?: ReadonlyArray<LocalCapability>;
    /** Reads and settlement may attach during drain; server admission remains authoritative. */
    allowDraining?: boolean;
  } = {},
) {
  return attach(
    localTransport(connection, options),
    connection.generation,
    options,
  );
}

/** Same origin, credential and generation fence for presentation adapters. */
export function createLocalServiceFetch(
  connection: LocalServiceConnection,
  options: TransportOptions = {},
) {
  return localTransport(connection, options).fetch;
}

/** Read persisted state and its event cursor together; never replay work. */
export async function readSessionSnapshot(
  connection: LocalServiceConnection,
  input: { sessionID: string; limit?: number },
  options: TransportOptions = {},
) {
  const sessionID = input.sessionID;
  const limit = input.limit ?? 20;
  const generation = connection.generation;
  if (!sessionID) throw new Error("Session ID must not be empty");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Snapshot limit must be an integer from 1 to 200");
  const client = await attach(localTransport(connection, options), generation, {
    required: ["session.snapshot.durable.v1"],
    allowDraining: true,
  });
  const response = await client.v2.session.snapshot(
    { sessionID, limit, generation },
    { signal: options.signal, throwOnError: true, cache: "no-store" },
  );
  const snapshot = response.data?.data;
  if (
    snapshot?.session?.id !== sessionID ||
    !Number.isSafeInteger(snapshot.after) ||
    snapshot.after < -1 ||
    !Array.isArray(snapshot.messages?.data) ||
    snapshot.messages.data.length > limit ||
    !snapshot.messages.cursor ||
    typeof snapshot.messages.cursor !== "object" ||
    Array.isArray(snapshot.messages.cursor) ||
    (snapshot.messages.cursor.next !== undefined &&
      typeof snapshot.messages.cursor.next !== "string") ||
    (snapshot.runState !== undefined &&
      snapshot.runState?.sessionID !== sessionID)
  )
    throw new Error("Node Service returned an invalid session snapshot");
  return response.data;
}

function retryable(cause: unknown) {
  if (cause instanceof SessionEventConnectionError) return true;
  const status = (cause as { cause?: { status?: number } } | null)?.cause
    ?.status;
  return typeof status === "number" && status >= 500 && status <= 599;
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

type WatchOptions = TransportOptions & {
  /** Total reconnect budget, including discovery failures. Default 3, maximum 10. */
  reconnects?: number;
  /** Base backoff; capped at 30 seconds. Default 250 ms. */
  reconnectDelayMs?: number;
};

/** GET-only catch-up/tail. Reconnects never replay a prompt or interrupt work. */
export async function* watchSessionEvents(
  connection: LocalServiceConnection,
  input: { sessionID: string; after?: number },
  options: WatchOptions = {},
) {
  const sessionID = input.sessionID;
  let after = input.after ?? -1;
  if (!Number.isSafeInteger(after) || after < -1)
    throw new Error(
      "Event cursor must be a safe integer greater than or equal to -1",
    );
  for await (const event of watchSessionFeed(
    connection,
    {
      sessionID,
      path: "event",
      capability: "session.events.durable.v1",
      query: () => ({ after: String(after) }),
      decode: (body, signal) =>
        readSessionEvents(body, sessionID, after, signal),
    },
    options,
  )) {
    after = event.durable.seq;
    yield event;
  }
}

/** Live-only drafts. Reset/gap requires discarding drafts, never command replay. */
export async function* watchSessionDeltas(
  connection: LocalServiceConnection,
  input: { sessionID: string },
  options: WatchOptions = {},
) {
  const sessionID = input.sessionID;
  yield* watchSessionFeed(
    connection,
    {
      sessionID,
      path: "delta",
      capability: "session.deltas.live.v1",
      query: () => ({}),
      decode: (body, signal) => readSessionDeltas(body, sessionID, signal),
    },
    options,
  );
}

async function* watchSessionFeed<T>(
  connection: LocalServiceConnection,
  input: {
    sessionID: string;
    path: "event" | "delta";
    capability: LocalCapability;
    query: () => Record<string, string>;
    decode: (
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) => AsyncGenerator<T>;
  },
  options: WatchOptions,
) {
  const sessionID = input.sessionID;
  const generation = connection.generation;
  const reconnects = options.reconnects ?? 3;
  const delay = options.reconnectDelayMs ?? 250;
  // V2 creates UUIDs and also accepts legacy ses IDs. The server owns ID
  // validation; encode the entire path segment rather than copying its schema.
  if (!sessionID) throw new Error("Session ID must not be empty");
  if (!Number.isInteger(reconnects) || reconnects < 0 || reconnects > 10)
    throw new Error("Reconnect budget must be an integer from 0 to 10");
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30_000)
    throw new Error("Reconnect delay must be an integer from 0 to 30000 ms");
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const transport = options.fetch ?? ((request: Request) => fetch(request));
  const local = localTransport(connection, {
    signal,
    fetch: async (request) => {
      try {
        return await transport(request);
      } catch (cause) {
        signal.throwIfAborted();
        throw new SessionEventConnectionError(
          cause instanceof Error
            ? cause.message
            : "Node Service transport failed",
          { cause },
        );
      }
    },
  });
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        // Re-negotiate identity before each reconnect; the feed also fences
        // generation at admission to close the discovery/request race.
        await attach(local, generation, {
          required: [input.capability],
          allowDraining: true,
        });
        const url = new URL(
          `/api/session/${encodeURIComponent(sessionID)}/${input.path}`,
          local.baseUrl,
        );
        for (const [name, value] of Object.entries(input.query()))
          url.searchParams.set(name, value);
        url.searchParams.set("generation", generation);
        const response = await local.fetch(
          new Request(url, {
            headers: local.headers,
            signal,
          }),
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status >= 500)
            throw new SessionEventConnectionError(
              `Node Service event request failed (${response.status})`,
            );
          throw new Error(
            `Node Service event request failed (${response.status}); check session, cursor and service generation`,
          );
        }
        if (
          response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "text/event-stream" ||
          !response.body
        ) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Node Service did not return an SSE event stream");
        }
        yield* input.decode(response.body, signal);
        throw new SessionEventConnectionError(
          "Node Service event connection ended",
        );
      } catch (cause) {
        signal.throwIfAborted();
        if (!retryable(cause) || attempt >= reconnects) throw cause;
      }
      await pause(Math.min(delay * 2 ** attempt, 30_000), signal);
    }
  } finally {
    controller.abort();
  }
}
