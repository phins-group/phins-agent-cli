import path from "node:path"
import * as LocalPolicy from "../../security/launcher-policy"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool as McpDefinition,
} from "@modelcontextprotocol/sdk/types.js"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Queue,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { Config } from "../../settings/config"
import { ConfigMCP } from "../../settings/mcp"
import { Location } from "../../workspace/location"
import { InstallationVersion } from "../../runtime/version"
import { PermissionPolicy } from "../../security/permissions/service"
import { Tool } from "../../tools/definition"
import { Tools } from "../../tools/registration"
import { McpTool } from "./tool"
import { McpToolNames } from "./tool-names"
import { McpSchema } from "./schema"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

export type Status = {
  status: "connected" | "disabled" | "unsupported" | "failed" | "disconnected"
  error?: string
}
export interface Interface {
  readonly status: () => Effect.Effect<Readonly<Record<string, Status>>>
  readonly refresh: () => Effect.Effect<void>
  readonly setEnabled: (name: string, enabled: boolean) => Effect.Effect<void, Failure>
}
export class Service extends Context.Service<Service, Interface>()(
  "@phins/McpLocal",
) {}

export class Failure extends Schema.TaggedErrorClass<Failure>()("McpLocal.Failure", {
  message: Schema.String,
}) {}

type Connection = {
  name: string
  client: Client
  scope: Scope.Closeable
  timeout: number
  live: boolean
  definitions: McpDefinition[]
}

const list = (connection: Connection) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!connection.client.getServerCapabilities()?.tools) return []
      const tools: McpDefinition[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await connection.client.listTools(
          cursor === undefined ? undefined : { cursor },
          { signal, timeout: connection.timeout },
        )
        for (const tool of result.tools) {
          if (names.has(tool.name)) throw new Error("Duplicate MCP tool")
          names.add(tool.name)
          tools.push(tool)
        }
        if (result.nextCursor === undefined) return tools
        if (cursors.has(result.nextCursor))
          throw new Error("Repeated MCP cursor")
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      throw new Error("MCP catalog exceeded the page limit")
    },
    catch: () => new Failure({ message: "Unable to load MCP tool catalog" }),
  })

