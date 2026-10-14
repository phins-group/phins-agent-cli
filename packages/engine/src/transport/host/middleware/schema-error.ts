/** Chuyển Effect schema parse errors thành protocol error response ổn định. @module */
import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../../api/errors"
import { SchemaErrorMiddleware } from "../../api/middleware/schema-error"
import { Utf8 } from "../utf8"
export { SchemaErrorMiddleware } from "../../api/middleware/schema-error"

const REASON_LIMIT_BYTES = 1024

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => {
  const reason = Utf8.truncateUtf8(error.cause.message, REASON_LIMIT_BYTES)
  return Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
})
