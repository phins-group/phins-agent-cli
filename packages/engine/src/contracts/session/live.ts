/** Live token fragments have no durable cursor and cannot be replayed. */
export * as SessionLive from "./live"

import { Schema } from "effect"
import { Event } from "../events/event"
import { SessionEvent } from "../events/session"
import { SessionID } from "./id"

export const Delta = Schema.Union([
  Schema.Struct({
    id: Event.ID,
    type: Schema.Literal(SessionEvent.Text.Delta.type),
    data: SessionEvent.Text.Delta.data,
  }),
  Schema.Struct({
    id: Event.ID,
    type: Schema.Literal(SessionEvent.Reasoning.Delta.type),
    data: SessionEvent.Reasoning.Delta.data,
  }),
  Schema.Struct({
    id: Event.ID,
    type: Schema.Literal(SessionEvent.Tool.Input.Delta.type),
    data: SessionEvent.Tool.Input.Delta.data,
  }),
]).annotate({ identifier: "SessionLiveDelta" })
export type Delta = typeof Delta.Type

export const Reset = Schema.Struct({
  type: Schema.Literal("session.live.reset"),
  sessionID: SessionID,
})
export const Fragment = Schema.Struct({
  type: Schema.Literal("session.live.delta"),
  event: Delta,
})
export const Gap = Schema.Struct({
  type: Schema.Literal("session.live.gap"),
  sessionID: SessionID,
})
export const Frame = Schema.Union([Reset, Fragment, Gap]).annotate({
  identifier: "SessionLiveFrame",
})
export type Frame = typeof Frame.Type
