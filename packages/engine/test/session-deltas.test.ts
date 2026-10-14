import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { EventBus } from "../src/runtime/events/bus"
import * as SessionDeltas from "../src/runtime/events/session-deltas"
import { Session } from "../src/contracts/session/info"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionLive } from "../src/contracts/session/live"
import { SessionMessage } from "../src/contracts/session/message"
import { Location } from "../src/contracts/workspace/location"
import { AbsolutePath } from "../src/contracts/schema"
import { Database } from "../src/storage/database"
import { it, testEffect } from "./lib/effect"

const fragment = (
  sessionID: Session.ID,
  delta = "Tiếng Việt 🐈",
): SessionEvent.Text.Delta => ({
  id: EventBus.ID.create(),
  type: SessionEvent.Text.Delta.type,
  data: {
    sessionID,
    timestamp: DateTime.makeUnsafe(0),
    assistantMessageID: SessionMessage.ID.create(),
    textID: "text-fixture",
    delta,
  },
})

describe("bounded live session deltas", () => {
  it.effect(
    "registers before reset, even when its consumer publishes synchronously",
    () =>
      Effect.gen(function* () {
        const deltas = yield* SessionDeltas.make()
        const sessionID = Session.ID.create()
        const event = fragment(sessionID)
        const frames: SessionLive.Frame[] = []
        yield* deltas.stream(sessionID).pipe(
          Stream.take(2),
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              frames.push(frame)
              if (frame.type === "session.live.reset") deltas.publish(event)
            }),
          ),
        )
        expect(frames).toEqual([
          { type: "session.live.reset", sessionID },
          { type: "session.live.delta", event },
        ])
      }),
  )

  it.effect(
    "filters other sessions and strips metadata/location from retained fragments",
    () =>
      Effect.gen(function* () {
        const deltas = yield* SessionDeltas.make()
        const sessionID = Session.ID.create()
        const event = fragment(sessionID)
        const frames = yield* deltas.stream(sessionID).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame.type !== "session.live.reset") return
              deltas.publish(fragment(Session.ID.create(), "private"))
              deltas.publish({
                ...event,
                metadata: { private: "must not be retained" },
                location: Location.Ref.make({
                  directory: AbsolutePath.make("/private/live-fixture"),
                }),
              })
            }),
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        expect(Array.from(frames)).toEqual([
          { type: "session.live.reset", sessionID },
          { type: "session.live.delta", event },
        ])
      }),
  )

  it.effect(
    "excludes durable events, unrelated live events and previously published deltas",
    () =>
      Effect.gen(function* () {
        const deltas = yield* SessionDeltas.make()
        const sessionID = Session.ID.create()
        const old = fragment(sessionID, "old")
        const fresh = fragment(sessionID, "fresh")
        deltas.publish(old)
        const frames = yield* deltas.stream(sessionID).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame.type !== "session.live.reset") return
              deltas.publish({
                ...old,
                type: SessionEvent.Text.Ended.type,
                data: { sessionID, text: "ended" },
              })
              deltas.publish({
                ...old,
                type: "permission.asked",
                data: { sessionID },
              })
              deltas.publish(fresh)
            }),
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        expect(Array.from(frames).at(-1)).toEqual({
          type: "session.live.delta",
          event: fresh,
        })
      }),
  )

  for (const bound of ["count", "characters"] as const) {
    it.effect(
      `reports a gap and closes on ${bound} overflow without blocking publishers`,
      () =>
        Effect.gen(function* () {
          const deltas = yield* SessionDeltas.make()
          const sessionID = Session.ID.create()
          const ready = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const frames: SessionLive.Frame[] = []
          const reader = yield* deltas.stream(sessionID).pipe(
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                frames.push(frame)
                if (frame.type !== "session.live.reset") return
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(release)
              }),
            ),
            Effect.forkScoped,
          )
          yield* Deferred.await(ready)
          if (bound === "count") {
            for (
              let index = 0;
              index <= SessionDeltas.MAX_PENDING_DELTAS;
              index++
            )
              deltas.publish(fragment(sessionID, String(index)))
          } else
            deltas.publish(
              fragment(
                sessionID,
                "a".repeat(SessionDeltas.MAX_PENDING_CHARACTERS),
              ),
            )
          // Removed immediately from publication, even before the slow reader drains.
          deltas.publish(fragment(sessionID, "after overflow"))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(reader)
          expect(frames.at(-1)).toEqual({ type: "session.live.gap", sessionID })
          expect(frames).toHaveLength(
            bound === "count" ? SessionDeltas.MAX_PENDING_DELTAS + 2 : 2,
          )
          expect(JSON.stringify(frames)).not.toContain("after overflow")
        }),
    )
  }

  it.effect(
    "bounds cumulative UTF-16 fragments, not just individual deltas or queue count",
    () =>
      Effect.gen(function* () {
        const deltas = yield* SessionDeltas.make()
        const sessionID = Session.ID.create()
        const frames = yield* deltas.stream(sessionID).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame.type !== "session.live.reset") return
              for (let index = 0; index < 4; index++)
                deltas.publish(
                  fragment(
                    sessionID,
                    "🐈".repeat(SessionDeltas.MAX_PENDING_CHARACTERS / 8),
                  ),
                )
            }),
          ),
          Stream.runCollect,
        )
        // Three fit; the fourth exceeds the shared character budget, far below 128 items.
        expect(Array.from(frames)).toHaveLength(5)
        expect(Array.from(frames).at(-1)).toEqual({
          type: "session.live.gap",
          sessionID,
        })
      }),
  )

  it.effect(
    "does not replay a failed queue on reconnect and releases the old subscription",
    () =>
      Effect.gen(function* () {
        const deltas = yield* SessionDeltas.make()
        const sessionID = Session.ID.create()
        yield* deltas.stream(sessionID).pipe(Stream.take(1), Stream.runDrain)
        for (let index = 0; index < 200; index++)
          deltas.publish(fragment(sessionID, "unobserved"))
        const event = fragment(sessionID, "new connection")
        const frames = yield* deltas.stream(sessionID).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame.type === "session.live.reset") deltas.publish(event)
            }),
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        expect(Array.from(frames)).toEqual([
          { type: "session.live.reset", sessionID },
          { type: "session.live.delta", event },
        ])
      }),
  )

  it.effect("one slow subscription does not stop an independent reader", () =>
    Effect.gen(function* () {
      const deltas = yield* SessionDeltas.make()
      const sessionID = Session.ID.create()
      const ready = yield* Deferred.make<void>()
      const slow = yield* deltas.stream(sessionID).pipe(
        Stream.runForEach((frame) =>
          frame.type === "session.live.reset"
            ? Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* Deferred.await(ready)
      for (let index = 0; index < 200; index++)
        deltas.publish(fragment(sessionID))
      const event = fragment(sessionID, "fast reader")
      const frames = yield* deltas.stream(sessionID).pipe(
        Stream.tap((frame) =>
          Effect.sync(() => {
            if (frame.type === "session.live.reset") deltas.publish(event)
          }),
        ),
        Stream.take(2),
        Stream.runCollect,
      )
      expect(Array.from(frames).at(-1)).toEqual({
        type: "session.live.delta",
        event,
      })
      yield* Fiber.interrupt(slow)
    }),
  )
})

