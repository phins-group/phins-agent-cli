/** Select a persisted session without silently changing its project or model. */
import { connectLocalService } from "@phins/engine/transport/client/connection"
import { Effect } from "effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import { readSelectedModel } from "../shared/provider-setup"
import { randomUUID } from "node:crypto"
import { ensureAgent, openAgentClient, type AgentClientKind } from "./process"
import { projectDirectory, sessionDirectory } from "./registry"

export function modelRef(value?: string) {
  if (value === undefined) return undefined
  const separator = value.indexOf("/")
  if (separator < 1 || separator === value.length - 1 || value.includes("\0"))
    throw new Error("Model must use provider/model format")
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
  }
}

export const connectTarget = Effect.fn("cli.session.target")(function* (
  input: {
    project?: string
    session?: string
    model?: string
    agent?: string
    createID?: string
  },
  kind: AgentClientKind = "headless",
) {
  const model = yield* Effect.try({
    try: () => modelRef(input.model),
    catch: (cause) => cause,
  })
  const owner = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => openAgentClient(await ensureAgent(input.project ??
      (input.session ? await sessionDirectory(input.session) : process.cwd())), kind)),
    (owner) => Effect.promise(() => owner.close()),
  )
  const connection = owner.connection
  const directory = owner.directory
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const client = await connectLocalService(connection, {
        signal,
        required: ["service.generation.fence.v1", "session.prompt.durable.v1"],
      })
      if (input.session) {
        const response = await client.v2.session.get(
          { sessionID: input.session },
          { signal, throwOnError: true },
        )
        const session = response.data.data
        if (input.project && await projectDirectory(session.location.directory) !== directory)
          throw new Error(
            "Session belongs to another project; attach using its original directory",
          )
        if (
          model &&
          (session.model?.providerID !== model.providerID ||
            session.model?.id !== model.id)
        )
          throw new Error(
            "Session uses another model; create a new session to select a different model",
          )
        if (input.agent && session.agent !== input.agent)
          throw new Error(
            "Session uses another agent; create a new session to change it",
          )
        return { client, session }
      }
      const preference = model ?? await readSelectedModel(AppPaths.directories.state).then(async (saved) => {
        if (!saved) return undefined
        const models = (await client.v2.model.list({ location: { directory } }, { signal, throwOnError: true })).data.data
        return models.some((item) => item.providerID === saved.providerID && item.id === saved.modelID)
          ? { providerID: saved.providerID, id: saved.modelID } : undefined
      })
      const response = await client.v2.session.create(
        {
          id: input.createID ?? randomUUID(),
          location: { directory },
          model: preference,
          agent: input.agent,
        },
        { signal, throwOnError: true },
      )
      return { client, session: response.data.data }
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("Không mở được session Agent của project."),
  })
  return { connection, owner, ...result }
})
