export * as VerifierRegistry from "./registry"

import { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { Context, Effect, Layer, Schema } from "effect"
import { lstat, realpath } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { ProjectRegistry } from "../workspace/projects/service"
import { AbsolutePath, PositiveInt } from "../shared/schema"
import { Hash } from "../shared/hash"

const MAX_FIELD_CHARS = 256
const MAX_OCI_REFERENCE_CHARS = 1_024
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_OUTPUT_BYTES = VerificationReceipt.MAX_CHECK_OUTPUT_CHARS
export const MAX_CWD_BYTES = 4_096
export const MAX_ARGV_BYTES = 64 * 1_024
export const MAX_PROJECT_ID_BYTES = 4_096
const Field = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_FIELD_CHARS))
const CommandArgument = Schema.String.check(
  Schema.isMaxLength(VerificationReceipt.MAX_COMMAND_ARGUMENT_CHARS),
  Schema.makeFilter((value) => (value.includes("\0") ? "command arguments must not contain NUL" : undefined)),
)
const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const FilesystemIdentity = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/),
)

export const ProjectRootIdentity = Schema.Struct({
  schema: Schema.Literal("phins.verifier-project-root-identity.v1"),
  canonicalPath: AbsolutePath,
  device: FilesystemIdentity,
  inode: FilesystemIdentity,
}).annotate({ identifier: "VerifierRegistry.ProjectRootIdentity" })
export type ProjectRootIdentity = typeof ProjectRootIdentity.Type

export class ProjectRootIdentityError extends globalThis.Error {
  override readonly name = "VerifierRegistry.ProjectRootIdentityError"
}

export type ProjectRootInspector = (
  projectRoot: AbsolutePath,
) => Effect.Effect<ProjectRootIdentity, unknown>

/** Capture a canonical directory path and a stable identity without accepting a raced lookup. */
export const inspectProjectRoot = Effect.fn(
  "VerifierRegistry.inspectProjectRoot",
)(function* (projectRoot: AbsolutePath) {
  return yield* Effect.tryPromise({
    try: async () => {
      const canonical = await realpath(projectRoot)
      if (
        !path.isAbsolute(canonical) ||
        path.normalize(canonical) !== canonical ||
        path.resolve(canonical) !== canonical
      )
        throw new ProjectRootIdentityError(
          "Verifier project root did not resolve to a canonical absolute path",
        )
      const before = await lstat(canonical, { bigint: true })
      if (!before.isDirectory() || before.isSymbolicLink())
        throw new ProjectRootIdentityError(
          "Verifier project root is not a canonical directory",
        )
      const resolvedAgain = await realpath(projectRoot)
      const after = await lstat(canonical, { bigint: true })
      if (
        resolvedAgain !== canonical ||
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        throw new ProjectRootIdentityError(
          "Verifier project root changed while its identity was captured",
        )
      return Schema.decodeUnknownSync(ProjectRootIdentity)({
        schema: "phins.verifier-project-root-identity.v1",
        canonicalPath: AbsolutePath.make(canonical),
        device: after.dev.toString(10),
        inode: after.ino.toString(10),
      })
    },
    catch: (cause) =>
      cause instanceof ProjectRootIdentityError
        ? cause
        : new ProjectRootIdentityError(
            `Failed to inspect verifier project root: ${projectRoot}`,
            { cause },
          ),
  })
})

export const revalidateProjectRoot = Effect.fn(
  "VerifierRegistry.revalidateProjectRoot",
)(function* (
  identity: ProjectRootIdentity,
  inspect: ProjectRootInspector = inspectProjectRoot,
) {
  const current = yield* inspect(identity.canonicalPath)
  if (!isDeepStrictEqual(current, identity))
    return yield* Effect.fail(
      new ProjectRootIdentityError(
        "Verifier project root identity changed after selection",
      ),
    )
})

const OciReference = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_OCI_REFERENCE_CHARS),
  Schema.makeFilter((value) => {
    if (value.includes("\0") || value !== value.toLowerCase())
      return "OCI reference must be lowercase and must not contain NUL"
    const marker = value.lastIndexOf("@sha256:")
    if (marker <= 0 || marker + 8 + 64 !== value.length)
      return "OCI reference must pin one full sha256 manifest digest"
    const repository = value.slice(0, marker)
    if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(repository)) return "OCI repository contains unsafe characters"
    if (
      repository.startsWith("/") ||
      repository.endsWith("/") ||
      repository.includes("//") ||
      repository.split("/").some((component) => component === "." || component === "..")
    )
      return "OCI repository must be normalized"
    return undefined
  }),
)

