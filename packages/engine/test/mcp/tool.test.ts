import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool as McpDefinition } from "@modelcontextprotocol/sdk/types.js"
import { AgentRegistry } from "../../src/agents/registry"
import { McpTool } from "../../src/extensions/mcp/tool"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { SessionManager } from "../../src/sessions/service"
import { SessionMessage } from "../../src/sessions/messages/service"
import { ApplicationTools } from "../../src/tools/application"
import { ToolRegistry } from "../../src/tools/registry"
import { ToolOutputStore } from "../../src/tools/output-store"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"

const bounds: ToolOutputStore.BoundInput[] = []
const storageError = new ToolOutputStore.StorageError({
  operation: "write",
  cause: "fixture",
})
const it = testEffect(
  ToolRegistry.layer.pipe(
    Layer.provide(ApplicationTools.layer),
    Layer.provide(
      Layer.mock(ToolOutputStore.Service, {
        bound: (input) =>
          Effect.suspend(() => {
            bounds.push(input)
            if (input.toolCallID === "storage-error")
              return Effect.fail(storageError)
            return Effect.succeed(
              input.toolCallID === "bounded"
                ? {
                    output: {
                      structured: {},
                      content: [
                        { type: "text" as const, text: "bounded error" },
                      ],
                    },
                    outputPaths: ["/managed/mcp-error"],
                  }
                : { output: input.output, outputPaths: [] },
            )
          }),
      }),
    ),
  ),
)
const identity = {
  sessionID: SessionManager.ID.make("ses_mcp_tool"),
  agent: AgentRegistry.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_mcp_tool"),
}
const call = (
  input: unknown = {},
  id = "call-mcp",
  name = "fixture_echo",
): ToolRegistry.ExecuteInput => ({
  ...identity,
  call: { type: "tool-call", id, name, input },
})
const definition: McpDefinition = {
  name: "echo",
  description: "Echo exact JSON",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { mode: { enum: ["brief", "full"] }, text: { type: "string" } },
    required: ["mode"],
    if: { properties: { mode: { const: "full" } } },
    then: { required: ["text"] },
  },
}
const permission = (
  assert: PermissionPolicy.Interface["assert"],
): PermissionPolicy.Interface => ({
  assert,
  ask: () => Effect.die("Unexpected ask"),
  reply: () => Effect.die("Unexpected reply"),
  get: () => Effect.die("Unexpected get"),
  forSession: () => Effect.die("Unexpected forSession"),
  list: () => Effect.die("Unexpected list"),
})
const make = (input: {
  callTool: Client["callTool"]
  assert?: PermissionPolicy.Interface["assert"]
  active?: () => boolean
  definition?: McpDefinition
}) =>
  McpTool.make({
    name: "fixture_echo",
    server: "fixture",
    definition: input.definition ?? definition,
    client: {
      request: (request, schema, options) => {
        expect(request.method).toBe("tools/call")
        return input.callTool(request.params, schema, options)
      },
    },
    permission: permission(input.assert ?? (() => Effect.void)),
    active: input.active ?? (() => true),
    timeout: 1234,
  })
const emptyDefinition: McpDefinition = {
  name: "echo",
  inputSchema: { type: "object" },
}

