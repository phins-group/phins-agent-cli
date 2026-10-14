export * as ReferenceGuidance from "./guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { Reference } from "./registry"
import { SystemContext } from "../context/system"

const Summary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  description: Schema.String.pipe(Schema.optional),
})
type Summary = typeof Summary.Type

const render = (references: ReadonlyArray<typeof Summary.Type>) => {
  const lines = [
    "Project references provide additional directories that can be accessed when relevant.",
    "<available_references>",
  ]
  for (const reference of references) {
    lines.push("  <reference>")
    lines.push(`    <name>${reference.name}</name>`)
    lines.push(`    <path>${reference.path}</path>`)
    if (reference.description !== undefined) lines.push(`    <description>${reference.description}</description>`)
    lines.push("  </reference>")
  }
  lines.push("</available_references>")
  return lines.join("\n")
}

export interface Interface {
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/ReferenceGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const references = yield* Reference.Service

    return Service.of({
      load: Effect.fn("ReferenceGuidance.load")(function* () {
        const available: Summary[] = []
        for (const reference of yield* references.list()) {
          if (reference.description === undefined) continue
          available.push({
            name: reference.name,
            path: reference.path,
            description: reference.description,
          })
        }
        available.sort((a, b) => a.name.localeCompare(b.name))
        if (available.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: SystemContext.Key.make("core/reference-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available project references have changed. This list supersedes the previous reference list.",
              render(current),
            ].join("\n"),
          removed: () => "Project reference guidance is no longer available. Do not use previously listed references.",
        })
      }),
    })
  }),
)

export const locationLayer = layer
