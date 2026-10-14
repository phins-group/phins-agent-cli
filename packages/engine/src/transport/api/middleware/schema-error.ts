/** Protocol tag chuẩn hóa lỗi parse schema thành response công khai. @module */
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@phins/HttpApiSchemaError",
  { error: InvalidRequestError },
) {}
