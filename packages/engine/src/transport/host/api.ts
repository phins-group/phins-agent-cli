/** Bind protocol V2 mặc định với concrete location middleware keys. @module */
import { makeDefaultApi } from "../api/definition"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})
