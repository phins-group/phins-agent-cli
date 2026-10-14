import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Option } from "effect"
import { Prompt } from "effect/unstable/cli"
import { AppPaths } from "@phins/engine/runtime/paths"
import { connectLocalService } from "@phins/engine/transport/client/connection"
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { ensureAgent, openAgentClient } from "../../agent/process"
import { providerSetup, saveSelectedModel } from "../../shared/provider-setup"

export default CommandDispatcher.defineHandler(Commands.commands.setup, (input) =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* Effect.fail(new Error("Run setup in an interactive terminal. API keys are never command arguments."))
    const project = Option.getOrElse(input.project, () => process.cwd())
    const owner = yield* Effect.acquireRelease(
      Effect.tryPromise(() => ensureAgent(project).then((host) => openAgentClient(host, "headless"))),
      (owner) => Effect.promise(() => owner.close()),
    )
    const client = yield* Effect.tryPromise(() => connectLocalService(owner.connection))
    yield* Effect.promise(() => import("@opentui/solid/preload"))
    const { promptSetupModel } = yield* Effect.promise(() => import("../../tui/dialogs/model-prompt"))
    const model = yield* providerSetup(client, { directory: owner.directory }, {
      select: Prompt.select, password: Prompt.password, model: promptSetupModel,
    })
    yield* Effect.tryPromise(() => saveSelectedModel(AppPaths.directories.state, model))
    yield* Effect.sync(() => process.stdout.write(
      `Setup saved. Default model: ${model.providerID}/${model.modelID}\nNo inference was requested. Run phins or phins ask to start.\n`,
    ))
  }).pipe(Effect.provide(NodeServices.layer)),
)
