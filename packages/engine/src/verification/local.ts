/** Reviewed local checks reuse snapshot receipts; no external attestation. */
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { isDeepStrictEqual } from "node:util"
import * as LocalPolicy from "../security/launcher-policy"
import type { Location } from "../workspace/location"
import { ProcessRunner } from "../execution/process/runner"
import { ProcessSandbox } from "../execution/sandbox"
import type { Snapshot } from "../workspace/repository/snapshot"
import { Hash } from "../shared/hash"
import { VerifierContainment } from "./containment"
import { VerifierRegistry } from "./registry"

export const enabled = LocalPolicy.enabled
const fail = (reason: VerifierContainment.ErrorReason, message: string) =>
  new VerifierContainment.Error({ reason, message })

/** The executor bundle is exactly this reviewed shell script, not an attestation
 * of the OS/runtime. Commands still require the live command owner's grants. */
export function select(location: Location.Interface, commands: readonly string[]) {
  if (!commands.length || commands.length > 16)
    throw new Error("Independent verification requires 1–16 reviewed commands")
  if (location.directory !== location.project.directory)
    throw new Error("Local independent verification requires the reviewed project root")
  const script = commands.map((command) => `(
${command}
)`).join(" &&\n")
  return VerifierRegistry.pin({
    id: "reviewed-local-checks", version: "1", source: "task",
    check: { id: "reviewed-local-checks", argv: ["/bin/sh", "-c", script],
      cwd: ".", timeoutMs: 120_000, maxOutputBytes: 16_384 },
    executor: { id: "phins-reviewed-check-script", version: "1",
      bundleDigest: `sha256:${Hash.sha256(script)}` },
    containment: { subject: "snapshot-copy", filesystem: "read-only",
      network: "network-deny", environment: "sanitized-env" },
  }, { projectID: location.project.id, projectRoot: location.project.directory })
}

export function make(input: {
  selection: VerifierRegistry.Selection
  snapshots: Snapshot.Interface
  process: ProcessRunner.Interface
  /** Rechecks owner validity, original project identity and every Bash grant. */
  authorize: Effect.Effect<void, unknown>
}): VerifierContainment.Interface {
  const authorize = input.authorize.pipe(Effect.mapError(() =>
    fail("unavailable", "Independent check is no longer authorized")))
  return VerifierContainment.make((execution) => Effect.gen(function* () {
    if (!enabled || process.platform !== "darwin")
      return yield* fail("unavailable", "Local independent checks require the macOS autonomous profile")
    if (!isDeepStrictEqual(execution.selection, input.selection))
      return yield* fail("descriptor-mismatch", "Independent check selection changed")
    yield* authorize
    const started = Date.now()
    return yield* Effect.acquireUseRelease(
      input.snapshots.materialize(execution.subject.snapshot).pipe(
        Effect.mapError(() => fail("materialization", "Cannot copy the final snapshot"))),
      (copy) => Effect.gen(function* () {
        if (copy.snapshot !== execution.subject.snapshot || copy.projectRoot !== input.selection.projectRoot)
          return yield* fail("subject-mismatch", "Independent check copy does not match the subject")
        const [command, ...args] = input.selection.plan.check.argv
        const prepared = yield* ProcessSandbox.prepareWith(
          { mode: "read-only", network: "deny" },
          { command: command!, args, cwd: copy.directory, root: copy.directory },
        ).pipe(Effect.mapError(() => fail("launch", "Independent check sandbox is unavailable")))
        yield* authorize
        const result = yield* input.process.run(
          ChildProcess.make(prepared.command, [...prepared.args], {
            cwd: copy.directory, env: LocalPolicy.childEnvironment(), extendEnv: false,
          }),
          { timeout: input.selection.plan.check.timeoutMs,
            maxOutputBytes: 8192, maxErrorBytes: 8192 },
        ).pipe(Effect.mapError((error) => fail(
          error.cause instanceof Error && error.cause.message === "Timed out" ? "timeout" : "launch",
          "Independent check did not complete",
        )))
        yield* authorize
        return { executor: input.selection.plan.executor, subject: execution.subject,
          status: result.exitCode === 0 ? "passed" as const : "failed" as const,
          exitCode: result.exitCode, durationMs: Math.max(0, Date.now() - started),
          stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"),
          outputTruncated: result.stdoutTruncated || result.stderrTruncated }
      }),
      (copy) => copy.cleanup.pipe(Effect.orDie),
    )
  }))
}
