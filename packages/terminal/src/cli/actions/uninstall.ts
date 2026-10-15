import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Prompt } from "effect/unstable/cli"
import { AppPaths } from "@phins/engine/runtime/paths"
import { InstallationVersion } from "@phins/engine/runtime/version"
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { inspectUninstall, removeInstallation } from "../uninstall"

export default CommandDispatcher.defineHandler(Commands.commands.uninstall, input =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* Effect.fail(new Error("Run uninstall in an interactive terminal. Confirmation is required; nothing removed."))
    const plan = yield* Effect.tryPromise(() => inspectUninstall({
      executable: process.execPath, version: InstallationVersion,
      profile: AppPaths.directories.home, all: input.all,
    }))
    yield* Effect.sync(() => process.stdout.write(
      `Remove PHINs Agent: ${plan.executable}\nUnchanged release files will be removed. Added or modified files and projects will be preserved.\n`
      + (input.all ? `Delete default profile (API keys, configuration, sessions, cache and logs): ${plan.profile}\n`
        : `Keep profile (API keys, configuration and sessions): ${plan.profile}\n`),
    ))
    const confirmed = yield* Prompt.confirm({
      message: input.all ? "Uninstall and permanently delete the default profile?" : "Uninstall PHINs Agent?",
      initial: false,
    })
    if (!confirmed) return yield* Effect.sync(() => process.stdout.write("Cancelled. Nothing removed.\n"))
    const result = yield* Effect.tryPromise(() => removeInstallation(plan))
    yield* Effect.sync(() => process.stdout.write(
      result.pendingWindowsExit
        ? `Release files removed. Windows will remove phins.exe after this process exits. If it remains, check: ${result.diagnostic}\n`
        : "PHINs Agent uninstalled.\n",
    ))
    yield* Effect.sync(() => process.stdout.write(input.all ? "Default profile removed.\n" : "Profile retained.\n"))
  }).pipe(Effect.provide(NodeServices.layer)),
)
