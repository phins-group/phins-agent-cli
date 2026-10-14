import type { Tool as McpDefinition } from "@modelcontextprotocol/sdk/types.js"
import { AgentRegistry } from "../../src/agents/registry"
import { Config } from "../../src/settings/config"
import { ConfigMCP } from "../../src/settings/mcp"
import { Location } from "../../src/workspace/location"
import { McpLocal } from "../../src/extensions/mcp/local"
import { McpToolNames } from "../../src/extensions/mcp/tool-names"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionMessage } from "../../src/sessions/messages/service"
import { ApplicationTools } from "../../src/tools/application"
import { ToolRegistry } from "../../src/tools/registry"
import { ToolOutputStore } from "../../src/tools/output-store"
import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"

const entry = path.join(import.meta.dir, "fixture-server.mjs")
const tool = (name: string): McpDefinition => ({
  name,
  inputSchema: { type: "object" },
})
type Trace = {
  event: string
  pid?: number
  cwd?: string
  method?: string
  params?: { name?: string }
}
async function until<A>(read: () => Promise<A | undefined>) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for owned MCP fixture")
}
const calls = (trace: Trace[]) =>
  trace.filter((row) => row.method === "tools/call")
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID: SessionManager.ID.make("ses_mcp_local"),
  agent: AgentRegistry.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_mcp_local"),
  call: { type: "tool-call", id: "call-mcp-local", name, input: {} },
})

async function fixture() {
  const dir = await tmpdir()
  const servers = new Map<string, { control: string; trace: string }>()
  const create = async (
    name: string,
    tools = [tool("echo")],
    mode?: string,
  ) => {
    const control = path.join(dir.path, `${name}.json`)
    const trace = path.join(dir.path, `${name}.jsonl`)
    servers.set(name, { control, trace })
    await fs.writeFile(control, JSON.stringify({ tools, mode }))
    return new ConfigMCP.Local({
      type: "local",
      command: [process.execPath, entry, control, trace],
      environment: { FIXTURE_MCP_SECRET: "private-mcp-stderr" },
      timeout: 1000,
    })
  }
  const records = async (name: string): Promise<Trace[]> =>
    fs
      .readFile(servers.get(name)!.trace, "utf8")
      .then((raw) =>
        raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      })
  const update = (name: string, tools: McpDefinition[], mode?: string) =>
    fs.writeFile(servers.get(name)!.control, JSON.stringify({ tools, mode }))
  return { dir, create, records, update }
}