/** Location-owned stdio clients contribute only canonical tools. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionPolicy.Service
    const configured = new Map<string, typeof ConfigMCP.Server.Type>()
    let timeout = DEFAULT_TIMEOUT
    for (const entry of yield* config.entries()) {
      if (entry.type !== "document" || !entry.info.mcp) continue
      timeout = entry.info.mcp.timeout ?? timeout
      for (const [name, value] of Object.entries(entry.info.mcp.servers ?? {}))
        configured.set(name, value)
    }
    if (LocalPolicy.enabled) configured.clear()
    if (configured.size === 0)
      return Service.of({
        status: () => Effect.succeed({}),
        refresh: () => Effect.void,
        setEnabled: () => Effect.fail(new Failure({ message: "MCP server is not configured" })),
      })
    const mutex = yield* Semaphore.make(1)
    // Coalesce notifications; a refresh reads every live connection.
    const notifications = yield* Queue.dropping<void>(1)
    yield* Effect.addFinalizer(() => Queue.shutdown(notifications))
    const statuses = new Map<string, Status>()
    const connections = new Map<string, Connection>()
    let registration: Scope.Closeable | undefined
    const removeTools = Effect.suspend(() => {
      const previous = registration
      registration = undefined
      return previous ? Scope.close(previous, Exit.void) : Effect.void
    })
    const fail = Effect.fnUntraced(function* (
      connection: Connection,
      error: string,
    ) {
      connection.live = false
      connection.definitions = []
      statuses.set(connection.name, { status: "failed", error })
      yield* Scope.close(connection.scope, Exit.void)
    })

    yield* Effect.addFinalizer(() => Effect.forEach(connections.values(),
      (connection) => Scope.close(connection.scope, Exit.void), { discard: true }))
    const connect = Effect.fnUntraced(function* (name: string) {
      const value = configured.get(name)
      if (!value) return yield* new Failure({ message: "MCP server is not configured" })
      if (connections.get(name)?.live) return
      if (value.type !== "local") {
        statuses.set(name, {
          status: "unsupported",
          error: "Remote MCP is not enabled in this local service",
        })
        return
      }
      const [command, ...args] = value.command
      if (!command) {
        statuses.set(name, { status: "failed", error: "MCP command is empty" })
        return
      }
      const scope = yield* Scope.make()
      const client = new Client(
        { name: "phins", version: InstallationVersion },
        {
          capabilities: { roots: {} },
          jsonSchemaValidator: McpSchema.validator,
        },
      )
      const connection: Connection = {
        name,
        client,
        scope,
        timeout: value.timeout ?? timeout,
        live: true,
        definitions: [],
      }
      connections.set(name, connection)
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(location.directory).href }],
      }))
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          Queue.offerUnsafe(notifications, undefined)
        },
      )
      client.onclose = () => {
        if (!connection.live) return
        connection.live = false
        Queue.offerUnsafe(notifications, undefined)
      }
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: path.resolve(location.directory, value.cwd ?? "."),
        env: value.environment,
        stderr: "pipe",
      })
      // Drain child stderr without forwarding secrets or untrusted log messages.
      transport.stderr?.on("data", () => {})
      yield* Effect.acquireRelease(Effect.succeed(client), (client) =>
        Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
      ).pipe(Scope.provide(scope))
      yield* Effect.tryPromise({
        try: (signal) =>
          client.connect(transport, { signal, timeout: connection.timeout }),
        catch: () =>
          new Failure({ message: "Unable to connect local MCP server" }),
      }).pipe(
        Effect.andThen(list(connection)),
        Effect.tap((definitions) =>
          Effect.sync(() => {
            connection.definitions = definitions
            statuses.set(name, { status: "connected" })
          }),
        ),
        Effect.catchTag("McpLocal.Failure", (error) =>
          fail(connection, error.message),
        ),
      )
    })
    for (const [name, value] of configured) {
      if (value.disabled) statuses.set(name, { status: "disabled" })
      else yield* connect(name).pipe(Effect.orDie)
    }

    const register = Effect.fnUntraced(function* () {
      const entries = [...connections.values()]
        .filter((item) => item.live)
        .flatMap((connection) =>
          connection.definitions.map((definition) => ({
            connection,
            definition,
          })),
        )
      const names = McpToolNames.names(
        entries.map(({ connection, definition }) => ({
          server: connection.name,
          tool: definition.name,
        })),
      )
      const counts = new Map<string, number>()
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
      for (let index = 0; index < entries.length; index++)
        if (counts.get(names[index]!)! > 1)
          yield* fail(
            entries[index]!.connection,
            "Duplicate canonical MCP tool name",
          )
      const scope = yield* Scope.make()
      registration = scope
      let active = true
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          active = false
        }),
      ).pipe(Scope.provide(scope))
      const canonical: Record<string, Tool.AnyTool> = Object.create(null)
      for (let index = 0; index < entries.length; index++) {
        const { connection, definition } = entries[index]!
        const name = names[index]!
        if (!connection.live) continue
        yield* Tool.validateName(name).pipe(
          Effect.mapError(
            () => new Failure({ message: "Invalid canonical MCP tool name" }),
          ),
          Effect.andThen(
            Effect.try({
              try: () =>
                McpTool.make({
                  name,
                  server: connection.name,
                  definition,
                  client: connection.client,
                  permission,
                  timeout: connection.timeout,
                  active: () => active && connection.live,
                }),
              catch: () =>
                new Failure({ message: "Unsupported MCP tool definition" }),
            }),
          ),
          Effect.tap((tool) =>
            Effect.sync(() => {
              canonical[name] = tool
            }),
          ),
          Effect.catchTag("McpLocal.Failure", (error) =>
            fail(connection, error.message),
          ),
        )
      }
      // A failed server contributes no earlier tools from the same batch.
      for (let index = 0; index < entries.length; index++)
        if (!entries[index]!.connection.live) delete canonical[names[index]!]
      yield* tools.register(canonical).pipe(Scope.provide(scope), Effect.orDie)
    })
    const refresh = Effect.gen(function* () {
      yield* removeTools
      for (const connection of connections.values()) {
        if (!connection.live) {
          if (statuses.get(connection.name)?.status === "connected")
            statuses.set(connection.name, { status: "disconnected" })
          continue
        }
        yield* list(connection).pipe(
          Effect.tap((definitions) =>
            Effect.sync(() => {
              connection.definitions = definitions
            }),
          ),
          Effect.catchTag("McpLocal.Failure", (error) =>
            fail(connection, error.message),
          ),
        )
      }
      yield* register()
    }).pipe(mutex.withPermit)
    yield* Effect.addFinalizer(() => removeTools)
    yield* register()
    yield* Effect.forever(
      Queue.take(notifications).pipe(Effect.andThen(refresh)),
    ).pipe(Effect.forkScoped)
    return Service.of({
      status: () =>
        Effect.sync(() =>
          Object.fromEntries(
            [...statuses].map(([name, status]) => [
              name,
              status.status === "connected" && !connections.get(name)?.live
                ? { status: "disconnected" as const }
                : { ...status },
            ]),
          ),
        ),
      refresh: () => refresh,
      setEnabled: (name, enabled) => Effect.gen(function* () {
        if (!configured.has(name)) return yield* new Failure({ message: "MCP server is not configured" })
        if (enabled && connections.get(name)?.live && statuses.get(name)?.status === "connected") return
        yield* removeTools
        if (enabled) yield* connect(name)
        else {
          const connection = connections.get(name)
          if (connection) {
            connection.live = false
            connection.definitions = []
            yield* Scope.close(connection.scope, Exit.void)
          }
          statuses.set(name, { status: "disabled" })
        }
        yield* register()
        const status = statuses.get(name)
        if (enabled && status?.status !== "connected")
          return yield* new Failure({ message: status?.error ?? "Unable to connect MCP server" })
      }).pipe(mutex.withPermit),
    })
  }),
)

export * as McpLocal from "./local"
