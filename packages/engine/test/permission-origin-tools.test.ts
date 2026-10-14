import { describe, expect } from "bun:test"
import { AgentRegistry } from "../src/agents/registry"
import { Config } from "../src/settings/config"
import { EventBus } from "../src/runtime/events/bus"
import { FileMutation } from "../src/workspace/files/mutation"
import { FileAccess } from "../src/workspace/files/access"
import { Image } from "../src/workspace/media/image"
import { LocationMutation } from "../src/workspace/mutations"
import { McpTool } from "../src/extensions/mcp/tool"
import { PermissionPolicy } from "../src/security/permissions/service"
import { PermissionOrigin } from "../src/security/permissions/origin"
import * as Delegation from "../src/security/permissions/delegation"
import { PluginTools } from "../src/extensions/tools"
import { ProcessRunner } from "../src/execution/process/runner"
import { ProcessSessions } from "../src/execution/process/sessions"
import { BashTool } from "../src/tools/process/shell"
import { ReadTool } from "../src/tools/files/read"
import { ReadToolFileSystem } from "../src/tools/files/reader"
import { ToolRegistry } from "../src/tools/registry"
import { WriteTool } from "../src/tools/files/write"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { permissionLayer, sessionID, setup } from "./fixture/permission"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const allowAll: PermissionPolicy.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
]
const call = (name: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  agent: AgentRegistry.ID.make("test"),
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

function toolsLayer(
  directory: string,
  onShell: () => void,
  onBackground?: () => void,
) {
  const config = Layer.mock(Config.Service, {
    entries: () => Effect.succeed([]),
  })
  const base = Layer.mergeAll(
    permissionLayer(directory),
    ToolRegistry.defaultLayer,
    FileAccess.defaultLayer,
    config,
  )
  const mutation = LocationMutation.layer.pipe(Layer.provide(base))
  const files = FileMutation.layer.pipe(Layer.provide(base))
  const reader = ReadToolFileSystem.layer.pipe(Layer.provide(base))
  const image = Image.layer.pipe(Layer.provide(base))
  const process = Layer.mock(ProcessRunner.Service, {
    run: () =>
      Effect.sync(() => {
        onShell()
        return {
          command: "fixture",
          exitCode: 0,
          stdout: Buffer.from("fixture"),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
  })
  const write = WriteTool.layer.pipe(Layer.provide([base, mutation, files]))
  const read = ReadTool.layer.pipe(Layer.provide([base, reader, image]))
  const processes = onBackground
    ? Layer.mock(ProcessSessions.Service, {
        start: () =>
          Effect.sync(onBackground).pipe(
            Effect.andThen(Effect.die("Unexpected spawn")),
          ),
      })
    : ProcessSessions.layer
  const bash = BashTool.layer.pipe(
    Layer.provide([base, mutation, process, processes]),
  )
  return Layer.mergeAll(base, write, read, bash)
}

const withTools = <A, E, R>(
  work: (directory: string) => Effect.Effect<A, E, R>,
  onShell: () => void = () => {},
  onBackground?: () => void,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      work(tmp.path).pipe(
        Effect.provide(toolsLayer(tmp.path, onShell, onBackground)),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("origin-constrained canonical tools", () => {
  it.live("foreground subtasks cannot leave background processes behind", () => {
    let spawned = 0
    return withTools(() => Effect.gen(function* () {
      yield* setup(allowAll)
      const registry = yield* ToolRegistry.Service
      const result = yield* Delegation.restrict({ sessionID, rules: allowAll, valid: Effect.succeed(true) },
        executeTool(registry, call("bash", { command: "fixture only", yieldTimeMs: 0 })))
      expect(result.type).toBe("error")
      expect(spawned).toBe(0)
    }), () => { spawned++ }, () => { spawned++ })
  })
  it.live(
    "rejects background shell handles before spawn even with a full origin grant",
    () => {
      let shells = 0
      let background = 0
      return withTools(
        () =>
          Effect.gen(function* () {
            yield* setup(allowAll)
            const registry = yield* ToolRegistry.Service
            const result = yield* PermissionOrigin.restrict(
              { sessionID, rules: allowAll, valid: Effect.succeed(true) },
              executeTool(
                registry,
                call("bash", { command: "fixture only", yieldTimeMs: 0 }),
              ),
            )
            expect(result.type).toBe("error")
            expect(JSON.stringify(result)).toContain(
              "Background processes are not available",
            )
            expect([shells, background]).toEqual([0, 0])
          }),
        () => {
          shells++
        },
        () => {
          background++
        },
      )
    },
  )

  it.live(
    "blocks write, shell, plugin and MCP leaves even when their definitions are advertised locally",
    () => {
      let shells = 0
      return withTools(
        (directory) =>
          Effect.gen(function* () {
            yield* setup(allowAll)
            const registry = yield* ToolRegistry.Service
            const permission = yield* PermissionPolicy.Service
            const target = path.join(directory, "fixture.txt")
            yield* Effect.promise(() => fs.writeFile(target, "before"))
            let plugins = 0
            yield* (yield* PluginTools.make()).register("plugin_write", {
              description: "Fixture plugin",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () =>
                Effect.sync(() => {
                  plugins++
                  return "plugin"
                }),
            })
            let requests = 0
            yield* registry.register({
              mcp_write: McpTool.make({
                name: "mcp_write",
                server: "fixture",
                definition: { name: "write", inputSchema: { type: "object" } },
                timeout: 1000,
                active: () => true,
                permission,
                client: {
                  request: async () => {
                    requests++
                    return { content: [{ type: "text", text: "mcp" }] }
                  },
                },
              }),
            })
            expect(
              (yield* registry.materialize(allowAll)).definitions
                .map((tool) => tool.name)
                .sort(),
            ).toEqual(["bash", "mcp_write", "plugin_write", "read", "write"])
            yield* PermissionOrigin.restrict(
              {
                sessionID,
                rules: [
                  { action: "read", resource: "fixture.txt", effect: "allow" },
                ],
                valid: Effect.succeed(true),
              },
              Effect.gen(function* () {
                const read = yield* executeTool(
                  registry,
                  call("read", { path: "fixture.txt" }),
                )
                expect(read.type).not.toBe("error")
                expect(JSON.stringify(read)).toContain("before")
                for (const [name, input] of [
                  ["write", { path: "fixture.txt", content: "remote change" }],
                  ["bash", { command: "fixture only" }],
                  ["plugin_write", {}],
                  ["mcp_write", {}],
                ] as const)
                  expect(
                    (yield* executeTool(registry, call(name, input))).type,
                  ).toBe("error")
              }),
            )
            expect(
              yield* Effect.promise(() => fs.readFile(target, "utf8")),
            ).toBe("before")
            expect([shells, plugins, requests]).toEqual([0, 0, 0])
            expect(
              (yield* executeTool(
                registry,
                call("write", { path: "fixture.txt", content: "local change" }),
              )).type,
            ).not.toBe("error")
            expect(
              (yield* executeTool(
                registry,
                call("bash", { command: "fixture only" }),
              )).type,
            ).not.toBe("error")
            expect(
              (yield* executeTool(registry, call("plugin_write", {}))).type,
            ).not.toBe("error")
            expect(
              (yield* executeTool(registry, call("mcp_write", {}))).type,
            ).not.toBe("error")
            expect(
              yield* Effect.promise(() => fs.readFile(target, "utf8")),
            ).toBe("local change")
            expect([shells, plugins, requests]).toEqual([1, 1, 1])
          }),
        () => {
          shells++
        },
      )
    },
  )

  it.live(
    "permits an explicitly granted write but refuses the next call after revocation",
    () =>
      withTools((directory) =>
        Effect.gen(function* () {
          yield* setup(allowAll)
          const registry = yield* ToolRegistry.Service
          let active = true
          yield* PermissionOrigin.restrict(
            {
              sessionID,
              rules: [
                { action: "edit", resource: "fixture.txt", effect: "allow" },
              ],
              valid: Effect.sync(() => active),
            },
            Effect.gen(function* () {
              expect(
                (yield* executeTool(
                  registry,
                  call("write", { path: "fixture.txt", content: "permitted" }),
                )).type,
              ).not.toBe("error")
              active = false
              expect(
                (yield* executeTool(
                  registry,
                  call("write", { path: "fixture.txt", content: "revoked" }),
                )).type,
              ).toBe("error")
            }),
          )
          expect(
            yield* Effect.promise(() =>
              fs.readFile(path.join(directory, "fixture.txt"), "utf8"),
            ),
          ).toBe("permitted")
        }),
      ),
  )

  it.live(
    "resolves remote read grants from the project root, not an absolute path's basename",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (outside) =>
          withTools((directory) =>
            Effect.gen(function* () {
              yield* setup(allowAll)
              const registry = yield* ToolRegistry.Service
              const internal = path.join(directory, "nested", "fixture.txt")
              const external = path.join(outside.path, "fixture.txt")
              const link = path.join(directory, "nested", "external.txt")
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(internal))
                await fs.writeFile(internal, "internal fixture")
                await fs.writeFile(external, "external fixture")
                await fs.symlink(external, link)
              })
              yield* PermissionOrigin.restrict(
                {
                  sessionID,
                  rules: [
                    { action: "read", resource: "nested/*", effect: "allow" },
                  ],
                  valid: Effect.succeed(true),
                },
                Effect.gen(function* () {
                  for (const input of ["nested/fixture.txt", internal]) {
                    const result = yield* executeTool(
                      registry,
                      call("read", { path: input }),
                    )
                    expect(result.type).not.toBe("error")
                    expect(JSON.stringify(result)).toContain("internal fixture")
                  }
                  for (const input of [
                    external,
                    "nested/external.txt",
                    "../fixture.txt",
                  ]) {
                    const result = yield* executeTool(
                      registry,
                      call("read", { path: input }),
                    )
                    expect(result.type).toBe("error")
                    expect(JSON.stringify(result)).not.toContain(
                      "external fixture",
                    )
                  }
                }),
              )
              for (const resource of ["fixture.txt", "*"]) {
                const result = yield* PermissionOrigin.restrict(
                  {
                    sessionID,
                    rules: [{ action: "read", resource, effect: "allow" }],
                    valid: Effect.succeed(true),
                  },
                  executeTool(registry, call("read", { path: external })),
                )
                expect(result.type).toBe("error")
                expect(JSON.stringify(result)).not.toContain("external fixture")
              }
              const local = yield* executeTool(
                registry,
                call("read", { path: external }),
              )
              expect(local.type).not.toBe("error")
              expect(JSON.stringify(local)).toContain("external fixture")
            }),
          ),
        (outside) => Effect.promise(() => outside[Symbol.asyncDispose]()),
      ),
  )

  it.live(
    "does not write when the command loses validity while its approval is published",
    () =>
      withTools((directory) =>
        Effect.gen(function* () {
          yield* setup([{ action: "edit", resource: "*", effect: "ask" }])
          const registry = yield* ToolRegistry.Service
          const permission = yield* PermissionPolicy.Service
          const asked = yield* Deferred.make<PermissionPolicy.Request>()
          let active = true
          const unsubscribe = yield* (yield* EventBus.Service).listen(
            (event) => {
              if (event.type === PermissionPolicy.Event.Asked.type)
                return Deferred.succeed(
                  asked,
                  event.data as PermissionPolicy.Request,
                ).pipe(Effect.asVoid)
              if (event.type === PermissionPolicy.Event.Replied.type)
                return Effect.sync(() => {
                  active = false
                })
              return Effect.void
            },
          )
          yield* Effect.addFinalizer(() => unsubscribe)
          const fiber = yield* PermissionOrigin.restrict(
            {
              sessionID,
              rules: [
                { action: "edit", resource: "fixture.txt", effect: "allow" },
              ],
              valid: Effect.sync(() => active),
            },
            executeTool(
              registry,
              call("write", { path: "fixture.txt", content: "must not write" }),
            ),
          ).pipe(Effect.forkScoped)
          const request = yield* Deferred.await(asked)
          yield* permission.reply({ requestID: request.id, reply: "once" })
          expect((yield* Fiber.join(fiber)).type).toBe("error")
          expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual([])
        }),
      ),
  )
})
