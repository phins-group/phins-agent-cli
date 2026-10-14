/** Internal execution host of this same CLI, never a second agent implementation. */
import { Effect } from "effect"
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { runAgentHost } from "../../agent/host"

export default CommandDispatcher.defineHandler(Commands.commands["agent-host"], (input) =>
  Effect.tryPromise(() => runAgentHost(input)),
)
