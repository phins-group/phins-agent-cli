/** Hiện thực V2 `command.list` bằng registry CommandRegistry. @module */
import { CommandRegistry } from "../../../agents/commands"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () => response(CommandRegistry.Service.use((command) => command.list()))),
)
