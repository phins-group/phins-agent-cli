import { Schema } from "effect"
import { withStatics } from "../schema"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SessionIDBase = Schema.Union([
  Schema.String.check(Schema.isPattern(UUID_V4)),
  Schema.String.check(Schema.isStartsWith("ses")),
])

export const SessionID = SessionIDBase.pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => {
    const create = () => schema.make(globalThis.crypto.randomUUID())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type SessionID = typeof SessionID.Type
