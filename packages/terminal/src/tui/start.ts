import type { LocalServiceConnection } from "@phins/engine/transport/client/connection"
import { Effect } from "effect"
import { AppPaths } from "@phins/engine/runtime/paths"
import { TuiHost } from "./host-config"
import { createTuiTransport } from "./transport/client"
import path from "node:path"

export function runTui(
  connection: LocalServiceConnection,
  sessionID?: string,
  recordOnly = false,
  options: { directory?: string; model?: string; agent?: string; prompt?: string } = {},
) {
  return Effect.scoped(Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* Effect.fail(
        new Error(
          "Interactive mode requires a terminal; use phins ask",
        ),
      )
    const directory = path.resolve(options.directory ?? process.cwd())
    const transport = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => createTuiTransport(connection, directory, { recordOnly }), catch: (cause) => cause }),
      (transport) => Effect.promise(() => transport.dispose()),
    )
    // Only the client cwd changes; no embedded engine/worker is started.
    const cwd = process.cwd()
    yield* Effect.acquireRelease(
      Effect.try({ try: () => process.chdir(directory), catch: (cause) => cause }),
      () => Effect.sync(() => process.chdir(cwd)),
    )
    yield* Effect.promise(() => import("@opentui/solid/preload"))
    const host = yield* TuiHost
    const setup = host
      ? yield* Effect.tryPromise(() => host(directory))
      : yield* Effect.tryPromise(async () => {
          const { TuiConfig } = await import("./config/settings")
          const { createBuiltinTuiPluginHost } = await import("./extensions/builtin-host")
          return { config: TuiConfig.resolve({}),
            pluginHost: createBuiltinTuiPluginHost() }
        })
    const { run } = yield* Effect.promise(() => import("./app"))
    yield* run({
      url: connection.url, headers: connection.headers, directory,
      ...transport, ...setup,
      args: { sessionID, model: options.model, agent: options.agent, prompt: options.prompt },
    }).pipe(Effect.provide(AppPaths.defaultLayer))
  }))
}
