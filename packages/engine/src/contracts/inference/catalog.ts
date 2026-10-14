export * as Catalog from "./catalog"

import { define, inventory } from "../events/event"

const Updated = define({ type: "catalog.updated", schema: {} })
export const Event = { Updated, Definitions: inventory(Updated) }
