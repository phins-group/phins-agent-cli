/** Existing interactive CLI owns its local project work, not Node Service. */
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { Effect, Option } from "effect"
import { connectTarget, modelRef } from "../../agent/session-target"
import { ensureAgent, openAgentClient } from "../../agent/process"
import { reportCommandFailure } from "../errors"

export default CommandDispatcher.defineHandler(Commands, (input) =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* Effect.fail(
        new Error(
          "Interactive mode requires a terminal; use phins ask",
        ),
      )
    const prompt = Option.getOrUndefined(input.prompt)
    if (prompt !== undefined && !prompt.trim())
      return yield* Effect.fail(new Error("Prompt text must not be empty"))
    const project = Option.getOrUndefined(input.project)
    const session = Option.getOrUndefined(input.session)
    const model = Option.getOrUndefined(input.model)
    const agent = Option.getOrUndefined(input.agent)
    yield* Effect.try({ try: () => modelRef(model), catch: (cause) => cause })
    const target = session
      ? yield* connectTarget({ project, session, model, agent }, "tui")
      : yield* Effect.gen(function* () {
          const owner = yield* Effect.acquireRelease(
            Effect.tryPromise(async () => openAgentClient(
              await ensureAgent(project ?? process.cwd()), "tui",
            )),
            (owner) => Effect.promise(() => owner.close()),
          )
          return { connection: owner.connection, owner, session: undefined }
        })
    const { runTui } = yield* Effect.promise(() => import("../../tui/start"))
    yield* runTui(target.connection, target.session?.id, input.recordOnly, {
      directory: target.session?.location.directory ?? target.owner.directory,
      model, agent, prompt,
    }).pipe(Effect.catch((cause) => reportCommandFailure(cause, "Unable to open TUI")))
  }),
)
