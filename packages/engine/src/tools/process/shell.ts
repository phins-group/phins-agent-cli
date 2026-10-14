export * as BashTool from "./shell"

import path from "path"
import * as LocalPolicy from "../../security/launcher-policy"
import { ToolFailure } from "../../inference/api"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../../settings/config"
import { FileAccess } from "../../workspace/files/access"
import { LocationMutation } from "../../workspace/mutations"
import { ProcessRunner } from "../../execution/process/runner"
import { ProcessSandbox } from "../../execution/sandbox"
import { ProcessSessions } from "../../execution/process/sessions"
import { PermissionPolicy } from "../../security/permissions/service"
import { PermissionOrigin } from "../../security/permissions/origin"
import * as Delegation from "../../security/permissions/delegation"
import { PositiveInt } from "../../shared/schema"
import { Tool } from "../definition"
import { Tools } from "../registration"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  yieldTimeMs: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 30000 })),
  ).annotate({
    description:
      "Return a process handle after this wait; use process_session for new output, stdin or cancellation. Omit to wait for completion.",
  }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
})

const Output = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.Number.pipe(Schema.optional),
  /** Bounded compact equivalent of stdout/stderr: stderr is labeled when present. */
  output: Schema.String,
  truncated: Schema.Boolean,
  stdoutTruncated: Schema.Boolean.pipe(Schema.optional),
  stderrTruncated: Schema.Boolean.pipe(Schema.optional),
  timedOut: Schema.Boolean.pipe(Schema.optional),
  process: Schema.optional(ProcessSessions.Snapshot),
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const compactOutput = (stdout: string, stderr: string) => {
  const output = stdout && stderr ? `${stdout}\n\nstderr:\n${stderr}` : stderr ? `stderr:\n${stderr}` : stdout
  return output || "(no output)"
}

const captureNotice = (stdoutTruncated: boolean, stderrTruncated: boolean) => {
  if (stdoutTruncated && stderrTruncated) return "[stdout and stderr capture truncated at the in-memory safety limit]"
  if (stdoutTruncated) return "[stdout capture truncated at the in-memory safety limit]"
  if (stderrTruncated) return "[stderr capture truncated at the in-memory safety limit]"
  return undefined
}

const modelOutput = (output: Output) => {
  if (output.process) return JSON.stringify(output.process)
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timedOut) return `${output.output}${warnings}\n\nCommand timed out before completion.`
  return `${output.output}${warnings}\n\nCommand exited with code ${output.exitCode}.`
}

const isTimeout = (error: ProcessRunner.ProcessExecutionError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = (command: string, cwd: string) => {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = FileAccess.resolve(value)
    if (FileAccess.contains(cwd, resolved)) continue
    directories.add(FileAccess.resolve(path.dirname(resolved)))
  }
  return [...directories]
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FileAccess.Service
    const appProcess = yield* ProcessRunner.Service
    const config = yield* Config.Service
    const permission = yield* PermissionPolicy.Service
    const sessions = yield* ProcessSessions.Service

    yield* tools
      .register({
        [name]: Tool.withOriginPermission(
          Tool.make({
            description: `Execute one shell command string with the launcher sandbox policy when configured; otherwise with host-user authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: modelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* LocalPolicy.assertCommand(input.command, input.yieldTimeMs !== undefined)
                if (input.yieldTimeMs !== undefined &&
                    ((yield* PermissionOrigin.capture).length > 0 || (yield* Delegation.Current)))
                  return yield* new ToolFailure({ message: "Background processes are not available for Node commands or foreground subtasks" })
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
                const entries = yield* config.entries()
                const shell =
                  Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                    .shell ?? defaultShell()
                const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const warnings = externalCommandDirectories(input.command, target.canonical).map(
                  (directory) =>
                    `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Path scanning is advisory; OS access follows the launcher sandbox policy.`,
                )
                yield* permission.assert({
                  action: name,
                  resources: [input.command],
                  metadata: {
                    command: input.command,
                    cwd: target.canonical,
                    shell,
                    timeout,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                // Permission prompts can suspend while the filesystem changes. Spawn only if the
                // canonical cwd and its external approval boundary are still exactly what was approved.
                const finalTarget = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
                if (
                  finalTarget.canonical !== target.canonical ||
                  finalTarget.externalDirectory?.resource !== target.externalDirectory?.resource
                ) {
                  return yield* Effect.fail(
                    new Error(`Working directory changed after permission approval: ${input.workdir ?? "."}`),
                  )
                }

                if ((yield* fs.stat(finalTarget.canonical)).type !== "Directory")
                  return yield* Effect.fail(new Error(`Working directory is not a directory: ${finalTarget.canonical}`))

                if (input.yieldTimeMs !== undefined) {
                  const processID = yield* sessions.start(context.sessionID, {
                    command: shell,
                    args: ["-c", input.command],
                    cwd: finalTarget.canonical,
                    root: (yield* mutation.resolve({ path: ".", kind: "directory" })).canonical,
                    timeout,
                  })
                  const process = yield* sessions.followup(context.sessionID, {
                    processID,
                    action: "wait",
                    waitMs: input.yieldTimeMs,
                  })
                  return {
                    command: input.command,
                    cwd: finalTarget.canonical,
                    output: process.output,
                    truncated: process.omitted > 0,
                    process,
                  }
                }
                const sandbox = ProcessSandbox.enabled
                  ? yield* ProcessSandbox.prepare({
                      command: shell,
                      args: ["-c", input.command],
                      cwd: finalTarget.canonical,
                      root: (yield* mutation.resolve({ path: ".", kind: "directory" })).canonical,
                    })
                  : undefined
                const command = ChildProcess.make(sandbox?.command ?? input.command, sandbox ? [...sandbox.args] : [], {
                  cwd: finalTarget.canonical,
                  shell: sandbox ? false : shell,
                  ...(LocalPolicy.enabled ? { env: LocalPolicy.childEnvironment(), extendEnv: false } : {}),
                  stdin: "ignore",
                  detached: process.platform !== "win32",
                  forceKillAfter: Duration.seconds(3),
                })
                const result = yield* appProcess
                  .run(command, {
                    timeout: Duration.millis(timeout),
                    maxOutputBytes: MAX_CAPTURE_BYTES,
                    maxErrorBytes: MAX_CAPTURE_BYTES,
                  })
                  .pipe(
                    Effect.catchTag("AppProcessError", (error) =>
                      isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                    ),
                  )
                if (!result) {
                  return {
                    command: input.command,
                    cwd: finalTarget.canonical,
                    output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                    truncated: false,
                    timedOut: true,
                    ...(warnings.length ? { warnings } : {}),
                  }
                }

                const compact = compactOutput(result.stdout.toString("utf8"), result.stderr.toString("utf8"))
                const notice = captureNotice(result.stdoutTruncated, result.stderrTruncated)
                return {
                  command: input.command,
                  cwd: finalTarget.canonical,
                  exitCode: result.exitCode,
                  output: notice ? `${compact}\n\n${notice}` : compact,
                  truncated: result.stdoutTruncated || result.stderrTruncated,
                  ...(warnings.length ? { warnings } : {}),
                  ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
                  ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
                }
              }).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Unable to execute command: ${String(error)}` })),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
