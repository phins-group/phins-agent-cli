/** Coding discipline within the existing runner, never a permission grant. */
import { Context, Effect } from "effect"
import type { ToolCall, ToolResultValue } from "../../inference/api"
import * as LocalPolicy from "../../security/launcher-policy"
const enabled = LocalPolicy.enabled || process.env.PHINS_CODING_WORKFLOW === "1"
const maximum = Number(process.env.PHINS_MAX_CORRECTIONS ?? 3)
const mutation = new Set(["edit", "write", "apply_patch"])
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function make(checks: readonly string[], maxCorrections = 3) {
  if (!Number.isSafeInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 10)
    throw new Error("Correction limit must be an integer from 0 to 10")
  let inspected = false, planned = false, epoch = 0, failedRounds = 0
  let failedEpoch = -1, corrections = 0, awaitingCorrection = false
  const baselines = new Set<string>()
  const passed = new Set<string>()
  const changed = new Set<string>()
  return {
    before(call: Pick<ToolCall, "name" | "input">): string | undefined {
      if (LocalPolicy.enabled && !["read", "grep", "glob", "todowrite", "todoread", "edit", "write", "apply_patch", "bash"].includes(call.name))
        return "Tool is outside the reviewed autonomous coding profile."
      if (!mutation.has(call.name)) return
      if (!inspected) return "Read the relevant source before changing code."
      if (!planned) return "Use todowrite to record an actionable plan before changing code."
      if (!checks.length) return "No reviewed verification command is configured; stop and report the missing check."
      if (checks.some((check) => !baselines.has(check))) return "Run every reviewed test command before editing to record the baseline."
      if (awaitingCorrection && corrections >= maxCorrections) return "Correction allowance exhausted; report the remaining failure without further edits."
    },
    observe(call: Pick<ToolCall, "name" | "input">, result: ToolResultValue, structured?: unknown) {
      if (result.type === "error") {
        if (call.name === "edit" && /(?:could not find oldString|multiple exact matches|file changed after permission)/i.test(String(result.value)))
          inspected = false
        return
      }
      const input = record(call.input)
      const output = record(structured ?? result.value)
      if (call.name === "read") inspected = true
      if (call.name === "todowrite") planned = Array.isArray(output.todos) && output.todos.some(
        (todo) => typeof record(todo).content === "string" && String(record(todo).content).trim().length > 0,
      )
      if (mutation.has(call.name)) {
        if (awaitingCorrection) { corrections++; awaitingCorrection = false }
        epoch++
        passed.clear()
        if (typeof input.path === "string") changed.add(input.path)
      }
      if (call.name !== "bash" || typeof input.command !== "string" || !checks.includes(input.command) ||
        typeof output.exitCode !== "number" || output.timedOut) return
      if (epoch === 0) baselines.add(input.command)
      else {
        if (output.exitCode !== 0) {
          passed.delete(input.command)
          if (failedEpoch !== epoch) { failedRounds++; failedEpoch = epoch; awaitingCorrection = true }
        } else passed.add(input.command)

      }
    },
    summary() {
      return { inspected, planned, mutationEpoch: epoch, failedRounds,
        correctionAttempts: corrections,
        changedFiles: [...changed], baselineChecks: [...baselines], passedChecks: [...passed],
        testStatus: epoch === 0 ? "not-run-after-edit" : checks.every((check) => passed.has(check)) && checks.length
          ? "passed-in-agent-loop" : "not-passed",
        verification: "requires-independent-receipt" as const }
    },
    finish() {
      if (epoch > 0 && (!checks.length || checks.some((check) => !passed.has(check))))
        throw new Error("Coding task stopped without passing all reviewed checks after the latest edit")
    },
    instruction() {
      return "Coding workflow: inspect source, record todowrite plan, run baseline checks, edit, rerun checks and correct failures within the limit. " +
        "A model statement is not test evidence. Passing agent-run checks is not independent verification. " +
        `Reviewed checks: ${JSON.stringify(checks)}. Completed state: ${JSON.stringify(this.summary())}`
    },
  }
}
export const Active = Context.Reference<ReturnType<typeof make> | undefined>("@phins/CodingWorkflow", { defaultValue: () => undefined })
export const wrap = <A, E, R>(work: Effect.Effect<A, E, R>) => !enabled ? work : Effect.suspend(() => {
  const workflow = make(LocalPolicy.commands(), maximum)
  return work.pipe(Effect.tap(() => Effect.sync(() => workflow.finish())), Effect.provideService(Active, workflow))
})