testEffect(
  EventBus.layer.pipe(Layer.provideMerge(Database.defaultLayer)),
).effect(
  "EventV2 delivers text/reasoning/tool-input fragments without a durable sequence",
  () =>
    Effect.gen(function* () {
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const sessionID = Session.ID.create()
      const data = fragment(sessionID).data
      const received = yield* events.sessionDeltas(sessionID).pipe(
        Stream.tap((frame) =>
          frame.type !== "session.live.reset"
            ? Effect.void
            : Effect.gen(function* () {
                yield* events.publish(SessionEvent.Text.Delta, data)
                yield* events.publish(SessionEvent.Reasoning.Delta, {
                  ...data,
                  reasoningID: "reasoning",
                })
                yield* events.publish(SessionEvent.Tool.Input.Delta, {
                  ...data,
                  callID: "call",
                })
              }),
        ),
        Stream.take(4),
        Stream.runCollect,
      )
      expect(
        Array.from(received)
          .slice(1)
          .map(
            (frame) => frame.type === "session.live.delta" && frame.event.type,
          ),
      ).toEqual([
        SessionEvent.Text.Delta.type,
        SessionEvent.Reasoning.Delta.type,
        SessionEvent.Tool.Input.Delta.type,
      ])
      expect(yield* EventBus.latestSequence(db, sessionID)).toBe(-1)
    }),
)
