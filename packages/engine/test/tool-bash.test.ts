import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentRegistry } from "../src/agents/registry"
import { FileAccess } from "../src/workspace/files/access"
import { Config } from "../src/settings/config"
import { EventBus } from "../src/runtime/events/bus"
import { Location } from "../src/workspace/location"
import { LocationMutation } from "../src/workspace/mutations"
import { PermissionPolicy } from "../src/security/permissions/service"
import { PermissionSaved } from "../src/security/permissions/saved"
import { ProcessRunner } from "../src/execution/process/runner"
import { ProcessSessions } from "../src/execution/process/sessions"
import { AbsolutePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { SessionStore } from "../src/sessions/store"
import { BashTool } from "../src/tools/process/shell"
import { ToolRegistry } from "../src/tools/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionManager.ID.make("ses_bash_tool_test")
const assertions: PermissionPolicy.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly options?: ProcessRunner.RunOptions
}> = []
let denyAction: string | undefined
let result: ProcessRunner.RunResult = {
  command: "mock",
  exitCode: 0,
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: ProcessRunner.ProcessExecutionError | undefined
let afterPermission = (_input: PermissionPolicy.AssertInput): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionPolicy.Service,
  PermissionPolicy.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionPolicy.DeniedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  ProcessRunner.Service,
  ProcessRunner.Service.of({
    run: (command: ChildProcess.Command, options?: ProcessRunner.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        runs.push({ command: command.command, cwd: command.options.cwd, shell: command.options.shell, options })
        return runFailure ? Effect.fail(runFailure) : Effect.succeed(result)
      }),
  } as unknown as ProcessRunner.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  denyAction = undefined
  runFailure = undefined
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<ProcessRunner.Service> = appProcess,
) => {
  const filesystem = FileAccess.defaultLayer
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const mutation = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const bash = BashTool.layer.pipe(
    Layer.provide(ProcessSessions.layer),
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(mutation),
    Layer.provide(filesystem),
    Layer.provide(processLayer),
    Layer.provide(config),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(registry, bash)))
}

const withRealPermissionTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface, permission: PermissionPolicy.Interface) => Effect.Effect<A, E, R>,
) => {
  const filesystem = FileAccess.defaultLayer
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const events = Layer.mock(EventBus.Service, {
    publish: (definition, data) =>
      Effect.succeed({
        id: EventBus.ID.create(),
        type: definition.type,
        data,
      } as EventBus.Payload<typeof definition>),
  })
  const agents = Layer.mock(AgentRegistry.Service, {
    resolve: (id) =>
      Effect.succeed({
        ...AgentRegistry.Info.empty(AgentRegistry.ID.make(id ?? "build")),
        permissions: [],
      }),
  })
  const sessions = Layer.mock(SessionStore.Service, {
    get: (id) =>
      Effect.succeed(id === sessionID ? ({ agent: AgentRegistry.ID.make("build") } as SessionManager.Info) : undefined),
  })
  const saved = Layer.mock(PermissionSaved.Service, {
    list: () => Effect.succeed([]),
    add: () => Effect.void,
  })
  const realPermission = PermissionPolicy.layer.pipe(
    Layer.provide(events),
    Layer.provide(activeLocation),
    Layer.provide(agents),
    Layer.provide(sessions),
    Layer.provide(saved),
  )
  const mutation = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(realPermission))
  const bash = BashTool.layer.pipe(
    Layer.provide(ProcessSessions.layer),
    Layer.provide(registry),
    Layer.provide(realPermission),
    Layer.provide(mutation),
    Layer.provide(filesystem),
    Layer.provide(appProcess),
    Layer.provide(config),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service, yield* PermissionPolicy.Service)
  }).pipe(Effect.provide(Layer.mergeAll(realPermission, registry, bash)))
}