export const OciPlatform = Schema.Literals(["linux/amd64", "linux/arm64"])
export type OciPlatform = typeof OciPlatform.Type

export const OciImage = Schema.Struct({
  reference: OciReference,
  platform: OciPlatform,
}).annotate({ identifier: "VerifierRegistry.OciImage" })
export type OciImage = typeof OciImage.Type

const normalizeCwd = (input: string) => (input.length === 0 ? input : path.posix.normalize(input.replaceAll("\\", "/")))

const ProjectRelativeCwd = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_CWD_BYTES),
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "cwd must not contain NUL"
    if (Buffer.byteLength(value, "utf8") > MAX_CWD_BYTES) return `cwd must not exceed ${MAX_CWD_BYTES} UTF-8 bytes`
    if (value !== normalizeCwd(value)) return "cwd must be normalized"
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value))
      return "cwd must be project-relative"
    if (value === ".." || value.startsWith("../")) return "cwd must not escape the project"
    return undefined
  }),
)

const CommandArguments = Schema.Array(CommandArgument).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(VerificationReceipt.MAX_COMMAND_ARGUMENTS),
  Schema.makeFilter((value) => {
    if (value[0]?.trim().length === 0) return "argv[0] must not be empty"
    const bytes = value.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8") + 1, 0)
    return bytes > MAX_ARGV_BYTES ? `argv must not exceed ${MAX_ARGV_BYTES} UTF-8 bytes` : undefined
  }),
)

export const Check = Schema.Struct({
  id: Field,
  argv: CommandArguments,
  cwd: ProjectRelativeCwd,
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  maxOutputBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
}).annotate({ identifier: "VerifierRegistry.Check" })
export type Check = typeof Check.Type

const ExecutorFields = Schema.Struct({
  id: Field,
  version: Field,
  bundleDigest: Sha256Digest,
  oci: OciImage.pipe(Schema.optional),
})

export const Executor = ExecutorFields.check(
  Schema.makeFilter<typeof ExecutorFields.Type>((value) => {
    if (value.oci && !value.oci.reference.endsWith(`@${value.bundleDigest}`))
      return {
        path: ["oci", "reference"],
        issue: "OCI reference manifest digest must match executor bundleDigest",
      }
    return undefined
  }),
).annotate({ identifier: "VerifierRegistry.Executor" })
export type Executor = typeof Executor.Type

export const Containment = Schema.Struct({
  subject: Schema.Literal("snapshot-copy"),
  filesystem: Schema.Literal("read-only"),
  network: Schema.Literal("network-deny"),
  environment: Schema.Literal("sanitized-env"),
  profile: Schema.Literal("linux-oci-v1").pipe(Schema.optional),
}).annotate({ identifier: "VerifierRegistry.Containment" })
export type Containment = typeof Containment.Type

export const Plan = Schema.Struct({
  id: Field,
  version: Field,
  source: Schema.Literals(["task", "policy", "project"]),
  check: Check,
  executor: Executor,
  containment: Containment,
}).annotate({ identifier: "VerifierRegistry.Plan" })
export type Plan = typeof Plan.Type

export type Selection = {
  readonly plan: Plan
  readonly projectID: ProjectRegistry.ID
  readonly projectRoot: AbsolutePath
  /** Present only for v3 selections bound to a canonical directory identity. */
  readonly projectRootIdentity?: ProjectRootIdentity
  readonly verifier: VerificationReceipt.Verifier
}

export interface SelectInput {
  readonly projectID: ProjectRegistry.ID
  readonly projectRoot: AbsolutePath
  readonly projectRootIdentity?: ProjectRootIdentity
}

export interface Interface {
  readonly select: (input: SelectInput) => Effect.Effect<Selection | undefined>
}

export class Registry extends Context.Service<Registry, Interface>()("@phins/v2/VerifierRegistry") {}

export const empty = Object.freeze(
  Registry.of({
    select: (_input) => Effect.succeed(undefined),
  }),
)

export const defaultLayer = Layer.succeed(Registry, empty)

const normalizePlan = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || !("check" in input)) return input
  const check = input.check
  if (typeof check !== "object" || check === null || !("cwd" in check) || typeof check.cwd !== "string") return input
  return {
    ...input,
    check: {
      ...check,
      cwd: normalizeCwd(check.cwd),
    },
  }
}

