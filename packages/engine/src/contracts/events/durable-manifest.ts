export * as DurableEventManifest from "./durable-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session"
import { SessionV1 } from "../session/compat"

export const Durable = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
