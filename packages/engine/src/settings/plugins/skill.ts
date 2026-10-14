export * as ConfigSkillPlugin from "./skill"

import { define } from "../../extensions/definition"
import path from "path"
import { Effect } from "effect"
import { Config } from "../config"
import { AbsolutePath } from "../../shared/schema"
import { SkillRegistry } from "../../agents/skills/registry"
import { AppPaths } from "../../runtime/paths"
import { Location } from "../../workspace/location"

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* AppPaths.Service
    const location = yield* Location.Service
    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
        const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
        for (const directory of directories) {
          draft.source(
            SkillRegistry.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
          )
          draft.source(
            SkillRegistry.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory, "skills")),
            }),
          )
        }
        for (const item of items) {
          if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
            draft.source(SkillRegistry.UrlSource.make({ type: "url", url: item }))
            continue
          }
          const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
          draft.source(
            SkillRegistry.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
            }),
          )
        }
      }),
    )
  }),
})
