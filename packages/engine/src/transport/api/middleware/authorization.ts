/** Protocol tag yêu cầu server authorization trước handler. @module */
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { UnauthorizedError } from "../errors"

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@phins/HttpApiAuthorization", {
  error: UnauthorizedError,
}) {}
