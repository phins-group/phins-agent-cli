export * as VerifierOciSupervisor from "./supervisor"

import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { AppPaths } from "../../runtime/paths"
import { VerifierOciLease } from "./lease"
import { VerifierOciRuntime } from "./runtime"

const INSPECT_OUTPUT_BYTES = 256 * 1_024
const LIST_OUTPUT_BYTES = 4 * 1_024 * 1_024
const CLEANUP_TIMEOUT = Duration.seconds(10)
const REAP_INTERVAL = Duration.minutes(1)
const CONTAINER_ID = /^[a-f0-9]{64}$/

export const PROFILE = "linux-oci-v1"
export const LABEL = Object.freeze({
  managed: "dev.phins.verifier.managed",
  lease: "dev.phins.verifier.lease",
  owner: "dev.phins.verifier.owner",
  execution: "dev.phins.verifier.execution",
  reapAfter: "dev.phins.verifier.reap-after",
})

export const Operation = Schema.Literals(["lease", "list", "inspect", "ownership", "remove", "reap"])
export type Operation = typeof Operation.Type

export class Error extends Schema.TaggedErrorClass<Error>()("VerifierOciSupervisor.Error", {
  operation: Operation,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ContainerState {
  readonly status: string
  readonly running: boolean
  readonly exitCode: number
  readonly oomKilled: boolean
  readonly error: string
}

export interface ContainerMount {
  readonly type: string
  readonly source: string
  readonly destination: string
  readonly readWrite: boolean
  readonly propagation: string
}

export interface Container {
  readonly id: VerifierOciLease.ContainerID
  readonly image: string
  readonly labels: Readonly<Record<string, string>>
  readonly mounts: readonly ContainerMount[]
  readonly state: ContainerState
}

export interface Report {
  readonly examined: number
  readonly expired: number
  readonly deferredExpired: number
  readonly removedContainers: number
  readonly terminalLeases: number
  readonly tombstones: number
  readonly retiredTombstones: number
}

export interface Dependencies {
  readonly runtime?: VerifierOciRuntime.Backend
  readonly leases: VerifierOciLease.Interface
}

export interface Interface {
  readonly leases: VerifierOciLease.Interface
  readonly inspect: (containerID: string) => Effect.Effect<Container | undefined, Error>
  readonly remove: (containerID: string, lease: VerifierOciLease.Lease) => Effect.Effect<void, Error>
  readonly reap: (nowMs?: number) => Effect.Effect<Report, Error>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/VerifierOciSupervisor") {}

const failure = (operation: Operation, message: string, cause?: unknown) =>
  new Error({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

export const labelsFor = (lease: VerifierOciLease.Lease): Readonly<Record<string, string>> =>
  Object.freeze({
    [LABEL.managed]: PROFILE,
    [LABEL.lease]: lease.leaseID,
    [LABEL.owner]: lease.owner,
    [LABEL.execution]: lease.executionHash,
    [LABEL.reapAfter]: String(lease.reapAfterMs),
  })

const missingContainer = (exitCode: number, stderr: Buffer) =>
  exitCode === 1 && /no such (?:object|container)/i.test(stderr.toString("utf8"))

const decodeContainer = (value: unknown): Container => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new globalThis.Error("OCI container metadata is missing")
  const record = value as Record<string, unknown>
  const config = record.Config
  const state = record.State
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new globalThis.Error("OCI container configuration is missing")
  if (!state || typeof state !== "object" || Array.isArray(state))
    throw new globalThis.Error("OCI container state is missing")
  const configRecord = config as Record<string, unknown>
  const stateRecord = state as Record<string, unknown>
  const rawLabels = configRecord.Labels
  if (!rawLabels || typeof rawLabels !== "object" || Array.isArray(rawLabels))
    throw new globalThis.Error("OCI container labels are missing")
  const labels: Record<string, string> = {}
  for (const [key, label] of Object.entries(rawLabels)) {
    if (typeof label !== "string") throw new globalThis.Error("OCI container label is not a string")
    labels[key] = label
  }
  const rawMounts = record.Mounts ?? []
  if (!Array.isArray(rawMounts))
    throw new globalThis.Error("OCI container mounts are invalid")
  const mounts = rawMounts.map((value): ContainerMount => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new globalThis.Error("OCI container mount metadata is invalid")
    const mount = value as Record<string, unknown>
    if (
      typeof mount.Type !== "string" ||
      mount.Type.length === 0 ||
      typeof mount.Source !== "string" ||
      mount.Source.length === 0 ||
      /[\0\r\n]/.test(mount.Source) ||
      typeof mount.Destination !== "string" ||
      mount.Destination.length === 0 ||
      /[\0\r\n]/.test(mount.Destination) ||
      typeof mount.RW !== "boolean" ||
      typeof mount.Propagation !== "string"
    )
      throw new globalThis.Error("OCI container mount metadata is invalid")
    return Object.freeze({
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
      readWrite: mount.RW,
      propagation: mount.Propagation,
    })
  })
  const id = record.Id
  const image = configRecord.Image
  const status = stateRecord.Status
  const running = stateRecord.Running
  const exitCode = stateRecord.ExitCode
  const oomKilled = stateRecord.OOMKilled
  const stateError = stateRecord.Error
  if (
    typeof id !== "string" ||
    !CONTAINER_ID.test(id) ||
    typeof image !== "string" ||
    image.length === 0 ||
    typeof status !== "string" ||
    status.length === 0 ||
    typeof running !== "boolean" ||
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    typeof oomKilled !== "boolean" ||
    typeof stateError !== "string"
  )
    throw new globalThis.Error("OCI container metadata has an invalid shape")
  return Object.freeze({
    id: VerifierOciLease.ContainerID.make(id),
    image,
    labels: Object.freeze(labels),
    mounts: Object.freeze(mounts),
    state: Object.freeze({ status, running, exitCode, oomKilled, error: stateError }),
  })
}

const assertOwned = (container: Container, lease: VerifierOciLease.Lease) => {
  if (container.image !== lease.image.reference)
    throw failure("ownership", "OCI container image does not match its durable lease")
  for (const [key, expected] of Object.entries(labelsFor(lease))) {
    if (container.labels[key] !== expected)
      throw failure("ownership", "OCI container labels do not match its durable lease")
  }
}

const decodeContainerIDs = (stdout: Buffer) => {
  if (stdout.length === 0) return [] as VerifierOciLease.ContainerID[]
  const text = stdout.toString("utf8")
  if (!text.endsWith("\n") || /[\0\r]/.test(text))
    throw new globalThis.Error("OCI container list is not canonical")
  const ids = text.slice(0, -1).split("\n")
  const unique = new Set(ids)
  if (unique.size !== ids.length || ids.some((id) => !CONTAINER_ID.test(id)))
    throw new globalThis.Error("OCI container list contains an invalid ID")
  return ids.map((id) => VerifierOciLease.ContainerID.make(id))
}

export const make = (dependencies: Dependencies): Interface => {
  const inspect = Effect.fn("VerifierOciSupervisor.inspect")(function* (containerIDInput: string) {
    if (!CONTAINER_ID.test(containerIDInput))
      return yield* failure("inspect", "OCI container ID is not a full immutable ID")
    if (!dependencies.runtime) return yield* failure("inspect", "OCI runtime is unavailable")
    const result = yield* dependencies.runtime
      .run(["container", "inspect", containerIDInput], {
        maxOutputBytes: INSPECT_OUTPUT_BYTES,
        maxErrorBytes: INSPECT_OUTPUT_BYTES,
        timeout: CLEANUP_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => failure("inspect", "OCI container inspection failed", cause)))
    if (result.stdoutTruncated || result.stderrTruncated)
      return yield* failure("inspect", "OCI container inspection output exceeded its limit")
    if (result.exitCode !== 0) {
      if (missingContainer(result.exitCode, result.stderr)) return undefined
      return yield* failure("inspect", "OCI runtime could not prove container state")
    }
    const decoded = yield* Effect.try({
      try: () => JSON.parse(result.stdout.toString("utf8")) as unknown,
      catch: (cause) => failure("inspect", "OCI container metadata is invalid", cause),
    })
    const item = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : undefined
    const container = yield* Effect.try({
      try: () => decodeContainer(item),
      catch: (cause) =>
        cause instanceof Error ? cause : failure("inspect", "OCI container metadata is invalid", cause),
    })
    if (container.id !== containerIDInput)
      return yield* failure("inspect", "OCI container inspection returned a different immutable ID")
    return container
  })

  const remove = Effect.fn("VerifierOciSupervisor.remove")(function* (
    containerID: string,
    lease: VerifierOciLease.Lease,
  ) {
    const before = yield* inspect(containerID)
    if (!before) return
    yield* Effect.try({
      try: () => assertOwned(before, lease),
      catch: (cause) => (cause instanceof Error ? cause : failure("ownership", "OCI ownership check failed", cause)),
    })
    if (!dependencies.runtime) return yield* failure("remove", "OCI runtime is unavailable")
    const removed = yield* dependencies.runtime
      .run(["container", "rm", "--force", before.id], {
        maxOutputBytes: INSPECT_OUTPUT_BYTES,
        maxErrorBytes: INSPECT_OUTPUT_BYTES,
        timeout: CLEANUP_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => failure("remove", "OCI container removal failed", cause)))
    if (removed.stdoutTruncated || removed.stderrTruncated)
      return yield* failure("remove", "OCI container removal output exceeded its limit")
    const after = yield* inspect(before.id)
    if (after) return yield* failure("remove", "OCI container still exists after forced removal")
  })

  const list = Effect.fn("VerifierOciSupervisor.list")(function* (lease: VerifierOciLease.Lease) {
    if (!dependencies.runtime) return yield* failure("list", "OCI runtime is unavailable")
    const filters = Object.entries(labelsFor(lease)).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`])
    const result = yield* dependencies.runtime
      .run(["container", "ls", "--all", "--no-trunc", "--quiet", ...filters], {
        maxOutputBytes: LIST_OUTPUT_BYTES,
        maxErrorBytes: INSPECT_OUTPUT_BYTES,
        timeout: CLEANUP_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => failure("list", "OCI container reconciliation list failed", cause)))
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
      return yield* failure("list", "OCI container reconciliation list was not trustworthy")
    return yield* Effect.try({
      try: () => decodeContainerIDs(result.stdout),
      catch: (cause) => failure("list", "OCI container reconciliation list is invalid", cause),
    })
  })

  const reap = Effect.fn("VerifierOciSupervisor.reap")(function* (nowInput?: number) {
    const nowMs = nowInput ?? (yield* Clock.currentTimeMillis)
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      return yield* failure("reap", "OCI reaper time must be a non-negative safe integer")
    const leases = yield* dependencies.leases
      .readAll(nowMs)
      .pipe(Effect.mapError((cause) => failure("lease", "Failed to read durable OCI leases", cause)))
    const expiredLeases = leases.filter(
      (lease) => lease.reapAfterMs <= nowMs,
    )
    const batch = expiredLeases.slice(
      0,
      VerifierOciLease.RETIREMENT_POLICY.expiredLeasesPerReap,
    )
    const expired = expiredLeases.length
    let removedContainers = 0
    let terminalLeases = 0
    let tombstones = 0
    let retiredTombstones = 0
    let retirementBudget =
      VerifierOciLease.RETIREMENT_POLICY.noStartRetirementsPerReap
    const failures: unknown[] = []
    for (const lease of batch) {
      const outcome = yield* Effect.gen(function* () {
        let removed = 0
        if (lease.containerID) {
          const before = yield* inspect(lease.containerID)
          if (before) {
            yield* remove(lease.containerID, lease)
            removed++
          }
          yield* dependencies.leases
            .remove(lease.leaseID)
            .pipe(Effect.mapError((cause) => failure("lease", "Failed to terminalize durable OCI lease", cause)))
          return { removed, terminal: 1, tombstone: 0, retired: 0 }
        }

        const alreadyDisabled = lease.startDisabled === true
        const discovered = yield* list(lease)
        for (const containerID of discovered) {
          yield* remove(containerID, lease)
          removed++
        }
        if (alreadyDisabled && discovered.length > 0)
          yield* dependencies.leases
            .resetNoStartAbsence(lease.leaseID)
            .pipe(Effect.mapError((cause) => failure("lease", "Failed to reset OCI absence evidence", cause)))

        // The first expired scan establishes the permanent no-start boundary.
        // It never counts as an absence observation: a pre-boundary create may
        // still become visible after the scan.
        yield* dependencies.leases
          .removeSubject(lease.leaseID)
          .pipe(Effect.mapError((cause) => failure("lease", "Failed to remove expired OCI subject", cause)))
        if (!alreadyDisabled || discovered.length > 0)
          return { removed, terminal: 0, tombstone: 1, retired: 0 }

        const evidence = yield* dependencies.leases
          .observeNoStartAbsence(lease.leaseID, nowMs)
          .pipe(Effect.mapError((cause) => failure("lease", "Failed to record OCI absence evidence", cause)))
        if (!evidence.eligible || retirementBudget <= 0)
          return { removed, terminal: 0, tombstone: 1, retired: 0 }

        // A final exact-label scan is mandatory after aged evidence becomes
        // eligible and immediately before the destructive retirement boundary.
        const finalDiscovered = yield* list(lease)
        if (finalDiscovered.length > 0) {
          for (const containerID of finalDiscovered) {
            yield* remove(containerID, lease)
            removed++
          }
          yield* dependencies.leases
            .resetNoStartAbsence(lease.leaseID)
            .pipe(Effect.mapError((cause) => failure("lease", "Failed to reset OCI absence evidence", cause)))
          return { removed, terminal: 0, tombstone: 1, retired: 0 }
        }
        yield* dependencies.leases
          .retireNoStart(lease.leaseID, nowMs)
          .pipe(Effect.mapError((cause) => failure("lease", "Failed to retire OCI no-start tombstone", cause)))
        retirementBudget--
        return { removed, terminal: 0, tombstone: 0, retired: 1 }
      }).pipe(Effect.exit)
      if (outcome._tag === "Failure") {
        failures.push(outcome.cause)
        continue
      }
      removedContainers += outcome.value.removed
      terminalLeases += outcome.value.terminal
      tombstones += outcome.value.tombstone
      retiredTombstones += outcome.value.retired
    }
    if (failures.length > 0)
      return yield* failure(
        "reap",
        `OCI reaper failed to reconcile ${failures.length} of ${expired} expired leases`,
        failures,
      )
    return Object.freeze({
      examined: leases.length,
      expired,
      deferredExpired: expired - batch.length,
      removedContainers,
      terminalLeases,
      tombstones,
      retiredTombstones,
    })
  })

  return Object.freeze({ leases: dependencies.leases, inspect, remove, reap })
}

/**
 * Reconcile the durable OCI ledger exactly once without installing the
 * in-process startup or periodic supervisor lifecycle.
 */
export const reapOnce = Effect.fn("VerifierOciSupervisor.reapOnce")(function* (nowMs?: number) {
  const runtime = yield* VerifierOciRuntime.Service
  if (!runtime.backend) return yield* failure("reap", "OCI runtime is unavailable")
  const global = yield* AppPaths.Service
  return yield* make({
    runtime: runtime.backend,
    leases: VerifierOciLease.make(global),
  }).reap(nowMs)
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runtime = yield* VerifierOciRuntime.Service
    const global = yield* AppPaths.Service
    const service = make({
      runtime: runtime.backend,
      leases: VerifierOciLease.make(global),
    })
    if (runtime.backend) {
      // An enabled executor must not become ready on top of an unreadable or
      // unreconciled durable ledger. Defecting the layer makes boot fail closed.
      yield* service.reap().pipe(Effect.orDie)
    } else {
      yield* service.reap().pipe(
        Effect.catch((cause) => Effect.logWarning("OCI verifier startup reconciliation failed", { cause })),
      )
    }
    yield* Effect.sleep(REAP_INTERVAL).pipe(
      Effect.andThen(service.reap()),
      Effect.catch((cause) => Effect.logWarning("OCI verifier periodic reconciliation failed", { cause })),
      Effect.forever,
      Effect.forkScoped,
    )
    return Service.of(service)
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(VerifierOciRuntime.defaultLayer),
  Layer.provide(AppPaths.defaultLayer),
)
