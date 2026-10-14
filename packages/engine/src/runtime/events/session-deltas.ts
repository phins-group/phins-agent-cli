/** Session-scoped, bounded live subscriptions; no history cache or DB writes. */
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import type { Payload } from "../../contracts/events/event"
import { SessionEvent } from "../../contracts/events/session"
import { SessionLive } from "../../contracts/session/live"
import { SessionID } from "../../contracts/session/id"

export const MAX_PENDING_DELTAS = 128
// UTF-16 code units bound retained string memory, including IDs and delta text.
export const MAX_PENDING_CHARACTERS = 256 * 1024

class Overflow extends Schema.TaggedErrorClass<Overflow>()(
  "SessionLiveOverflow",
  {},
) {}

type Subscription = {
  queue: Queue.Queue<{ event: SessionLive.Delta; characters: number }, Overflow>
  characters: number
}

export const make = () =>
  Effect.gen(function* () {
    const subscriptions = new Map<string, Set<Subscription>>()
    const remove = (sessionID: string, subscription: Subscription) => {
      const active = subscriptions.get(sessionID)
      active?.delete(subscription)
      if (active?.size === 0) subscriptions.delete(sessionID)
    }
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        subscriptions.values(),
        (active) =>
          Effect.forEach(active, ({ queue }) => Queue.shutdown(queue), {
            discard: true,
          }),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => subscriptions.clear()))),
    )

    const publish = (payload: Payload) => {
      if (
        payload.type !== SessionEvent.Text.Delta.type &&
        payload.type !== SessionEvent.Reasoning.Delta.type &&
        payload.type !== SessionEvent.Tool.Input.Delta.type
      )
        return
      const delta = payload as SessionLive.Delta
      const active = subscriptions.get(delta.data.sessionID)
      if (!active) return
      // Do not retain location/metadata or unrelated events in a slow reader's queue.
      const event = {
        id: delta.id,
        type: delta.type,
        data: delta.data,
      } as SessionLive.Delta
      const characters =
        event.id.length +
        event.type.length +
        128 +
        Object.values(event.data).reduce(
          (size, value) =>
            size + (typeof value === "string" ? value.length : 0),
          0,
        )
      for (const subscription of active) {
        if (
          subscription.characters + characters > MAX_PENDING_CHARACTERS ||
          !Queue.offerUnsafe(subscription.queue, { event, characters })
        ) {
          remove(delta.data.sessionID, subscription)
          Queue.failCauseUnsafe(subscription.queue, Cause.fail(new Overflow()))
        } else subscription.characters += characters
      }
    }

    const stream = (sessionID: SessionID): Stream.Stream<SessionLive.Frame> =>
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const queue = yield* Queue.make<
              { event: SessionLive.Delta; characters: number },
              Overflow
            >({
              capacity: MAX_PENDING_DELTAS,
              strategy: "dropping",
            })
            const subscription = { queue, characters: 0 }
            const active =
              subscriptions.get(sessionID) ?? new Set<Subscription>()
            active.add(subscription)
            subscriptions.set(sessionID, active)
            return subscription
          }),
          (subscription) =>
            Effect.sync(() => remove(sessionID, subscription)).pipe(
              Effect.andThen(Queue.shutdown(subscription.queue)),
            ),
        ).pipe(
          Effect.map((subscription) => {
            const fragments = Stream.fromEffectRepeat(
              Queue.take(subscription.queue),
            ).pipe(
              Stream.map(({ event, characters }): SessionLive.Frame => {
                subscription.characters -= characters
                return { type: "session.live.delta", event }
              }),
              Stream.catchTag("SessionLiveOverflow", () =>
                Stream.succeed<SessionLive.Frame>({
                  type: "session.live.gap",
                  sessionID,
                }),
              ),
            )
            // The reset is emitted only after registration. Even a token published by
            // its consumer synchronously is queued; there is no ready/subscribe gap.
            return Stream.concat(
              Stream.succeed<SessionLive.Frame>({
                type: "session.live.reset",
                sessionID,
              }),
              fragments,
            )
          }),
        ),
      )
    return { publish, stream }
  })
