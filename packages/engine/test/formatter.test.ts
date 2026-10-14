import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "../src/settings/config"
import { ConfigFormatter } from "../src/settings/formatters"
import { Formatter } from "../src/workspace/files/formatter"
import { Location } from "../src/workspace/location"
import { LocationMutation } from "../src/workspace/mutations"
import { PermissionPolicy } from "../src/security/permissions/service"
import { ProcessRunner, ProcessExecutionError } from "../src/execution/process/runner"
import { SessionManager } from "../src/sessions/service"
import { AbsolutePath } from "../src/shared/schema"
import { location } from "./fixture/location"
import { toolIdentity } from "./lib/tool"

const context = {
  ...toolIdentity,
  sessionID: SessionManager.ID.make("ses_format"),
  toolCallID: "format-1",
}
async function run(
  options: {
    denied?: string
    failed?: boolean
    external?: boolean
    disabled?: boolean
  } = {},
) {
  const assertions: string[] = [],
    commands: unknown[] = []
  const layer = Formatter.layer.pipe(
    Layer.provide([
      Layer.mock(Config.Service, {
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: new Config.Info({
                formatter: {
                  example: new ConfigFormatter.Entry({
                    command: ["formatter", "$FILE"],
                    extensions: [".ts"],
                    disabled: options.disabled ?? false,
                  }),
                },
              }),
            }),
          ]),
      }),
      Layer.succeed(
        Location.Service,
        location({ directory: AbsolutePath.make("/project") }),
      ),
      Layer.mock(LocationMutation.Service, {
        resolve: () =>
          Effect.succeed({
            canonical: "/project/file.ts",
            resource: "file.ts",
            ...(options.external
              ? {
                  externalDirectory: {
                    action: "external_directory" as const,
                    directory: "/outside",
                    resource: "/outside/*",
                    save: "/outside/*",
                  },
                }
              : {}),
          }),
      }),
      Layer.mock(PermissionPolicy.Service, {
        assert: (input) =>
          Effect.gen(function* () {
            assertions.push(input.action)
            expect(input.source).toEqual({
              type: "tool",
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            })
            if (input.action === options.denied)
              return yield* new PermissionPolicy.DeniedError({ rules: [] })
          }),
      }),
      Layer.mock(ProcessRunner.Service, {
        run: (command, budget) =>
          Effect.gen(function* () {
            commands.push(command)
            expect(budget?.timeout).toBe("15 seconds")
            if (options.failed)
              return yield* new ProcessExecutionError({
                command: "secret-provider-value",
              })
            return {
              command: "formatter",
              exitCode: 0,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          }),
      }),
    ]),
  )
  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const formatter = yield* Formatter.Service
      const status = yield* formatter.status()
      const outcome = yield* formatter
        .format("file.ts", context)
        .pipe(Effect.result)
      return { status, outcome }
    }).pipe(Effect.provide(layer)),
  )
  return { ...value, assertions, commands }
}

test("native formatter exposes configured status and requires both edit and command permission", async () => {
  const value = await run()
  expect(value.status).toEqual([
    { name: "example", extensions: [".ts"], enabled: true },
  ])
  expect(value.assertions).toEqual(["edit", "formatter"])
  expect(value.commands).toMatchObject([
    {
      command: "formatter",
      args: ["/project/file.ts"],
      options: { cwd: "/project" },
    },
  ])
  expect(value.outcome).toMatchObject({ _tag: "Success", success: ["example"] })
})

test.each(["edit", "formatter", "external_directory"])(
  "denial of %s never starts a formatter",
  async (denied) => {
    const value = await run({
      denied,
      external: denied === "external_directory",
    })
    expect(value.commands).toHaveLength(0)
    expect(value.outcome._tag).toBe("Failure")
  },
)

test("disabled formatter never requests permission or executes", async () => {
  const value = await run({ disabled: true })
  expect(value.status[0]?.enabled).toBe(false)
  expect(value.assertions).toEqual([])
  expect(value.commands).toEqual([])
})

test("formatter errors do not include command credentials or falsely report unchanged files", async () => {
  const value = await run({ failed: true })
  expect(JSON.stringify(value.outcome)).not.toContain("secret-provider-value")
  expect(JSON.stringify(value.outcome)).toContain("Inspect the file")
})
