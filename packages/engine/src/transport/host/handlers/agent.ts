/** Hiện thực V2 `agent.list` bằng service AgentRegistry. @module */
import { AgentRegistry } from "../../../agents/registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers.handle("agent.list", () =>
    Effect.gen(function* () {
      return yield* response(AgentRegistry.Service.use((agent) => agent.all()))
    }),
  ),
)
