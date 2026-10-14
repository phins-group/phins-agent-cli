export * as SessionInput from "./input"

import { Schema } from "effect"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "../schema"
import { SessionDelivery } from "./delivery"
import { SessionID } from "./id"
import { SessionMessageID } from "./message-id"
import { SessionInputOrigin } from "./input-origin"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessageID.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(Schema.optional),
  origin: SessionInputOrigin.Origin.pipe(Schema.optional),
}).annotate({ identifier: "SessionInput.Admitted" })
