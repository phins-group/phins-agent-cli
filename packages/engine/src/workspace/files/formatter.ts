/** Configured, permission-gated formatters for the native project runtime. */
export * as Formatter from "./formatter"

import path from "node:path"
import * as LocalPolicy from "../../security/launcher-policy"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../../settings/config"
import { Location } from "../location"
import { LocationMutation } from "../mutations"
import { PermissionPolicy } from "../../security/permissions/service"
import { ProcessRunner } from "../../execution/process/runner"
import type { Tool } from "../../tools/definition"

export class Failure extends Schema.TaggedErrorClass<Failure>()(
  "FormatterFailure",
  {
    message: Schema.String,
  },
) {}
export type Status = {
  name: string
  extensions: readonly string[]
  enabled: boolean
}
export interface Interface {
  status(): Effect.Effect<Status[]>
  format(file: string, context: Tool.Context): Effect.Effect<string[], Failure>
}
export class Service extends Context.Service<Service, Interface>()(
  "@phins/Formatter",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionPolicy.Service
    const process = yield* ProcessRunner.Service
    const configured = Config.latest(yield* config.entries(), "formatter")
    const entries = Object.entries(
      !LocalPolicy.enabled && typeof configured === "object" ? configured : {},
    )
    return Service.of({
      status: () =>
        Effect.succeed(
          entries.map(([name, entry]) => ({
            name,
            extensions: entry.extensions ?? [],
            enabled: !entry.disabled && !!entry.command?.[0],
          })),
        ),
      format: (file, context) =>
        Effect.gen(function* () {
          const target = yield* mutation.resolve({ path: file, kind: "file" })
          const matching = entries.filter(
            ([, entry]) =>
              !entry.disabled &&
              entry.command?.[0] &&
              entry.extensions?.includes(path.extname(target.canonical)),
          )
          if (!matching.length) return []
          const identity = {
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool" as const,
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            },
          }
          if (target.externalDirectory)
            yield* permission.assert({
              ...identity,
              ...LocationMutation.externalDirectoryPermission(
                target.externalDirectory,
              ),
            })
          yield* permission.assert({
            ...identity,
            action: "edit",
            resources: [target.resource],
            save: ["*"],
          })
          const completed: string[] = []
          for (const [name, entry] of matching) {
            // Edit permission alone must never become permission to execute a
            // project-configured command, particularly for a remote origin.
            yield* permission.assert({
              ...identity,
              action: "formatter",
              resources: [name],
              save: [name],
            })
            const [command, ...args] = entry.command!.map((part) =>
              part.replaceAll("$FILE", target.canonical),
            )
            const result = yield* process.run(
              ChildProcess.make(command!, args, {
                cwd: location.directory,
                env: entry.environment,
              }),
              {
                timeout: "15 seconds",
                maxOutputBytes: 4096,
                maxErrorBytes: 4096,
              },
            )
            if (result.exitCode !== 0)
              return yield* new Failure({
                message: `Formatter ${name} failed; the file may already have changed. Inspect it before retrying.`,
              })
            completed.push(name)
          }
          return completed
        }).pipe(
          Effect.mapError((error) =>
            error instanceof Failure
              ? error
              : new Failure({
                  message:
                    "Formatting was denied, failed or timed out. Inspect the file before retrying.",
                }),
          ),
        ),
    })
  }),
)
