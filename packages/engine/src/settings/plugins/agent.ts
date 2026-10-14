export * as ConfigAgentPlugin from "./agent"

import { define } from "../../extensions/definition"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AgentRegistry } from "../../agents/registry"
import { Config } from "../config"
import { ConfigAgent } from "../agents"
import { ConfigMarkdown } from "../markdown"
import { FileAccess } from "../../workspace/files/access"
import { CatalogModel } from "../../inference/catalog/model"

const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info, {
  errors: "all", onExcessProperty: "error", propertyOrder: "original",
})

export const Plugin = define({
  id: "config-agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FileAccess.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (entry.type === "document") return Effect.succeed([entry])
          return Effect.gen(function* () {
            const files = yield* discover(fs, entry.path)
            return yield* Effect.forEach(files, (file) =>
              fs.readFileStringSafe(file.filepath).pipe(
                Effect.map((content) => content && decode(file, content)),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            ).pipe(
              Effect.map((documents) =>
                documents.filter((document): document is Config.Document => document !== undefined),
              ),
            )
          })
        }).pipe(Effect.map((documents) => documents.flat()))
        const global = documents.flatMap((document) => document.info.permissions ?? [])
        const configuredDefault = Config.latest(documents, "default_agent")
        if (configuredDefault !== undefined) draft.default(AgentRegistry.ID.make(configuredDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...global))
        }

        for (const document of documents) {
          for (const [id, item] of Object.entries(document.info.agents ?? {})) {
            const agentID = AgentRegistry.ID.make(id)
            if (item.disabled) {
              draft.remove(agentID)
              continue
            }

            const exists = draft.get(agentID) !== undefined
            draft.update(agentID, (agent) => {
              if (!exists) agent.permissions.push(...global)
              if (item.model !== undefined) {
                const model = CatalogModel.parseReference(item.model)
                agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
              }
              if (item.variant !== undefined && agent.model !== undefined) {
                agent.model.variant = CatalogModel.VariantID.make(item.variant)
              }
              if (item.request !== undefined) {
                Object.assign(agent.request.headers, item.request.headers ?? {})
                Object.assign(agent.request.body, item.request.body ?? {})
              }
              if (item.system !== undefined) agent.system = item.system
              if (item.description !== undefined) agent.description = item.description
              if (item.mode !== undefined) agent.mode = item.mode
              if (item.hidden !== undefined) agent.hidden = item.hidden
              if (item.color !== undefined) agent.color = item.color
              if (item.permissions !== undefined) agent.permissions.push(...item.permissions)
            })
          }
        }
      }),
    )
  }),
})

function discover(fs: FileAccess.Interface, directory: string) {
  return fs.glob("{agent,agents}/**/*.md", {
    cwd: directory, absolute: true, dot: true, symlink: true,
  }).pipe(
    Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath }))),
    Effect.catch(() => Effect.succeed([])),
  )
}

function decode(file: { directory: string; filepath: string }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  const agent = markdown && Option.getOrUndefined(
    decodeAgent({ ...markdown.data, system: markdown.content.trim() }),
  )
  if (!agent)
    throw new Error(`Invalid agent configuration: ${file.filepath}. Use current agent fields; see docs/LOCAL_OPERATION.md.`)
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents)\//, "")
    .replace(/\.md$/, "")
  return new Config.Document({
    type: "document", path: file.filepath,
    info: new Config.Info({ agents: { [name]: agent } }),
  })
}