async function boot(
  directory: string,
  documents: ConfigMCP.Info[],
  assert: PermissionPolicy.Interface["assert"] = () => Effect.void,
  signal?: AbortSignal,
) {
  const scope = await Effect.runPromise(Scope.make())
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(ApplicationTools.layer),
    Layer.provide(
      Layer.mock(ToolOutputStore.Service, {
        bound: (input) =>
          Effect.succeed({ output: input.output, outputPaths: [] }),
      }),
    ),
  )
  const layer = McpLocal.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        registry,
        Layer.succeed(Config.Service, {
          entries: () =>
            Effect.succeed(
              documents.map(
                (mcp) =>
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({ mcp }),
                  }),
              ),
            ),
        }),
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make(directory),
            project: {
              id: ProjectRegistry.ID.make("project_mcp"),
              directory: AbsolutePath.make(directory),
            },
          }),
        ),
        Layer.mock(PermissionPolicy.Service, { assert }),
      ),
    ),
  )
  try {
    const context = await Effect.runPromise(
      Layer.build(layer).pipe(Scope.provide(scope)),
      { signal },
    )
    return {
      mcp: Context.get(context, McpLocal.Service),
      registry: Context.get(context, ToolRegistry.Service),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
const catalog = (registry: ToolRegistry.Interface) =>
  Effect.runPromise(registry.materialize())
const names = async (registry: ToolRegistry.Interface) =>
  (await catalog(registry)).definitions.map((item) => item.name)

describe("Location-owned local MCP", () => {
  test("explicit toggles close the owned child, fence old tools and reconnect once", async () => {
    const f = await fixture()
    const service = await boot(f.dir.path, [new ConfigMCP.Info({
      servers: { local: await f.create("local") },
    })])
    try {
      const first = (await f.records("local")).find((row) => row.event === "started")!
      expect(await names(service.registry)).toEqual(["local_echo"])
      await Effect.runPromise(service.mcp.setEnabled("local", false))
      expect(alive(first.pid!)).toBe(false)
      expect(await names(service.registry)).toEqual([])
      expect(await Effect.runPromise(service.mcp.status())).toEqual({ local: { status: "disabled" } })
      await Effect.runPromise(service.mcp.setEnabled("local", true))
      await Effect.runPromise(service.mcp.setEnabled("local", true))
      expect((await f.records("local")).filter((row) => row.event === "started")).toHaveLength(2)
      expect(await names(service.registry)).toEqual(["local_echo"])
      const missing = await Effect.runPromise(service.mcp.setEnabled("missing", true).pipe(Effect.flip))
      expect(missing.message).toBe("MCP server is not configured")
      expect(await names(service.registry)).toEqual(["local_echo"])
    } finally {
      await service.close()
      await f.dir[Symbol.asyncDispose]()
    }
  })

  test("does not create registrations when MCP is not configured", async () => {
    const f = await fixture()
    const service = await boot(f.dir.path, [])
    try {
      expect(await names(service.registry)).toEqual([])
      expect(await Effect.runPromise(service.mcp.status())).toEqual({})
      await Effect.runPromise(service.mcp.refresh())
      expect(await names(service.registry)).toEqual([])
    } finally {
      await service.close()
      await f.dir[Symbol.asyncDispose]()
    }
  })

  test("interrupted initialization closes the owned subprocess", async () => {
    const f = await fixture()
    const abort = new AbortController()
    let close: (() => Promise<void>) | undefined
    try {
      const config = new ConfigMCP.Info({
        servers: { local: await f.create("local", [], "hang") },
      })
      const pending = boot(f.dir.path, [config], undefined, abort.signal).then(
        (service) => {
          close = service.close
          return undefined
        },
        (error: unknown) => error,
      )
      const started = await until(async () =>
        (await f.records("local")).find((row) => row.event === "started"),
      )
      abort.abort()
      expect(await pending).toBeInstanceOf(Error)
      expect(alive(started.pid!)).toBe(false)
      expect((await f.records("local")).at(-1)?.event).toBe("closed")
    } finally {
      abort.abort()
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("rejects final-name collisions without overwriting a canonical tool", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const collision = McpToolNames.names([
        { server: "local", tool: "a.b" },
        { server: "local", tool: "a_b" },
      ])[0]!
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: {
            local: await f.create("local", [
              tool("a.b"),
              tool("a_b"),
              tool(collision.slice("local_".length)),
            ]),
          },
        }),
      ])
      close = service.close
      expect(await names(service.registry)).toEqual([])
      expect(await Effect.runPromise(service.mcp.status())).toEqual({
        local: { status: "failed", error: "Duplicate canonical MCP tool name" },
      })
      expect(
        alive(
          (await f.records("local")).find((row) => row.event === "started")!
            .pid!,
        ),
      ).toBe(false)
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("enforces declared output schema, bounds negative results and cancels timed-out calls", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const outputSchema = {
        type: "object" as const,
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { text: { type: "string" } },
        unevaluatedProperties: false,
        required: ["required-field"],
      }
      const server = new ConfigMCP.Local({
        ...(await f.create(
          "local",
          [
            { ...tool("echo"), outputSchema },
            { ...tool("error"), outputSchema },
            tool("hold"),
          ],
          "paged",
        )),
        timeout: 500,
      })
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({ servers: { local: server } }),
      ])
      close = service.close
      const tools = await catalog(service.registry)
      expect(
        (await Effect.runPromise(tools.settle(call("local_echo")))).result,
      ).toEqual({ type: "error", value: "MCP tool call failed: local_echo" })
      const negative = await Effect.runPromise(
        tools.settle(call("local_error")),
      )
      expect(negative.result).toEqual({
        type: "error",
        value: "fixture result",
      })
      expect(
        (await Effect.runPromise(tools.settle(call("local_hold")))).result,
      ).toEqual({ type: "error", value: "MCP tool call failed: local_hold" })
      const trace = await until(async () => {
        const trace = await f.records("local")
        return trace.some((row) => row.method === "notifications/cancelled")
          ? trace
          : undefined
      })
      expect(calls(trace).map((row) => row.params?.name)).toEqual([
        "echo",
        "error",
        "hold",
      ])
      expect(await Effect.runPromise(service.mcp.status())).toEqual({
        local: { status: "connected" },
      })
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("is ready on the first consumer, pages tools and closes its own subprocess", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const server = new ConfigMCP.Local({
        ...(await f.create("local", [tool("notes"), tool("echo")], "paged")),
        cwd: "./project",
      })
      await fs.mkdir(path.join(f.dir.path, "project"))
      await fs.writeFile(
        path.join(f.dir.path, "project/notes.md"),
        "PRIVATE_PROJECT_NOTE",
      )
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({ servers: { local: server } }),
      ])
      close = service.close
      expect(await names(service.registry)).toEqual([
        "local_notes",
        "local_echo",
      ])
      expect(await Effect.runPromise(service.mcp.status())).toEqual({
        local: { status: "connected" },
      })
      const materialized = await catalog(service.registry)
      const result = await Effect.runPromise(
        materialized.settle(call("local_notes")),
      )
      expect(result.result.type).toBe("content")
      expect(JSON.stringify(result)).toContain("PRIVATE_PROJECT_NOTE")
      const trace = await f.records("local")
      const started = trace.find((row) => row.event === "started")!
      expect(started.cwd).toBe(path.join(f.dir.path, "project"))
      expect(calls(trace)).toHaveLength(1)
      await close()
      close = undefined
      expect(
        await until(async () => (alive(started.pid!) ? undefined : false)),
      ).toBe(false)
      expect((await f.records("local")).at(-1)?.event).toBe("closed")
      expect(
        (await Effect.runPromise(materialized.settle(call("local_notes"))))
          .result.type,
      ).toBe("error")
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("honors project overrides and never launches disabled or remote entries", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const disabled = new ConfigMCP.Local({
        ...(await f.create("disabled")),
        disabled: true,
      })
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: { same: await f.create("global", [tool("global")]) },
        }),
        new ConfigMCP.Info({
          servers: {
            same: await f.create("project", [tool("project")]),
            disabled,
            remote: new ConfigMCP.Remote({
              type: "remote",
              url: "https://invalid.test/no-connect",
            }),
          },
        }),
      ])
      close = service.close
      expect(await names(service.registry)).toEqual(["same_project"])
      expect(await f.records("global")).toEqual([])
      expect(await f.records("disabled")).toEqual([])
      expect(await Effect.runPromise(service.mcp.status())).toMatchObject({
        same: { status: "connected" },
        disabled: { status: "disabled" },
        remote: { status: "unsupported" },
      })
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("isolates failed startup, duplicate pagination and invalid schema from healthy servers", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const hang = new ConfigMCP.Local({
        ...(await f.create("hang", [], "hang")),
        timeout: 150,
      })
      const invalid: McpDefinition = {
        name: "invalid",
        inputSchema: {
          type: "object",
          properties: { value: { type: "not-a-json-type" } },
        },
      }
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: {
            healthy: await f.create("healthy"),
            hang,
            cursor: await f.create("cursor", [], "bad-cursor"),
            duplicate: await f.create("duplicate", [
              tool("same"),
              tool("same"),
            ]),
            schema: await f.create("schema", [tool("valid"), invalid]),
            missing: new ConfigMCP.Local({
              type: "local",
              command: [path.join(f.dir.path, "missing-command")],
              timeout: 100,
            }),
          },
        }),
      ])
      close = service.close
      expect(await names(service.registry)).toEqual(["healthy_echo"])
      const status = await Effect.runPromise(service.mcp.status())
      expect(status.healthy?.status).toBe("connected")
      for (const name of ["hang", "cursor", "duplicate", "schema", "missing"])
        expect(status[name]?.status).toBe("failed")
      expect(JSON.stringify(status)).not.toContain("private-mcp-stderr")
      for (const name of ["hang", "cursor", "duplicate", "schema"])
        expect(
          alive(
            (await f.records(name)).find((row) => row.event === "started")!
              .pid!,
          ),
        ).toBe(false)
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("an already-started RPC validates its captured schema after catalog refresh", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const definition = (value: string): McpDefinition => ({
        ...tool("hold"),
        outputSchema: {
          type: "object",
          properties: { text: { const: value } },
          required: ["text"],
          unevaluatedProperties: false,
        },
      })
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: { local: await f.create("local", [definition("old")]) },
        }),
      ])
      close = service.close
      const first = await catalog(service.registry)
      const pending = Effect.runPromise(first.settle(call("local_hold")))
      await until(async () =>
        calls(await f.records("local")).length > 0 ? true : undefined,
      )
      await f.update("local", [definition("new"), tool("release")])
      await Effect.runPromise(service.mcp.refresh())
      const latest = await catalog(service.registry)
      expect(
        (await Effect.runPromise(latest.settle(call("local_release")))).result
          .type,
      ).toBe("text")
      const completed = await pending
      expect(completed.result.type).toBe("content")
      expect(completed.output?.structured).toMatchObject({
        structuredContent: { text: "old" },
      })
      expect(
        (await Effect.runPromise(first.settle(call("local_hold")))).result,
      ).toEqual({ type: "error", value: "Stale tool call: local_hold" })
      expect(
        calls(await f.records("local")).map((row) => row.params?.name),
      ).toEqual(["hold", "release"])
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("rejects unsupported schemas and required-task tools without invoking them", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: {
            input: await f.create("input", [
              {
                ...tool("echo"),
                inputSchema: { type: "object", unknownConstraint: false },
              },
            ]),
            output: await f.create("output", [
              {
                ...tool("echo"),
                outputSchema: { type: "object", unknownConstraint: false },
              },
            ]),
            task: await f.create("task", [
              { ...tool("echo"), execution: { taskSupport: "required" } },
            ]),
          },
        }),
      ])
      close = service.close
      expect(await names(service.registry)).toEqual([])
      const status = await Effect.runPromise(service.mcp.status())
      for (const name of ["input", "output", "task"]) {
        expect(status[name]?.status).toBe("failed")
        expect(calls(await f.records(name))).toEqual([])
        expect(
          alive(
            (await f.records(name)).find((row) => row.event === "started")!
              .pid!,
          ),
        ).toBe(false)
      }
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("refresh replaces the advertised batch and fences pending permission", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const waiting = await Effect.runPromise(Deferred.make<void>())
      const approval = await Effect.runPromise(Deferred.make<void>())
      const service = await boot(
        f.dir.path,
        [new ConfigMCP.Info({ servers: { local: await f.create("local") } })],
        () =>
          Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(Deferred.await(approval)),
          ),
      )
      close = service.close
      const first = await catalog(service.registry)
      const pending = Effect.runFork(first.settle(call("local_echo")))
      await Effect.runPromise(Deferred.await(waiting))
      await f.update("local", [tool("new")])
      await Effect.runPromise(service.mcp.refresh())
      expect(await names(service.registry)).toEqual(["local_new"])
      await Effect.runPromise(Deferred.succeed(approval, undefined))
      expect((await Effect.runPromise(Fiber.join(pending))).result.type).toBe(
        "error",
      )
      expect(
        (await Effect.runPromise(first.settle(call("local_echo")))).result,
      ).toEqual({ type: "error", value: "Stale tool call: local_echo" })
      expect(calls(await f.records("local"))).toEqual([])
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("refreshes list-change notifications and removes disconnected servers", async () => {
    const f = await fixture()
    let close: (() => Promise<void>) | undefined
    try {
      const service = await boot(f.dir.path, [
        new ConfigMCP.Info({
          servers: {
            local: await f.create("local", [
              tool("notify"),
              tool("disconnect"),
            ]),
          },
        }),
      ])
      close = service.close
      const first = await catalog(service.registry)
      await f.update("local", [tool("disconnect"), tool("new")])
      await Effect.runPromise(first.settle(call("local_notify")))
      await until(async () =>
        (await names(service.registry)).includes("local_new")
          ? true
          : undefined,
      )
      expect(
        (await Effect.runPromise(first.settle(call("local_disconnect")))).result
          .type,
      ).toBe("error")
      const latest = await catalog(service.registry)
      expect(
        (await Effect.runPromise(latest.settle(call("local_disconnect"))))
          .result.type,
      ).toBe("error")
      await until(async () =>
        (await names(service.registry)).length === 0 ? true : undefined,
      )
      expect(await Effect.runPromise(service.mcp.status())).toEqual({
        local: { status: "disconnected" },
      })
      expect(calls(await f.records("local"))).toHaveLength(2)
    } finally {
      await close?.()
      await f.dir[Symbol.asyncDispose]()
    }
  }, 10_000)

  test("keeps legacy name sanitization stable under collision and reorder", () => {
    const input = [
      { server: "code-host", tool: "a.b" },
      { server: "code-host", tool: "a_b" },
      { server: "long".repeat(20), tool: "long".repeat(20) },
    ]
    const first = McpToolNames.names(input)
    expect(new Set(first).size).toBe(3)
    expect(first.every((name) => name.length <= 64)).toBe(true)
    expect(McpToolNames.names(input.toReversed())).toEqual(first.toReversed())
    expect(McpToolNames.names([{ server: "notes", tool: "search" }])).toEqual([
      "notes_search",
    ])
  })
})
