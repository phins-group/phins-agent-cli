export * as VerifierOciContainment from "./containment"

import path from "node:path"
import { Clock, Duration, Effect, Layer } from "effect"
import { FileAccess } from "../../workspace/files/access"
import { AbsolutePath } from "../../shared/schema"
import { Snapshot } from "../../workspace/repository/snapshot"
import { Hash } from "../../shared/hash"
import { VerifierContainment } from "../containment"
import { VerifierOciLease } from "./lease"
import { VerifierOciRuntime } from "./runtime"
import { VerifierOciSupervisor } from "./supervisor"
import { VerifierRegistry } from "../registry"

export const EXECUTOR_ID = "phins.oci"
export const EXECUTOR_VERSION = "1"
export const PROFILE = VerifierOciSupervisor.PROFILE
export const LIMITS = Object.freeze({
  cpus: "2",
  memoryBytes: 1024 * 1024 * 1024,
  pids: 256,
  nofile: 1024,
  tmpfsBytes: 64 * 1024 * 1024,
})

const INSPECT_OUTPUT_BYTES = 256 * 1_024
const CLEANUP_TIMEOUT = Duration.seconds(10)
const REAP_GRACE_MS = 30_000
const WORKSPACE = "/workspace"
const CONTAINER_ID = /^[a-f0-9]{64}$/

export interface Dependencies {
  readonly runtime: VerifierOciRuntime.Backend
  readonly snapshots: Snapshot.Interface
  readonly fs: FileAccess.Interface
  readonly supervisor: VerifierOciSupervisor.Interface
  readonly inspectProjectRoot: VerifierRegistry.ProjectRootInspector
}