describe("canonical MCP tool", () => {
  it.effect(
    "advertises the original schema and validates without coercion or stripping",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const rpc: unknown[] = []
        const permissions: PermissionPolicy.AssertInput[] = []
        yield* registry.register({
          fixture_echo: make({
            assert: (request) =>
              Effect.sync(() => {
                permissions.push(request)
              }),
            callTool: async (request, _schema, options) => {
              rpc.push(request)
              expect(options?.timeout).toBe(1234)
              expect(options?.signal).toBeInstanceOf(AbortSignal)
              return { content: [{ type: "text", text: "ok" }] }
            },
          }),
        })
        const tools = yield* registry.materialize()
        expect(tools.definitions[0]?.inputSchema).toEqual(
          definition.inputSchema,
        )
        for (const input of [
          {},
          { mode: "unknown" },
          { mode: "full" },
          { mode: "brief", text: 1 },
          { mode: "brief", extra: true },
        ])
          expect((yield* tools.settle(call(input))).result.type).toBe("error")
        expect(rpc).toEqual([])
        expect(permissions).toEqual([])
        const args = { mode: "full", text: "exact" }
        expect((yield* tools.settle(call(args))).result.type).toBe("text")
        expect(rpc).toEqual([{ name: "echo", arguments: args }])
        expect(permissions).toEqual([
          {
            sessionID: identity.sessionID,
            agent: identity.agent,
            action: "fixture_echo",
            resources: ["*"],
            save: ["*"],
            metadata: { server: "fixture", tool: "echo" },
            source: {
              type: "tool" as const,
              messageID: identity.assistantMessageID,
              callID: "call-mcp",
            },
          },
        ])
      }),
  )

  it.effect("isolates validators with the same schema id", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const calls: unknown[] = []
      for (const [name, value] of [
        ["one", "a"],
        ["two", "b"],
      ])
        yield* registry.register({
          [name!]: make({
            definition: {
              name: name!,
              inputSchema: {
                $id: "fixture/shared",
                type: "object",
                properties: { value: { const: value } },
                required: ["value"],
              },
            },
            callTool: async (request) => {
              calls.push(request)
              return { content: [] }
            },
          }),
        })
      const tools = yield* registry.materialize()
      for (const [name, value, wrong] of [
        ["one", "a", "b"],
        ["two", "b", "a"],
      ]) {
        expect(
          (yield* tools.settle(call({ value: wrong }, "wrong", name))).result
            .type,
        ).toBe("error")
        expect(
          (yield* tools.settle(call({ value }, "right", name))).result.type,
        ).toBe("json")
      }
      expect(calls).toHaveLength(2)
    }),
  )

  it.effect(
    "enforces leaf permission even with a previously advertised tool",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        let rpc = 0
        yield* registry.register({
          fixture_echo: make({
            definition: emptyDefinition,
            assert: () =>
              Effect.fail(new PermissionPolicy.DeniedError({ rules: [] })),
            callTool: async () => {
              rpc++
              return { content: [] }
            },
          }),
        })
        const advertised = yield* registry.materialize()
        expect(advertised.definitions).toHaveLength(1)
        expect((yield* advertised.settle(call())).result).toEqual({
          type: "error",
          value: "MCP tool permission refused: fixture_echo",
        })
        const hidden = yield* registry.materialize([
          { action: "fixture_*", resource: "*", effect: "deny" },
        ])
        expect(hidden.definitions).toEqual([])
        expect((yield* hidden.settle(call())).result.type).toBe("error")
        expect(rpc).toBe(0)
      }),
  )

  it.effect("does not invoke a tool removed while waiting for permission", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const waiting = yield* Deferred.make<void>()
      const approval = yield* Deferred.make<void>()
      let active = true
      let rpc = 0
      yield* registry.register({
        fixture_echo: make({
          definition: emptyDefinition,
          active: () => active,
          assert: () =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Deferred.await(approval)),
            ),
          callTool: async () => {
            rpc++
            return { content: [] }
          },
        }),
      })
      const tools = yield* registry.materialize()
      const pending = yield* tools.settle(call()).pipe(Effect.forkChild)
      yield* Deferred.await(waiting)
      active = false
      yield* Deferred.succeed(approval, undefined)
      expect((yield* Fiber.join(pending)).result).toEqual({
        type: "error",
        value: "Disconnected or stale MCP tool: fixture_echo",
      })
      expect(rpc).toBe(0)
    }),
  )

  it.effect("preserves interruption and permission defects", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const started = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      yield* registry.register({
        fixture_echo: make({
          definition: emptyDefinition,
          callTool: (_request, _schema, options) => {
            signal = options?.signal
            started.resolve()
            return new Promise((_resolve, reject) =>
              signal?.addEventListener("abort", () =>
                reject(new Error("fixture abort")),
              ),
            )
          },
        }),
      })
      const tools = yield* registry.materialize()
      const pending = yield* tools.settle(call()).pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(pending)
      const interrupted = yield* Fiber.await(pending)
      expect(
        Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause),
      ).toBe(true)
      expect(signal?.aborted).toBe(true)
      const defect = new Error("permission defect")
      yield* registry.register({
        fixture_echo: make({
          definition: emptyDefinition,
          assert: () => Effect.die(defect),
          callTool: async () => {
            throw new Error("Must not call")
          },
        }),
      })
      const latest = yield* registry.materialize()
      expect(
        yield* latest.settle(call()).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBe(defect)
    }),
  )

  it.effect(
    "bounds negative results and preserves output storage failures",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* registry.register({
          fixture_echo: make({
            definition: emptyDefinition,
            callTool: async () => ({
              isError: true,
              content: [{ type: "text", text: "negative result" }],
              structuredContent: { reason: "fixture" },
            }),
          }),
        })
        const tools = yield* registry.materialize()
        const before = bounds.length
        const negative = yield* tools.settle(call())
        expect(negative.result.type).toBe("error")
        expect(JSON.stringify(negative.result.value)).toContain(
          "negative result",
        )
        expect(negative.output).toBeUndefined()
        expect(bounds[before]?.output.structured).toMatchObject({
          isError: true,
          structuredContent: { reason: "fixture" },
        })
        expect(yield* tools.settle(call({}, "bounded"))).toEqual({
          result: { type: "error", value: "bounded error" },
          outputPaths: ["/managed/mcp-error"],
        })
        const failed = yield* tools
          .settle(call({}, "storage-error"))
          .pipe(Effect.exit)
        expect(
          Exit.isFailure(failed) &&
            Option.getOrUndefined(Cause.findErrorOption(failed.cause)),
        ).toBe(storageError)
      }),
  )

  it.effect("projects text, images, embedded resources and links as data", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const link = {
        type: "resource_link" as const,
        uri: "https://invalid.test/no-fetch",
        name: "reference",
      }
      const resource = {
        type: "resource" as const,
        resource: { uri: "file:///fixture", text: "embedded" },
      }
      yield* registry.register({
        fixture_echo: make({
          definition: emptyDefinition,
          callTool: async () => ({
            content: [
              { type: "text", text: "text" },
              { type: "image", data: "AA==", mimeType: "image/png" },
              link,
              resource,
            ],
            structuredContent: { answer: 42 },
          }),
        }),
      })
      const tools = yield* registry.materialize()
      expect((yield* tools.settle(call())).output?.content).toEqual([
        { type: "text", text: "text" },
        {
          type: "file",
          uri: "data:image/png;base64,AA==",
          mime: "image/png",
          name: undefined,
        },
        {
          type: "text",
          text: JSON.stringify({
            name: link.name,
            uri: link.uri,
            type: link.type,
          }),
        },
        { type: "text", text: JSON.stringify(resource) },
        { type: "text", text: '{"answer":42}' },
      ])
    }),
  )

  it.effect(
    "does not turn malformed or transport failures into successes",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        for (const result of [
          { toolResult: "compatibility result" },
          { content: [{ type: "text", text: 123 }] },
        ]) {
          yield* registry.register({
            fixture_echo: make({
              definition: emptyDefinition,
              callTool: async () =>
                result as Awaited<ReturnType<Client["callTool"]>>,
            }),
          })
          const tools = yield* registry.materialize()
          expect((yield* tools.settle(call())).result).toEqual({
            type: "error",
            value: "MCP tool call failed: fixture_echo",
          })
        }
        yield* registry.register({
          fixture_echo: make({
            definition: emptyDefinition,
            callTool: async () => {
              throw new Error("fixture-secret must not leak")
            },
          }),
        })
        const tools = yield* registry.materialize()
        expect(JSON.stringify(yield* tools.settle(call()))).not.toContain(
          "fixture-secret",
        )
      }),
  )
})