const waitForBashPermission = (permission: PermissionPolicy.Interface) =>
  Effect.gen(function* () {
    while (true) {
      const request = (yield* permission.forSession(sessionID))[0]
      if (request) return request
      yield* Effect.yieldNow
    }
  })

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.description")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: { type: "text", value: "hello\n\n\nCommand exited with code 0." },
              output: {
                structured: {
                  command: "pwd",
                  cwd: realpathSync(tmp.path),
                  exitCode: 0,
                  output: "hello\n",
                  truncated: false,
                },
                content: [{ type: "text", text: "hello\n\n\nCommand exited with code 0." }],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            expect(runs[0]?.options).toMatchObject({
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
              maxErrorBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([
              {
                sessionID,
                action: "bash",
                resources: ["pwd"],
                metadata: {
                  command: "pwd",
                  cwd: realpathSync(tmp.path),
                  shell: process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
                  timeout: BashTool.DEFAULT_TIMEOUT_MS,
                },
              },
            ])
            expect(assertions[0]?.save).toBeUndefined()
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            ProcessRunner.defaultLayer,
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({ type: "text", value: "core-bash\n\nCommand exited with code 0." })
                expect(settled.output?.structured).toMatchObject({
                  command: "printf core-bash",
                  cwd: realpathSync(tmp.path),
                  exitCode: 0,
                  output: "core-bash",
                })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  if (process.platform !== "win32") {
    it.live("never spawns when an approved external workdir is swapped to a symlink", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir(), tmpdir()])),
        ([active, approved, unauthorized]) => {
          reset()
          afterPermission = (input) =>
            input.action === "bash"
              ? Effect.promise(async () => {
                  await fs.rm(approved.path, { recursive: true })
                  await fs.symlink(unauthorized.path, approved.path, "dir")
                }).pipe(Effect.orDie)
              : Effect.void
          return withTool(active.path, (registry) =>
            settleTool(registry, call({ command: "pwd", workdir: approved.path })),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toMatchObject({ type: "error" })
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(approved.path, "*").replaceAll("\\", "/")],
                })
                expect(assertions[1]).toMatchObject({ metadata: { cwd: approved.path } })
                expect(realpathSync(approved.path)).toBe(unauthorized.path)
                expect(runs).toEqual([])
              }),
            ),
          )
        },
        ([active, approved, unauthorized]) =>
          Effect.promise(() =>
            Promise.all([
              active[Symbol.asyncDispose](),
              approved[Symbol.asyncDispose](),
              unauthorized[Symbol.asyncDispose](),
            ]).then(() => undefined),
          ),
      ),
    )
  }

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("waits for real permission and never spawns after rejection or interruption", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withRealPermissionTool(tmp.path, (registry, permission) =>
          Effect.gen(function* () {
            const rejected = yield* executeTool(registry, call({ command: "pwd" }, "call-rejected")).pipe(
              Effect.forkChild,
            )
            const rejectedRequest = yield* waitForBashPermission(permission)
            expect(runs).toEqual([])
            expect(rejectedRequest).toMatchObject({
              sessionID,
              action: "bash",
              resources: ["pwd"],
              metadata: {
                command: "pwd",
                cwd: realpathSync(tmp.path),
                shell: process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
                timeout: BashTool.DEFAULT_TIMEOUT_MS,
              },
            })
            expect(rejectedRequest.save).toBeUndefined()
            yield* permission.reply({ requestID: rejectedRequest.id, reply: "reject" })
            expect(yield* Fiber.join(rejected)).toMatchObject({ type: "error" })
            expect(runs).toEqual([])

            const interrupted = yield* executeTool(registry, call({ command: "pwd" }, "call-interrupted")).pipe(
              Effect.forkChild,
            )
            yield* waitForBashPermission(permission)
            expect(runs).toEqual([])
            yield* Fiber.interrupt(interrupted)
            expect(yield* permission.forSession(sessionID)).toEqual([])
            expect(runs).toEqual([])

            const allowed = yield* executeTool(registry, call({ command: "pwd" }, "call-allowed")).pipe(
              Effect.forkChild,
            )
            const allowedRequest = yield* waitForBashPermission(permission)
            expect(runs).toEqual([])
            yield* permission.reply({ requestID: allowedRequest.id, reply: "once" })
            expect(yield* Fiber.join(allowed)).toMatchObject({ type: "text" })
            expect(runs).toHaveLength(1)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                warnings: [
                  `Command argument references external directory ${path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")}. Path scanning is advisory; OS access follows the launcher sandbox policy.`,
                ],
              })
              expect(settled.result).toMatchObject({ type: "text", value: expect.stringContaining("Warnings:") })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, stdout: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                command: "false",
                cwd: realpathSync(tmp.path),
                exitCode: 7,
                output: "HEAD full output TAIL",
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, stdoutTruncated: true }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true, stdoutTruncated: true })
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("stdout capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new ProcessRunner.ProcessExecutionError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                command: "sleep 60",
                timedOut: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tools/process/shell.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
