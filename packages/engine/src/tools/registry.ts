/**
 * Canonical tool registry và settlement boundary của Core V2.
 *
 * Registration sống theo Scope; materialization chụp immutable definition set
 * cho một LLM turn, còn settle chống stale call và bound/offload output.
 * @module
 */
export * as ToolRegistry from "./registry"

import {
  ToolOutput,
  type ToolCall,
  type ToolDefinition,
  type ToolResultValue,
} from "../inference/api"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentRegistry } from "../agents/registry"
import { PermissionPolicy } from "../security/permissions/service"
import { SessionMessage } from "../sessions/messages/service"
import { Session as SessionSchema } from "../contracts/session/info"
import { ToolOutputStore } from "./output-store"
import { Wildcard } from "../shared/wildcard"
import { ApplicationTools } from "./application"
import {
  definition,
  permission,
  parallel,
  originAware,
  settle,
  validateName,
  ResultFailure,
  type AnyTool,
  type RegistrationError,
} from "./definition"
import { Tools } from "./registration"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentRegistry.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionPolicy.Ruleset,
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (
    tools: Readonly<Record<string, AnyTool>>,
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly parallel?: (name: string) => boolean
  /** Catalog declaration only. The captured leaf still owns all permission checks. */
  readonly originAware?: (name: string) => boolean
  readonly settle: (
    input: ExecuteInput,
  ) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/ToolRegistry",
) {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<
      string,
      Array<{ readonly token: object; readonly registration: Registration }>
    >()

    /** Execute đúng registration đã quảng bá và chuẩn hóa model-facing result. */
    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: object,
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ??
        applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised
              ? `Stale tool call: ${input.call.name}`
              : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return {
          result: {
            type: "error" as const,
            value: `Stale tool call: ${input.call.name}`,
          },
        }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag(
          "LLM.ToolFailure",
          (failure): Effect.Effect<Settlement, ToolOutputStore.Error> => {
            if (!(failure instanceof ResultFailure))
              return Effect.succeed({
                result: { type: "error" as const, value: failure.message },
              })
            return resources
              .bound({
                sessionID: input.sessionID,
                toolCallID: input.call.id,
                output: failure.output,
              })
              .pipe(
                Effect.map((bounded) => ({
                  result: {
                    type: "error" as const,
                    value: ToolOutput.toResultValue(bounded.output).value,
                  },
                  ...(bounded.outputPaths.length > 0
                    ? { outputPaths: bounded.outputPaths }
                    : {}),
                })),
              )
          },
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        toolCallID: input.call.id,
        output,
      })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0
          ? { result, outputPaths: bounded.outputPaths }
          : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      // Scope finalizer gỡ đúng registration batch, kể cả khi tên bị shadow.
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), {
          discard: true,
        })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [
                ...(local.get(name) ?? []),
                { token, registration: { identity: {}, tool } },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations =
                    local
                      .get(name)
                      ?.filter(
                        (registration) => registration.token !== token,
                      ) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      // F4/7: chụp identity để tool bị reload giữa call sẽ trả stale-call error.
      materialize: Effect.fn("ToolRegistry.materialize")(function* (
        permissions = [],
      ) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions))
            registrations.delete(name)
        return {
          originAware: (name: string) => {
            const registration = registrations.get(name)
            return registration ? originAware(registration.tool) : false
          },
          parallel: (name: string) => {
            const registration = registrations.get(name)
            return registration ? parallel(registration.tool) : false
          },
          definitions: Array.from(registrations, ([name, registration]) =>
            definition(name, registration.tool),
          ),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({
              result: {
                type: "error",
                value: `Unknown tool: ${input.call.name}`,
              },
            })
          },
        }
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) =>
    Effect.succeed(Tools.Service.of({ register: registry.register })),
  ),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionPolicy.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
