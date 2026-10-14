/** Read-only session state for opt-in clients of a local Node Service. */
import type { SessionSnapshotResponse } from "./generated/types.gen.js";
import {
  readSessionSnapshot,
  watchSessionDeltas,
  watchSessionEvents,
  type DurableSessionEvent,
  type LocalServiceConnection,
  type SessionLiveFrame,
} from "./connection.js";

type Immutable<T> = T extends object
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T;
type Snapshot = SessionSnapshotResponse["data"];
type DraftKind = "text" | "reasoning" | "tool-input";

export interface SessionDraft {
  readonly kind: DraftKind;
  readonly assistantMessageID: string;
  readonly partID: string;
  readonly text: string;
  /** Live tokens may miss a prefix, even after a reset. Never persist them. */
  readonly partial: true;
}

export interface SessionClientState {
  readonly snapshot: Immutable<Snapshot>;
  readonly drafts: ReadonlyArray<SessionDraft>;
  /** The snapshot includes durable events not yet consumed by this observer. */
  readonly catchingUp: boolean;
  readonly reason: "snapshot" | "event" | "delta" | "reset" | "gap";
}

export interface SessionStateOptions {
  signal?: AbortSignal;
  fetch?: (request: Request) => Promise<Response>;
  /** Separate, finite reconnect budgets for the two read-only feeds. */
  reconnects?: number;
  reconnectDelayMs?: number;
}

const MAX_OPEN_PARTS = 128;
const MAX_DRAFT_CHARACTERS = 256 * 1024;
const partEvents: Record<string, readonly [DraftKind, string, boolean]> = {
  "session.next.text.started": ["text", "textID", true],
  "session.next.text.ended": ["text", "textID", false],
  "session.next.reasoning.started": ["reasoning", "reasoningID", true],
  "session.next.reasoning.ended": ["reasoning", "reasoningID", false],
  "session.next.tool.input.started": ["tool-input", "callID", true],
  "session.next.tool.input.ended": ["tool-input", "callID", false],
  "session.next.tool.called": ["tool-input", "callID", false],
  "session.next.tool.success": ["tool-input", "callID", false],
  "session.next.tool.failed": ["tool-input", "callID", false],
};

function partKey(kind: DraftKind, assistantMessageID: string, partID: string) {
  return JSON.stringify([kind, assistantMessageID, partID]);
}

function freezeSnapshot(snapshot: Snapshot) {
  // Validate only the fields used to identify and prune drafts, not the whole
  // message schema. The existing snapshot helper validates scope and cursors.
  for (const message of snapshot.messages.data) {
    if (
      !message ||
      typeof message.id !== "string" ||
      typeof message.type !== "string" ||
      (message.type === "assistant" &&
        (!message.time ||
          !Number.isFinite(message.time.created) ||
          (message.time.completed !== undefined &&
            !Number.isFinite(message.time.completed)) ||
          !Array.isArray(message.content) ||
          message.content.some(
            (part) =>
              !part ||
              typeof part.id !== "string" ||
              (part.type === "tool"
                ? !part.state || typeof part.state.status !== "string"
                : !["text", "reasoning"].includes(part.type) ||
                  typeof part.text !== "string"),
          )))
    )
      throw new Error("Node Service returned invalid session state metadata");
  }
  // Freeze once per read, not once per token. This is owned JSON, without
  // cycles; consumer mutation must not change cursors or completion guards.
  const pending: object[] = [snapshot];
  while (pending.length) {
    const value = pending.pop()!;
    Object.freeze(value);
    for (const child of Object.values(value))
      if (child !== null && typeof child === "object") pending.push(child);
  }
  return snapshot as Immutable<Snapshot>;
}

function last<Value>(
  values: ReadonlyArray<Value>,
  matches: (value: Value) => boolean,
) {
  for (let index = values.length - 1; index >= 0; index--)
    if (matches(values[index]!)) return values[index];
}

function isOpen(snapshot: Immutable<Snapshot>, draft: SessionDraft) {
  const message = last(
    snapshot.messages.data,
    (value) => value.id === draft.assistantMessageID,
  );
  if (message?.type !== "assistant" || message.time.completed !== undefined)
    return false;
  const type = draft.kind === "tool-input" ? "tool" : draft.kind;
  const part = last(
    message.content,
    (value) => value.type === type && value.id === draft.partID,
  );
  return !!part && (part.type !== "tool" || part.state.status === "pending");
}

function pull<Source extends "event" | "live", Value>(
  source: Source,
  feed: AsyncGenerator<Value, void>,
) {
  return feed.next().then(
    (result) => ({ source, ok: true as const, result }),
    (error: unknown) => ({ source, ok: false as const, error }),
  );
}

type Update =
  | Awaited<ReturnType<typeof pull<"event", DurableSessionEvent>>>
  | Awaited<ReturnType<typeof pull<"live", SessionLiveFrame>>>;

/**
 * Snapshots stay authoritative; drafts are a separate, bounded partial overlay.
 * Start markers must be observed after attach: an empty persisted part is not
 * evidence that it is still open. No Agent reducer, commands or polling loop.
 */
