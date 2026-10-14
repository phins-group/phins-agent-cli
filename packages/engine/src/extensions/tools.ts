export * as PluginTools from "./tools"

import type { PluginContext } from "./api"
import { Effect, Exit, Scope } from "effect"
import { PermissionPolicy } from "../security/permissions/service"
import { Tool } from "../tools/definition"
import { Tools } from "../tools/registration"

/** Location producer: each registration owns a canonical leaf and its scope. */
export const make = Effect.fn("PluginTools.make")(function* () {
  const tools = yield* Tools.Service
  const permissions = yield* PermissionPolicy.Service

  return {
    register: (name, config) =>
      Effect.gen(function* () {
        yield* Tool.validateName(name)
        const execute = config.execute
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const scope = yield* Scope.fork(yield* Scope.Scope)
            let active = true
            const current = () =>
              Effect.suspend(() =>
                active
                  ? Effect.void
                  : Effect.fail(
                      new Tool.Failure({
                        message: `Plugin tool is no longer active: ${name}`,
                      }),
                    ),
              )
            yield* Effect.gen(function* () {
              yield* tools.register({
                [name]: Tool.withOriginPermission(
                  Tool.make({
                    ...config,
                    execute: (input, context) =>
                      Effect.gen(function* () {
                        yield* current()
                        yield* permissions
                          .assert({
                            sessionID: context.sessionID,
                            agent: context.agent,
                            action: name,
                            resources: ["*"],
                            save: ["*"],
                            metadata: { tool: name },
                            source: {
                              type: "tool",
                              messageID: context.assistantMessageID,
                              callID: context.toolCallID,
                            },
                          })
                          .pipe(
                            Effect.mapError(
                              (error) =>
                                new Tool.Failure({
                                  message:
                                    error instanceof PermissionPolicy.CorrectedError
                                      ? error.feedback
                                      : `Permission denied for plugin tool: ${name}`,
                                }),
                            ),
                          )
                        yield* current()
                        return yield* execute(input, context)
                      }),
                  }),
                ),
              })
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active = false
                }),
              )
            }).pipe(
              Scope.provide(scope),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
              ),
            )
            return { dispose: Scope.close(scope, Exit.void) }
          }),
        )
      }),
  } satisfies PluginContext["tool"]
})
