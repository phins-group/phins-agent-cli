export * as FileSystemWatcher from "./filesystem"

import { Schema } from "effect"
import { define, inventory } from "./event"

const Updated = define({
  type: "file.watcher.updated",
  schema: {
    file: Schema.String,
    event: Schema.Literals(["add", "change", "unlink"]),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
