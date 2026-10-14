export * as VerifierContainment from "./containment"

import { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { Context, Effect, Layer, Schema } from "effect"
import { ProjectRegistry } from "../workspace/projects/service"
import { NonNegativeInt } from "../shared/schema"
import { Snapshot } from "../workspace/repository/snapshot"
import { isDeepStrictEqual } from "node:util"
import { VerifierRegistry } from "./registry"

export const MAX_OUTPUT_CHARS = VerificationReceipt.MAX_CHECK_OUTPUT_CHARS
export const MAX_SUMMARY_CHARS = VerificationReceipt.MAX_CHECK_SUMMARY_CHARS

const Output = Schema.String.check(Schema.isMaxLength(MAX_OUTPUT_CHARS))
const Summary = Schema.String.check(Schema.isMaxLength(MAX_SUMMARY_CHARS))

export const Status = Schema.Literals(["passed", "failed", "error", "timeout"])
export type Status = typeof Status.Type

export const Subject = Schema.Struct({
  executionID: VerificationReceipt.ID,
  snapshot: Snapshot.ID,
  projectID: ProjectRegistry.ID,
  locationKey: VerificationReceipt.LocationKey,
}).annotate({ identifier: "VerifierContainment.Subject" })
export type Subject = typeof Subject.Type

const ResultFields = Schema.Struct({
  executor: VerifierRegistry.Executor,
  subject: Subject,
  status: Status,
  exitCode: Schema.Int.pipe(Schema.optional),
  durationMs: NonNegativeInt,
  stdout: Output.pipe(Schema.optional),
  stderr: Output.pipe(Schema.optional),
  summary: Summary.pipe(Schema.optional),
  outputTruncated: Schema.Boolean,
})

export const Result = ResultFields.check(
  Schema.makeFilter<typeof ResultFields.Type>((value) => {
    if (value.status === "passed" && value.exitCode !== 0)
      return {
        path: ["exitCode"],
        issue: "passed result exitCode must be 0",
      }
    if (value.status === "failed" && (value.exitCode === undefined || value.exitCode === 0))
      return {
        path: ["exitCode"],
        issue: "failed result exitCode must be non-zero",
      }
    return undefined
  }),
).annotate({ identifier: "VerifierContainment.Result" })
export type Result = typeof Result.Type

export const ErrorReason = Schema.Literals([
  "unavailable",
  "descriptor-mismatch",
  "subject-mismatch",
  "invalid-result",
  "output-limit",
  "timeout",
  "materialization",
  "launch",
  "cleanup",
])
export type ErrorReason = typeof ErrorReason.Type

export class Error extends Schema.TaggedErrorClass<Error>()("VerifierContainment.Error", {
  reason: ErrorReason,
  message: Summary,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ExecuteInput {
  readonly selection: VerifierRegistry.Selection
  readonly subject: Subject
}

export interface Interface {
  /**
   * Executes one pinned verifier against one pinned snapshot as a single
   * containment operation. Implementations own materialization through cleanup.
   */
  readonly execute: (input: ExecuteInput) => Effect.Effect<Result, Error>
}

export type AdapterExecute = (input: ExecuteInput) => Effect.Effect<unknown, Error>

/**
 * Wraps one platform adapter with the Core-owned validation and deadline
 * boundary. The adapter remains part of the trusted computing base and must
 * guarantee isolated materialization, process-tree cleanup, and resource caps.
 */
export const make = (adapterExecute: AdapterExecute): Interface =>
  Object.freeze({
    execute: (input: ExecuteInput) => {
      if (input.selection.projectID !== input.subject.projectID)
        return Effect.fail(
          new Error({
            reason: "subject-mismatch",
            message: "Verifier selection and subject project do not match",
          }),
        )

      const boundInput = Object.freeze({
        selection: input.selection,
        subject: Object.freeze(input.subject),
      })
      return Effect.suspend(() => adapterExecute(boundInput)).pipe(
        Effect.timeoutOrElse({
          duration: input.selection.plan.check.timeoutMs,
          orElse: () =>
            Effect.fail(
              new Error({
                reason: "timeout",
                message: "Verifier containment exceeded the pinned timeout",
              }),
            ),
        }),
        Effect.flatMap((result) =>
          decodeResult(result).pipe(
            Effect.mapError(
              () =>
                new Error({
                  reason: "invalid-result",
                  message: "Verifier containment returned an invalid result",
                }),
            ),
          ),
        ),
        Effect.flatMap((result) => {
          if (!isDeepStrictEqual(result.subject, boundInput.subject))
            return Effect.fail(
              new Error({
                reason: "subject-mismatch",
                message: "Verifier containment result subject did not match",
              }),
            )
          if (!isDeepStrictEqual(result.executor, input.selection.plan.executor))
            return Effect.fail(
              new Error({
                reason: "descriptor-mismatch",
                message: "Verifier containment executor descriptor did not match",
              }),
            )
          const outputBytes =
            Buffer.byteLength(result.stdout ?? "", "utf8") + Buffer.byteLength(result.stderr ?? "", "utf8")
          if (outputBytes > input.selection.plan.check.maxOutputBytes)
            return Effect.fail(
              new Error({
                reason: "output-limit",
                message: "Verifier containment returned output beyond the pinned limit",
              }),
            )
          if (result.durationMs > input.selection.plan.check.timeoutMs)
            return Effect.fail(
              new Error({
                reason: "timeout",
                message: "Verifier containment reported duration beyond the pinned timeout",
                }),
              )
          return Effect.succeed(
            Object.freeze({
              ...result,
              executor: input.selection.plan.executor,
              subject: boundInput.subject,
            }),
          )
        }),
      )
    },
  })

export const unavailable = make(() =>
  Effect.fail(
    new Error({
      reason: "unavailable",
      message: "No verifier containment executor is available",
    }),
  ),
)

/**
 * Fail-closed by default. A platform adapter must explicitly replace this
 * reference; Core never falls back to launching the verifier on the host.
 */
export class Service extends Context.Service<Service, Interface>()("@phins/v2/VerifierContainment") {}

export const unavailableLayer = Layer.succeed(Service, unavailable)

export const decodeResult = (input: unknown) =>
  Schema.decodeUnknownEffect(Result)(input, {
    errors: "all",
    onExcessProperty: "error",
  })