const decodePlan = (input: unknown) =>
  Schema.decodeUnknownSync(Plan)(normalizePlan(input), {
    errors: "all",
    onExcessProperty: "error",
  })

const deepFreeze = <T>(input: T): T => {
  if (typeof input !== "object" || input === null) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.isFrozen(input) ? input : Object.freeze(input)
}

const canonicalPlan = (plan: Plan) =>
  [
    plan.id,
    plan.version,
    plan.source,
    [plan.check.id, [...plan.check.argv], plan.check.cwd, plan.check.timeoutMs, plan.check.maxOutputBytes],
    plan.executor.oci
      ? [
          plan.executor.id,
          plan.executor.version,
          plan.executor.bundleDigest,
          [plan.executor.oci.reference, plan.executor.oci.platform],
        ]
      : [plan.executor.id, plan.executor.version, plan.executor.bundleDigest],
    plan.containment.profile
      ? [
          plan.containment.subject,
          plan.containment.filesystem,
          plan.containment.network,
          plan.containment.environment,
          plan.containment.profile,
        ]
      : [plan.containment.subject, plan.containment.filesystem, plan.containment.network, plan.containment.environment],
  ] as const

const canonical = (
  plan: Plan,
  selection: SelectInput,
  provenance?: VerificationReceipt.Provenance,
) => {
  const fields = canonicalPlan(plan)
  // Keep v1 and signed path-only v2 byte-for-byte compatible. Strict
  // signed-policy selections use v3 to bind canonical filesystem identity.
  if (!provenance) return ["phins.verifier-plan.v1", selection.projectID, ...fields] as const
  if (!selection.projectRootIdentity)
    return [
      "phins.verifier-plan.v2",
      selection.projectID,
      selection.projectRoot,
      ...fields,
      [provenance.kind, provenance.authorityID, provenance.keyID, provenance.revision, provenance.policyDigest],
    ] as const
  return [
    "phins.verifier-plan.v3",
    selection.projectID,
    selection.projectRoot,
    [
      selection.projectRootIdentity.schema,
      selection.projectRootIdentity.canonicalPath,
      selection.projectRootIdentity.device,
      selection.projectRootIdentity.inode,
    ],
    ...fields,
    [provenance.kind, provenance.authorityID, provenance.keyID, provenance.revision, provenance.policyDigest],
  ] as const
}

export const pin = (input: unknown, inputSelection: SelectInput, inputProvenance?: unknown): Selection => {
  const plan = decodePlan(input)
  const projectID = Schema.decodeUnknownSync(ProjectRegistry.ID)(inputSelection.projectID)
  const projectRoot = Schema.decodeUnknownSync(AbsolutePath)(inputSelection.projectRoot)
  if (projectID.includes("\0") || Buffer.byteLength(projectID, "utf8") > MAX_PROJECT_ID_BYTES)
    throw new TypeError(`projectID must not contain NUL or exceed ${MAX_PROJECT_ID_BYTES} UTF-8 bytes`)
  const provenance =
    inputProvenance === undefined
      ? undefined
      : Schema.decodeUnknownSync(VerificationReceipt.Provenance)(inputProvenance, {
          errors: "all",
          onExcessProperty: "error",
        })
  const projectRootIdentity =
    inputSelection.projectRootIdentity === undefined
      ? undefined
      : Schema.decodeUnknownSync(ProjectRootIdentity)(
          inputSelection.projectRootIdentity,
          {
            errors: "all",
            onExcessProperty: "error",
          },
        )
  if (projectRootIdentity && !provenance)
    throw new TypeError(
      "project root identity requires signed-policy provenance",
    )
  if (
    projectRootIdentity &&
    projectRootIdentity.canonicalPath !== projectRoot
  )
    throw new TypeError(
      "project root identity canonical path does not match the selection root",
    )
  const selection = {
    projectID,
    projectRoot,
    ...(projectRootIdentity ? { projectRootIdentity } : {}),
  }
  const digest = `sha256:${Hash.sha256(JSON.stringify(canonical(plan, selection, provenance)))}`
  const verifier = Schema.decodeUnknownSync(VerificationReceipt.Verifier)({
    id: plan.id,
    version: plan.version,
    source: plan.source,
    digest,
    ...(provenance ? { provenance } : {}),
  })
  return deepFreeze({ ...selection, plan, verifier })
}

export const fixed = (input: unknown): Interface => {
  const plan = deepFreeze(decodePlan(input))
  return Object.freeze({
    select: (selection: SelectInput) => Effect.sync(() => pin(plan, selection)),
  })
}
