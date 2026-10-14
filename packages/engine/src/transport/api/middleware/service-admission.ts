/** Declares the 503 boundary used by an opt-in draining daemon. @module */
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ConflictError, ServiceUnavailableError } from "../errors"

export class ServiceAdmission extends HttpApiMiddleware.Service<ServiceAdmission>()(
  "@phins/LocalServiceAdmission",
  { error: [ServiceUnavailableError, ConflictError] },
) {}
