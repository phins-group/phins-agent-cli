export * as ConfigReferencePlugin from "./reference"

import { define } from "../../extensions/definition"
import path from "path"
import { Effect } from "effect"
import { Config } from "../config"
import { ConfigReference } from "../references"
import { Reference } from "../../agents/references/registry"
import { AbsolutePath } from "../../shared/schema"
import { AppPaths } from "../../runtime/paths"
import { Location } from "../../workspace/location"

export const Plugin = define({
  id: "core/config-reference",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const global = yield* AppPaths.Service
    yield* ctx.reference.transform(
      Effect.fn(function* (draft) {
        const entries = new Map<string, Reference.Source>()
        for (const doc of (yield* config.entries()).filter(
          (entry): entry is Config.Document => entry.type === "document",
        )) {
          const directory = doc.path ? path.dirname(doc.path) : location.directory
          for (const [name, entry] of Object.entries(doc.info.references ?? {})) {
            if (!validAlias(name)) continue
            entries.set(
              name,
              local(entry)
                ? Reference.LocalSource.make({
                    type: "local",
                    path: AbsolutePath.make(
                      localPath(directory, global.home, typeof entry === "string" ? entry : entry.path),
                    ),
                    description: typeof entry === "string" ? undefined : entry.description,
                    hidden: typeof entry === "string" ? undefined : entry.hidden,
                  })
                : Reference.GitSource.make({
                    type: "git",
                    repository: typeof entry === "string" ? entry : entry.repository,
                    branch: typeof entry === "string" ? undefined : entry.branch,
                    description: typeof entry === "string" ? undefined : entry.description,
                    hidden: typeof entry === "string" ? undefined : entry.hidden,
                  }),
            )
          }
        }
        for (const [name, source] of entries) draft.add(name, source)
      }),
    )
  }),
})

function validAlias(name: string) {
  return name.length > 0 && !/[\/\s`,]/.test(name)
}

function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}