export async function* watchSessionState(
  connection: LocalServiceConnection,
  input: { sessionID: string; limit?: number },
  options: SessionStateOptions = {},
): AsyncGenerator<SessionClientState, void> {
  const target = { sessionID: input.sessionID, limit: input.limit };
  const identity = { ...connection, headers: new Headers(connection.headers) };
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const transport = { ...options, signal };
  const parts = new Map<string, SessionDraft>();
  let characters = 0;
  let events: ReturnType<typeof watchSessionEvents> | undefined;
  let live: ReturnType<typeof watchSessionDeltas> | undefined;

  function clear() {
    parts.clear();
    characters = 0;
  }
  function units(draft: SessionDraft, key: string) {
    return (
      key.length +
      draft.assistantMessageID.length +
      draft.partID.length +
      draft.text.length +
      128
    );
  }
  function remove(key: string) {
    const draft = parts.get(key);
    if (draft) characters -= units(draft, key);
    parts.delete(key);
  }
  function mark(event: DurableSessionEvent) {
    const entry = Object.hasOwn(partEvents, event.type)
      ? partEvents[event.type]
      : undefined;
    const settled =
      event.type === "session.next.step.ended" ||
      event.type === "session.next.step.failed";
    if (!entry && !settled) return;
    const data = event.data as Record<string, unknown>;
    if (
      data.sessionID !== target.sessionID ||
      typeof data.assistantMessageID !== "string" ||
      !data.assistantMessageID ||
      !Number.isFinite(data.timestamp) ||
      event.durable.version !== (settled ? 2 : 1) ||
      (entry && typeof data[entry[1]] !== "string")
    )
      throw new Error("Node Service returned an invalid session part marker");
    if (settled) {
      for (const [key, draft] of parts)
        if (draft.assistantMessageID === data.assistantMessageID) remove(key);
      return;
    }
    const [kind, field, started] = entry!;
    const partID = data[field] as string;
    const key = partKey(kind, data.assistantMessageID, partID);
    remove(key);
    if (!started) return;
    const draft: SessionDraft = {
      kind,
      assistantMessageID: data.assistantMessageID,
      partID,
      text: "",
      partial: true,
    };
    const size = units(draft, key);
    if (
      parts.size >= MAX_OPEN_PARTS ||
      characters + size > MAX_DRAFT_CHARACTERS
    ) {
      clear();
      return;
    }
    parts.set(key, draft);
    characters += size;
  }

  try {
    let snapshot = freezeSnapshot(
      (await readSessionSnapshot(identity, target, transport)).data,
    );
    let sequence = snapshot.after;
    const refresh = async () => {
      const next = (await readSessionSnapshot(identity, target, transport))
        .data;
      if (next.after < snapshot.after || next.after < sequence)
        throw new Error("Node Service session snapshot cursor moved backwards");
      snapshot = freezeSnapshot(next);
    };
    const prune = () => {
      for (const [key, draft] of parts)
        if (!isOpen(snapshot, draft)) remove(key);
    };
    const state = (reason: SessionClientState["reason"]): SessionClientState =>
      Object.freeze({
        snapshot,
        drafts: Object.freeze(
          sequence < snapshot.after
            ? []
            : [...parts.values()]
                .filter((draft) => draft.text.length > 0)
                .map((draft) => Object.freeze(draft)),
        ),
        catchingUp: sequence < snapshot.after,
        reason,
      });
    events = watchSessionEvents(
      identity,
      { sessionID: target.sessionID, after: sequence },
      transport,
    );
    live = watchSessionDeltas(identity, target, transport);
    // At most two results, one per feed. Schedule another read only after
    // consuming that feed's result. Repeated Promise.race would retain a new
    // callback on the quiet feed's pending Promise for every active-feed token.
    const updates: Update[] = [];
    let wake: (() => void) | undefined;
    const enqueue = (update: Update) => {
      updates.push(update);
      wake?.();
      wake = undefined;
    };
    const readEvents = () => void pull("event", events!).then(enqueue);
    const readLive = () => void pull("live", live!).then(enqueue);
    readEvents();
    readLive();
    yield state("snapshot");
    while (true) {
      signal.throwIfAborted();
      if (updates.length === 0)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      signal.throwIfAborted();
      const update = updates.shift()!;
      if (!update.ok) throw update.error;
      if (update.result.done)
        throw new Error("Node Service session state feed ended");
      if (update.source === "event") {
        const event = update.result.value;
        readEvents();
        sequence = event.durable.seq;
        mark(event);
        if (sequence > snapshot.after) await refresh();
        prune();
        yield state("event");
        continue;
      }
      const frame = update.result.value;
      readLive();
      if (frame.type !== "session.live.delta") {
        // Clear immediately on gap. A new subscription's reset also refreshes
        // persisted data, but never infers open parts from empty text.
        for (const [key, draft] of parts) {
          characters -= draft.text.length;
          parts.set(key, { ...draft, text: "" });
        }
        if (frame.type === "session.live.reset") {
          await refresh();
          prune();
        }
        yield state(frame.type === "session.live.reset" ? "reset" : "gap");
        continue;
      }
      if (sequence < snapshot.after) continue;
      const event = frame.event;
      const kind =
        event.type === "session.next.text.delta"
          ? "text"
          : event.type === "session.next.reasoning.delta"
            ? "reasoning"
            : "tool-input";
      const partID =
        event.type === "session.next.text.delta"
          ? event.data.textID
          : event.type === "session.next.reasoning.delta"
            ? event.data.reasoningID
            : event.data.callID;
      const key = partKey(kind, event.data.assistantMessageID, partID);
      const draft = parts.get(key);
      if (!draft || !event.data.delta || !isOpen(snapshot, draft)) continue;
      if (characters + event.data.delta.length > MAX_DRAFT_CHARACTERS) {
        clear();
        yield state("gap");
        continue;
      }
      characters += event.data.delta.length;
      parts.set(key, { ...draft, text: draft.text + event.data.delta });
      yield state("delta");
    }
  } finally {
    // Abort before return(): either generator may be blocked in a pending read.
    controller.abort();
    await Promise.allSettled([events?.return(), live?.return()]);
  }
}
