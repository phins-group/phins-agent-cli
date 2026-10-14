import { Schema } from "effect"
import { PrefixedId } from "../shared/prefixed-id"
import { withStatics } from "../shared/schema"
import { Session as SessionSchema } from "../contracts/session/info"

export const SessionID = SessionSchema.ID
export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(PrefixedId.ascending("message", id)),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(PrefixedId.ascending("part", id)),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
