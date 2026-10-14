import { AgentRegistry } from "../../../agents/registry"
import { ToolRegistry } from "../../../tools/registry"
import { Location } from "../../../workspace/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ServiceUnavailableError } from "../../api/errors"
import { Api } from "../api"
import { response } from "../location"

const execute = promisify(execFile)
export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) => handlers
  .handle("project.tools", () => response(Effect.gen(function* () {
    const agent = yield* (yield* AgentRegistry.Service).default()
    const registry = yield* ToolRegistry.Service
    const permissions = agent?.permissions ?? []
    const tools = yield* registry.materialize(permissions)
    return { ids: tools.definitions.map((definition) => definition.name), permissions }
  })))
  .handle("project.diff", () => response(Effect.gen(function* () {
    const location = yield* Location.Service
    const output = yield* Effect.tryPromise({
      try: (signal) => execute("git", ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"], {
        cwd: location.directory, signal, timeout: 5_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      }),
      catch: () => new ServiceUnavailableError({ message: "Git diff is unavailable, too large or timed out. No changes were applied." }),
    })
    return { text: output.stdout }
  }))),
)