const failure = (reason: VerifierContainment.ErrorReason, message: string, cause?: unknown) =>
  new VerifierContainment.Error({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const descriptor = (input: VerifierContainment.ExecuteInput) => {
  const { plan, verifier } = input.selection
  const oci = plan.executor.oci
  return plan.source !== "policy" ||
    verifier.provenance?.kind !== "signed-policy" ||
    !input.selection.projectRootIdentity ||
    plan.executor.id !== EXECUTOR_ID ||
    plan.executor.version !== EXECUTOR_VERSION ||
    plan.containment.profile !== PROFILE ||
    !oci
    ? undefined
    : oci
}

const revalidateProjectRoot = Effect.fn(
  "VerifierOciContainment.revalidateProjectRoot",
)(function* (
  dependencies: Dependencies,
  selection: VerifierRegistry.Selection,
) {
  const identity = selection.projectRootIdentity
  if (!identity)
    return yield* failure(
      "descriptor-mismatch",
      "OCI verifier selection is not bound to a project root identity",
    )
  yield* VerifierRegistry.revalidateProjectRoot(
    identity,
    dependencies.inspectProjectRoot,
  ).pipe(
    Effect.mapError((cause) =>
      failure(
        "subject-mismatch",
        "Verifier project root identity changed before contained execution",
        cause,
      ),
    ),
  )
})

const inspectMaterializedDirectory = Effect.fn(
  "VerifierOciContainment.inspectMaterializedDirectory",
)(function* (dependencies: Dependencies, directory: AbsolutePath) {
  const identity = yield* dependencies.inspectProjectRoot(directory).pipe(
    Effect.mapError((cause) =>
      failure(
        "materialization",
        "Failed to bind verifier materialization identity",
        cause,
      ),
    ),
  )
  if (identity.canonicalPath !== directory)
    return yield* failure(
      "materialization",
      "Verifier materialization did not retain its canonical path",
    )
  return identity
})

const revalidateMaterializedDirectory = Effect.fn(
  "VerifierOciContainment.revalidateMaterializedDirectory",
)(function* (
  dependencies: Dependencies,
  identity: VerifierRegistry.ProjectRootIdentity,
) {
  yield* VerifierRegistry.revalidateProjectRoot(
    identity,
    dependencies.inspectProjectRoot,
  ).pipe(
    Effect.mapError((cause) =>
      failure(
        "materialization",
        "Verifier materialization identity changed at the OCI hand-off",
        cause,
      ),
    ),
  )
})

const hostIdentity = () => {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return uid !== undefined && gid !== undefined && uid > 0 ? `${uid}:${gid}` : undefined
}

const inspectImage = Effect.fn("VerifierOciContainment.inspectImage")(function* (
  runtime: VerifierOciRuntime.Backend,
  selection: VerifierRegistry.Selection,
) {
  const oci = selection.plan.executor.oci!
  const inspected = yield* runtime
    .run(["image", "inspect", oci.reference], {
      maxOutputBytes: INSPECT_OUTPUT_BYTES,
      maxErrorBytes: INSPECT_OUTPUT_BYTES,
      timeout: Duration.seconds(15),
    })
    .pipe(Effect.mapError((cause) => failure("descriptor-mismatch", "Pinned OCI image could not be inspected", cause)))
  if (inspected.exitCode !== 0 || inspected.stdoutTruncated || inspected.stderrTruncated)
    return yield* failure("descriptor-mismatch", "Pinned OCI image is unavailable or its metadata is excessive")

  const decoded = yield* Effect.try({
    try: () => JSON.parse(inspected.stdout.toString("utf8")) as unknown,
    catch: (cause) => failure("descriptor-mismatch", "Pinned OCI image metadata is invalid", cause),
  })
  const item = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : undefined
  if (!item || typeof item !== "object" || Array.isArray(item))
    return yield* failure("descriptor-mismatch", "Pinned OCI image metadata is missing")
  const record = item as Record<string, unknown>
  const digests = Array.isArray(record.RepoDigests)
    ? record.RepoDigests.filter((value): value is string => typeof value === "string")
    : []
  const config = record.Config
  if (!config || typeof config !== "object" || Array.isArray(config))
    return yield* failure("descriptor-mismatch", "Pinned OCI image configuration is missing")
  const volumes = (config as Record<string, unknown>).Volumes
  if (
    volumes !== undefined &&
    volumes !== null &&
    (typeof volumes !== "object" || Array.isArray(volumes) || Object.keys(volumes).length > 0)
  )
    return yield* failure("descriptor-mismatch", "Pinned OCI image declares writable volumes")
  const [expectedOs, expectedArchitecture] = oci.platform.split("/")
  if (!digests.includes(oci.reference) || record.Os !== expectedOs || record.Architecture !== expectedArchitecture)
    return yield* failure("descriptor-mismatch", "Local OCI image digest or platform does not match the policy")
})

const validateMaterialization = Effect.fn("VerifierOciContainment.validateMaterialization")(function* (
  fs: FileAccess.Interface,
  input: VerifierContainment.ExecuteInput,
  materialized: Snapshot.Materialization,
  expectedDirectory: string,
) {
  if (
    materialized.snapshot !== input.subject.snapshot ||
    materialized.projectRoot !== input.selection.projectRoot ||
    materialized.directory !== expectedDirectory ||
    FileAccess.overlaps(materialized.directory, input.selection.projectRoot)
  )
    return yield* failure("subject-mismatch", "Materialized verifier subject did not match the pinned selection")
  if (materialized.directory.includes(",") || /[\0\r\n]/.test(materialized.directory))
    return yield* failure("materialization", "Materialized verifier path cannot be represented as a safe OCI mount")

  const cwd = path.resolve(materialized.directory, input.selection.plan.check.cwd)
  if (!FileAccess.contains(materialized.directory, cwd))
    return yield* failure("materialization", "Verifier working directory escapes the materialized snapshot")
  const real = yield* fs
    .realPath(cwd)
    .pipe(Effect.mapError((cause) => failure("materialization", "Verifier working directory is missing", cause)))
  if (real !== cwd || !FileAccess.contains(materialized.directory, real))
    return yield* failure("materialization", "Verifier working directory is not a canonical snapshot directory")
  const info = yield* fs
    .stat(real)
    .pipe(Effect.mapError((cause) => failure("materialization", "Verifier working directory is unavailable", cause)))
  if (info.type !== "Directory")
    return yield* failure("materialization", "Verifier working directory is not a directory")
})

const containerArguments = (
  input: VerifierContainment.ExecuteInput,
  directory: string,
  lease: VerifierOciLease.Lease,
  user: string,
) => {
  const { check, executor } = input.selection.plan
  const oci = executor.oci!
  const containerCwd = check.cwd === "." ? WORKSPACE : `${WORKSPACE}/${check.cwd}`
  return [
    "container",
    "create",
    "--pull=never",
    "--restart=no",
    "--log-driver=none",
    "--no-healthcheck",
    `--name=phins-verifier-${lease.leaseID}`,
    ...Object.entries(VerifierOciSupervisor.labelsFor(lease)).map(([key, value]) => `--label=${key}=${value}`),
    `--platform=${oci.platform}`,
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--ipc=none",
    // Docker isolates PID and UTS namespaces unless either is explicitly shared.
    "--cgroupns=private",
    `--pids-limit=${LIMITS.pids}`,
    `--memory=${LIMITS.memoryBytes}`,
    `--memory-swap=${LIMITS.memoryBytes}`,
    `--cpus=${LIMITS.cpus}`,
    "--ulimit=core=0:0",
    `--ulimit=nofile=${LIMITS.nofile}:${LIMITS.nofile}`,
    `--user=${user}`,
    "--hostname=phins-verifier",
    `--mount=type=bind,src=${directory},dst=${WORKSPACE},readonly,bind-propagation=rprivate`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${LIMITS.tmpfsBytes},mode=1777`,
    `--workdir=${containerCwd}`,
    "--env=CI=1",
    "--env=HOME=/tmp",
    "--env=TMPDIR=/tmp",
    "--env=LANG=C.UTF-8",
    "--env=LC_ALL=C.UTF-8",
    "--env=NO_COLOR=1",
    "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env=HTTP_PROXY=",
    "--env=HTTPS_PROXY=",
    "--env=NO_PROXY=",
    "--env=ALL_PROXY=",
    "--env=FTP_PROXY=",
    "--env=http_proxy=",
    "--env=https_proxy=",
    "--env=no_proxy=",
    "--env=all_proxy=",
    "--env=ftp_proxy=",
    `--entrypoint=${check.argv[0]}`,
    oci.reference,
    ...check.argv.slice(1),
  ]
}

const createdContainerID = (result: {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}) => {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) return undefined
  const text = result.stdout.toString("utf8")
  const candidate = text.endsWith("\n") ? text.slice(0, -1) : text
  return CONTAINER_ID.test(candidate) && !/[\0\r\n]/.test(candidate)
    ? VerifierOciLease.ContainerID.make(candidate)
    : undefined
}

const assertOwnedContainer = (
  container: VerifierOciSupervisor.Container,
  lease: VerifierOciLease.Lease,
  subjectDirectory: AbsolutePath,
) => {
  if (container.image !== lease.image.reference)
    throw failure("descriptor-mismatch", "Created OCI container image did not match its durable lease")
  for (const [key, expected] of Object.entries(VerifierOciSupervisor.labelsFor(lease))) {
    if (container.labels[key] !== expected)
      throw failure("descriptor-mismatch", "Created OCI container labels did not match its durable lease")
  }
  const subjectMounts = container.mounts.filter(
    (mount) => mount.destination === WORKSPACE,
  )
  if (
    subjectMounts.length !== 1 ||
    subjectMounts[0]?.type !== "bind" ||
    subjectMounts[0].source !== subjectDirectory ||
    subjectMounts[0].readWrite ||
    subjectMounts[0].propagation !== "rprivate"
  )
    throw failure(
      "subject-mismatch",
      "Created OCI container did not retain the exact read-only subject mount",
    )
}

interface Lifecycle {
  lease: VerifierOciLease.Lease
  materialization?: Snapshot.Materialization
  containerID?: VerifierOciLease.ContainerID
  createAttempted: boolean
}

const cleanupLifecycle = Effect.fn("VerifierOciContainment.cleanupLifecycle")(function* (
  dependencies: Dependencies,
  lifecycle: Lifecycle,
) {
  if (lifecycle.containerID) {
    yield* dependencies.supervisor
      .remove(lifecycle.containerID, lifecycle.lease)
      .pipe(Effect.mapError((cause) => failure("cleanup", "Failed to remove OCI verifier container", cause)))
  } else if (lifecycle.createAttempted) {
    // The create response was ambiguous. No start was issued, so the durable
    // intent owns eventual label reconciliation and the subject must remain
    // available until the hard reaper deadline.
    yield* Effect.logWarning("Retaining ambiguous OCI verifier lease for reconciliation", {
      leaseID: lifecycle.lease.leaseID,
    })
    return
  }
  if (lifecycle.materialization)
    yield* lifecycle.materialization.cleanup.pipe(
      Effect.mapError((cause) => failure("cleanup", "Failed to clean verifier snapshot materialization", cause)),
    )
  yield* dependencies.supervisor.leases
    .remove(lifecycle.lease.leaseID)
    .pipe(Effect.mapError((cause) => failure("cleanup", "Failed to terminalize OCI verifier lease", cause)))
})

export const make = (dependencies: Dependencies): VerifierContainment.Interface =>
  VerifierContainment.make((input) =>
    Effect.gen(function* () {
      if (!descriptor(input))
        return yield* failure(
          "descriptor-mismatch",
          "Verifier selection is not a signed supported OCI execution descriptor",
        )
      yield* revalidateProjectRoot(dependencies, input.selection)
      const user = hostIdentity()
      if (!user) return yield* failure("unavailable", "OCI containment requires a non-root POSIX agent identity")
      const nowMs = yield* Clock.currentTimeMillis
      yield* dependencies.supervisor
        .reap(nowMs)
        .pipe(Effect.mapError((cause) => failure("cleanup", "OCI verifier reconciliation failed", cause)))
      yield* inspectImage(dependencies.runtime, input.selection)
      yield* dependencies.snapshots
        .retain(input.subject.snapshot)
        .pipe(
          Effect.mapError((cause) =>
            failure("materialization", "Verifier snapshot could not be retained", cause),
          ),
        )
      const reapAfterMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        nowMs + input.selection.plan.check.timeoutMs + REAP_GRACE_MS,
      )
      return yield* Effect.acquireUseRelease(
        dependencies.supervisor.leases
          .prepare({
            executionHash: `sha256:${Hash.sha256(input.subject.executionID)}`,
            snapshot: input.subject.snapshot,
            image: input.selection.plan.executor.oci!,
            reapAfterMs,
          })
          .pipe(
            Effect.map(
              (lease): Lifecycle => ({
                lease,
                createAttempted: false,
              }),
            ),
            Effect.mapError((cause) => failure("unavailable", "Failed to prepare durable OCI lease", cause)),
          ),
        (owned) =>
          Effect.gen(function* () {
            yield* revalidateProjectRoot(
              dependencies,
              input.selection,
            )
            const subject = yield* dependencies.snapshots
              .materializeAt(input.subject.snapshot, owned.lease.subject)
              .pipe(
                Effect.mapError((cause) => failure("materialization", "Verifier subject materialization failed", cause)),
              )
            owned.materialization = subject
            yield* validateMaterialization(dependencies.fs, input, subject, owned.lease.subject)
            const materializationIdentity =
              yield* inspectMaterializedDirectory(
                dependencies,
                subject.directory,
              )
            yield* revalidateProjectRoot(
              dependencies,
              input.selection,
            )
            yield* revalidateMaterializedDirectory(
              dependencies,
              materializationIdentity,
            )
            owned.createAttempted = true
            const created = yield* dependencies.runtime
              .run(containerArguments(input, subject.directory, owned.lease, user), {
                maxOutputBytes: INSPECT_OUTPUT_BYTES,
                maxErrorBytes: INSPECT_OUTPUT_BYTES,
                timeout: CLEANUP_TIMEOUT,
              })
              .pipe(Effect.mapError((cause) => failure("launch", "OCI verifier create request failed", cause)))
            const containerID = createdContainerID(created)
            if (!containerID)
              return yield* failure("launch", "OCI verifier create response did not contain one immutable container ID")
            owned.containerID = containerID
            owned.lease = yield* dependencies.supervisor.leases
              .commitContainerID(owned.lease.leaseID, containerID)
              .pipe(
                Effect.mapError((cause) => failure("launch", "Failed to commit durable OCI container identity", cause)),
              )
            const admitted = yield* dependencies.supervisor
              .inspect(containerID)
              .pipe(Effect.mapError((cause) => failure("launch", "Created OCI container could not be inspected", cause)))
            if (!admitted) return yield* failure("launch", "Created OCI container disappeared before admission")
            yield* revalidateMaterializedDirectory(
              dependencies,
              materializationIdentity,
            )
            yield* Effect.try({
              try: () =>
                assertOwnedContainer(
                  admitted,
                  owned.lease,
                  subject.directory,
                ),
              catch: (cause) =>
                cause instanceof VerifierContainment.Error
                  ? cause
                  : failure("descriptor-mismatch", "Created OCI container ownership was invalid", cause),
            })
            if (admitted.state.running || admitted.state.status !== "created")
              return yield* failure("launch", "OCI container was not inert before its durable start boundary")

            const started = yield* Clock.currentTimeNanos
            const executed = yield* dependencies.runtime
              .run(["container", "start", "--attach", containerID], {
                maxOutputBytes: input.selection.plan.check.maxOutputBytes + 1,
                maxErrorBytes: input.selection.plan.check.maxOutputBytes + 1,
              })
              .pipe(Effect.mapError((cause) => failure("launch", "OCI verifier start request failed", cause)))
            yield* revalidateMaterializedDirectory(
              dependencies,
              materializationIdentity,
            )
            yield* revalidateProjectRoot(
              dependencies,
              input.selection,
            )
            if (executed.stdoutTruncated || executed.stderrTruncated)
              return yield* failure("output-limit", "OCI verifier output exceeded the pinned limit")
            const outputBytes = executed.stdout.length + executed.stderr.length
            if (outputBytes > input.selection.plan.check.maxOutputBytes)
              return yield* failure("output-limit", "OCI verifier output exceeded the pinned limit")
            const completedContainer = yield* dependencies.supervisor
              .inspect(containerID)
              .pipe(Effect.mapError((cause) => failure("launch", "Completed OCI container could not be inspected", cause)))
            if (!completedContainer)
              return yield* failure("launch", "OCI container disappeared before terminal state inspection")
            yield* Effect.try({
              try: () =>
                assertOwnedContainer(
                  completedContainer,
                  owned.lease,
                  subject.directory,
                ),
              catch: (cause) =>
                cause instanceof VerifierContainment.Error
                  ? cause
                  : failure("descriptor-mismatch", "Completed OCI container ownership was invalid", cause),
            })
            if (completedContainer.state.running || completedContainer.state.status !== "exited")
              return yield* failure("launch", "OCI container did not reach a trustworthy terminal state")
            const completed = yield* Clock.currentTimeNanos
            const durationMs = Number((completed >= started ? completed - started : 0n) / 1_000_000n)
            const exitCode = completedContainer.state.exitCode
            const infrastructureError =
              executed.exitCode !== exitCode ||
              completedContainer.state.oomKilled ||
              completedContainer.state.error.length > 0
            return {
              executor: input.selection.plan.executor,
              subject: input.subject,
              status: infrastructureError
                ? ("error" as const)
                : exitCode === 0
                  ? ("passed" as const)
                  : ("failed" as const),
              exitCode,
              durationMs,
              stdout: executed.stdout.toString("utf8"),
              stderr: executed.stderr.toString("utf8"),
              summary: infrastructureError ? "OCI verifier runtime reported a terminal error" : "OCI verifier completed",
              outputTruncated: false,
            }
          }),
        (owned) => cleanupLifecycle(dependencies, owned),
      )
    }),
  )

export const layer = Layer.effect(
  VerifierContainment.Service,
  Effect.gen(function* () {
    const runtime = yield* VerifierOciRuntime.Service
    if (!runtime.backend) return VerifierContainment.unavailable
    return make({
      runtime: runtime.backend,
      snapshots: yield* Snapshot.Service,
      fs: yield* FileAccess.Service,
      supervisor: yield* VerifierOciSupervisor.Service,
      inspectProjectRoot: VerifierRegistry.inspectProjectRoot,
    })
  }),
)
