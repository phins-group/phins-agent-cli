import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { connectTarget } from "../../agent/session-target"

export default CommandDispatcher.defineHandler(
  Commands.commands.resume,
  Effect.fn("cli.resume")(function* (input) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* Effect.fail(
        new Error("Interactive mode requires a terminal; use phins ask"),
      )
    const target = yield* connectTarget(
      { session: input.session, project: Option.getOrUndefined(input.project) },
      "tui",
    )
    const { runTui } = yield* Effect.promise(() => import("../../tui/start"))
    yield* runTui(target.connection, target.session.id, false, {
      directory: target.session.location.directory,
    })
  }),
)
