export * as ConfigWatcher from "./watchers"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Watcher")({
  ignore: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}
