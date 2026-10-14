/**
 * Process entrypoint của CLI.
 *
 * Khai báo lazy handler map, cung cấp các service rồi giao parse,
 * dispatch và process lifecycle cho Effect CLI runtime.
 * @module
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { InstallationVersion } from "@phins/engine/runtime/version"
import * as Effect from "effect/Effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import { Flag } from "@phins/engine/runtime/flags"
import { ensureProviderConfig } from "../shared/provider-setup"
import { Commands } from "./commands"
import { CommandDispatcher } from "./dispatcher"
import { TuiHost, type TuiHostLoader } from "../tui/host-config"

// Mapping này là registry implementation: command có spec nhưng thiếu loader
// sẽ chỉ là parent/help node, không thể thực thi side effect.
const Handlers = CommandDispatcher.bindHandlers(Commands, {
  $: () => import("./actions/interactive"),
  "agent-host": () => import("./actions/host"),
  ask: () => import("./actions/ask"),
  setup: () => import("./actions/setup"),
  resume: () => import("./actions/resume"),
})

export function runCli(argv?: ReadonlyArray<string>, options?: { tuiHost?: TuiHostLoader }) {
  const args = argv ?? process.argv.slice(2)
  const profile = args.includes("--help") || args.includes("--version")
    ? Effect.void
    : Effect.tryPromise(() => ensureProviderConfig(AppPaths.resolvePaths().config, Flag.PHINS_CONFIG))
  return profile.pipe(Effect.andThen(CommandDispatcher.runCommands(Commands, Handlers, {
    version: InstallationVersion,
    arguments: argv,
  })),
    Effect.provideService(TuiHost, options?.tuiHost),
    Effect.provide(NodeServices.layer), Effect.scoped,
  )
}
