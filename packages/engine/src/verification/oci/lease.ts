export * as VerifierOciLease from "./lease"

import { constants as FsConstants, type BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import { AppPaths } from "../../runtime/paths"
import { AbsolutePath } from "../../shared/schema"
import { Snapshot } from "../../workspace/repository/snapshot"
import { withSnapshotRetentionBarrier } from "../../workspace/repository/retention-barrier"
import { VerifierRegistry } from "../registry"

const VERSION = 1 as const
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_INTENT_BYTES = 4 * 1024
const CONTAINER_ID_BYTES = 64
const NO_START_BOUNDARY = "no-start"
const PENDING_BOUNDARY_PATTERN = /^container-id\.pending-[a-f0-9]{16}$/
const MAX_PENDING_BOUNDARIES = 16
const ABSENCE_OBSERVATION_PATTERN = /^absence-([12])\.json$/
const MAX_ABSENCE_OBSERVATION_BYTES = 256
const LEASE_ID_PATTERN = /^[a-f0-9]{32}$/
const TRASH_DIRECTORY_PATTERN = /^[a-f0-9]{32}-[a-f0-9]{16}$/
const GENERATION_PATTERN = /^[a-f0-9]{32}$/
const STAGING_DIRECTORY_PATTERN =
  /^s-([a-f0-9]{32})-([0-9]{16})-([a-f0-9]{32})$/
const STAGING_TRASH_DIRECTORY_PATTERN =
  /^cancel-([a-f0-9]{32})-([0-9]{16})-([a-f0-9]{32})-([a-f0-9]{32})$/
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/
const EXECUTION_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const OWNER_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

/**
 * Fixed safety limits for crash-artifact and no-start retirement. They are
 * intentionally not environment-tunable: reducing the retention window must
 * require a reviewed code change, not an accidental deployment setting.
 */
export const RETIREMENT_POLICY = Object.freeze({
  expiredStagingPerRead: 32,
  expiredLeasesPerReap: 64,
  noStartRetirementsPerReap: 16,
  absenceObservationsRequired: 2,
  absenceObservationSpacingMs: 60_000,
  tombstoneMinimumAgeMs: 24 * 60 * 60 * 1_000,
})

const STRICT_OPTIONS = {
  errors: "all",
  onExcessProperty: "error",
} as const

export const LeaseID = Schema.String.check(
  Schema.isPattern(LEASE_ID_PATTERN),
).pipe(Schema.brand("VerifierOciLease.LeaseID"))

export type LeaseID = typeof LeaseID.Type

export const ContainerID = Schema.String.check(
  Schema.isPattern(CONTAINER_ID_PATTERN),
).pipe(Schema.brand("VerifierOciLease.ContainerID"))

export type ContainerID = typeof ContainerID.Type

const Owner = Schema.String.check(Schema.isPattern(OWNER_PATTERN))
const ExecutionHash = Schema.String.check(
  Schema.isPattern(EXECUTION_HASH_PATTERN),
)
const SnapshotID = Snapshot.ID.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
)
const ReapAfterMs = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0
      ? undefined
      : "reapAfterMs must be a non-negative safe integer",
  ),
)

export const Intent = Schema.Struct({
  version: Schema.Literal(VERSION),
  leaseID: LeaseID,
  owner: Owner,
  executionHash: ExecutionHash,
  snapshot: SnapshotID,
  image: VerifierRegistry.OciImage,
  reapAfterMs: ReapAfterMs,
}).annotate({ identifier: "VerifierOciLease.Intent" })

export type Intent = typeof Intent.Type

const AbsenceObservation = Schema.Struct({
  version: Schema.Literal(VERSION),
  leaseID: LeaseID,
  sequence: Schema.Literals([1, 2]),
  observedAtMs: ReapAfterMs,
})
type AbsenceObservation = typeof AbsenceObservation.Type

export interface RetirementEvidence {
  readonly observations: number
  readonly firstObservedAtMs?: number
  readonly lastObservedAtMs?: number
  readonly eligible: boolean
}

export type Lease = Readonly<
  Intent & {
    readonly subject: AbsolutePath
    readonly containerID?: ContainerID
    readonly startDisabled?: true
  }
>

export interface PrepareInput {
  readonly executionHash: string
  readonly snapshot: Snapshot.ID
  readonly image: VerifierRegistry.OciImage
  readonly reapAfterMs: number
}

export interface Options {
  readonly leaseID?: () => string
  readonly owner?: () => string
  readonly stagingGeneration?: () => string
  readonly now?: () => number
}

export const Operation = Schema.Literals([
  "prepare",
  "commit-container-id",
  "read",
  "remove-subject",
  "observe-no-start",
  "reset-no-start",
  "retire-no-start",
  "remove",
])
export type Operation = typeof Operation.Type

export class Error extends Schema.TaggedErrorClass<Error>()(
  "VerifierOciLease.Error",
  {
    operation: Operation,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface Interface {
  /**
   * Durably publishes an immutable intent and returns a derived subject path.
   * The subject does not exist yet; the materializer must create it exclusively.
   * Callers must first validate, localize, and pin the canonical tree in its
   * project snapshot store. Production code satisfies this precondition through
   * `Snapshot.retain` in `VerifierOciContainment`.
   */
  readonly prepare: (input: PrepareInput) => Effect.Effect<Lease, Error>
  /**
   * Durably publishes the immutable container ID. A caller must not issue any
   * start request until this effect succeeds.
   */
  readonly commitContainerID: (
    leaseID: string,
    containerID: string,
  ) => Effect.Effect<Lease, Error>
  /**
   * Reconciles recognized terminal trash, then strictly reads every durable
   * lease or fails closed on any unsafe entry.
   */
  readonly readAll: (nowMs?: number) => Effect.Effect<readonly Lease[], Error>
  /**
   * Removes only the derived materialization while retaining the durable
   * intent tombstone for late-create reconciliation.
   */
  readonly removeSubject: (leaseID: string) => Effect.Effect<void, Error>
  /** Record one durable exact-label absence observation for a fenced lease. */
  readonly observeNoStartAbsence: (
    leaseID: string,
    nowMs: number,
  ) => Effect.Effect<RetirementEvidence, Error>
  /** Reset absence history after any matching late container is discovered. */
  readonly resetNoStartAbsence: (leaseID: string) => Effect.Effect<void, Error>
  /**
   * Retire an aged no-start tombstone. The caller must perform a final trusted
   * exact-label runtime scan immediately before invoking this operation.
   */
  readonly retireNoStart: (
    leaseID: string,
    nowMs: number,
  ) => Effect.Effect<void, Error>
  /**
   * Idempotently removes only paths derived from a canonical lease ID. The
   * supervisor must prove the corresponding container absent before calling it.
   */
  readonly remove: (leaseID: string) => Effect.Effect<void, Error>
}

interface Roots {
  readonly state: string
  readonly temporary: string
  readonly leases: string
  readonly staging: string
  readonly stagingTrash: string
  readonly trash: string
  readonly subjects: string
}

const failure = (operation: Operation, message: string, cause?: unknown) =>
  new Error({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const attempt = <A>(
  operation: Operation,
  message: string,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : failure(operation, message, cause),
  })

const errorCode = (cause: unknown) =>
  cause && typeof cause === "object" && "code" in cause
    ? String(cause.code)
    : undefined

const mode = (value: number) => value & 0o777

const decodeLeaseID = (value: unknown): LeaseID =>
  Schema.decodeUnknownSync(LeaseID)(value, STRICT_OPTIONS)

const decodeContainerID = (value: unknown): ContainerID =>
  Schema.decodeUnknownSync(ContainerID)(value, STRICT_OPTIONS)

const freezeIntent = (intent: Intent): Intent =>
  Object.freeze({
    version: intent.version,
    leaseID: intent.leaseID,
    owner: intent.owner,
    executionHash: intent.executionHash,
    snapshot: intent.snapshot,
    image: Object.freeze({
      reference: intent.image.reference,
      platform: intent.image.platform,
    }),
    reapAfterMs: intent.reapAfterMs,
  })

const encodeIntent = (intent: Intent) =>
  JSON.stringify({
    version: intent.version,
    leaseID: intent.leaseID,
    owner: intent.owner,
    executionHash: intent.executionHash,
    snapshot: intent.snapshot,
    image: {
      reference: intent.image.reference,
      platform: intent.image.platform,
    },
    reapAfterMs: intent.reapAfterMs,
  })

const absenceObservationName = (sequence: 1 | 2) => `absence-${sequence}.json`

const encodeAbsenceObservation = (observation: AbsenceObservation) =>
  JSON.stringify({
    version: observation.version,
    leaseID: observation.leaseID,
    sequence: observation.sequence,
    observedAtMs: observation.observedAtMs,
  })

const makeLease = (
  roots: Roots,
  intent: Intent,
  containerID?: ContainerID,
  startDisabled = false,
): Lease =>
  Object.freeze({
    ...intent,
    image: intent.image,
    subject: AbsolutePath.make(path.join(roots.subjects, intent.leaseID)),
    ...(containerID === undefined ? {} : { containerID }),
    ...(startDisabled ? { startDisabled: true as const } : {}),
  })

const lstatOptional = async (target: string) => {
  try {
    return await fs.lstat(target)
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  }
}

const assertBaseDirectory = async (target: string) => {
  if (
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    path.normalize(target) !== target
  ) {
    throw new globalThis.Error(
      "Global lease root is not absolute and normalized",
    )
  }
  const info = await lstatOptional(target)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new globalThis.Error("Global lease root is not a real directory")
  }
}

const assertPrivateDirectory = async (target: string) => {
  const info = await lstatOptional(target)
  if (
    !info ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    mode(info.mode) !== DIRECTORY_MODE
  ) {
    throw new globalThis.Error("OCI lease directory is missing or insecure")
  }
}

const fsyncDirectory = async (target: string) => {
  const handle = await fs.open(
    target,
    FsConstants.O_RDONLY | FsConstants.O_DIRECTORY | FsConstants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (!info.isDirectory()) {
      throw new globalThis.Error("OCI lease directory changed during fsync")
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const ensurePrivateChild = async (parent: string, name: string) => {
  const target = path.join(parent, name)
  try {
    await fs.mkdir(target, { mode: DIRECTORY_MODE })
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause
  }
  await assertPrivateDirectory(target)
  // A concurrent creator may not have fsynced the parent yet. Every caller
  // that relies on the child must establish parent-entry durability itself.
  await fsyncDirectory(parent)
  return target
}

const ensureRoots = async (roots: Roots) => {
  await assertBaseDirectory(roots.state)
  await assertBaseDirectory(roots.temporary)

  const stateProduct = await ensurePrivateChild(roots.state, "verifier-oci")
  const stateVersion = await ensurePrivateChild(stateProduct, `v${VERSION}`)
  const leases = await ensurePrivateChild(stateVersion, "leases")
  const staging = await ensurePrivateChild(stateVersion, "staging")
  const stagingTrash = await ensurePrivateChild(stateVersion, "staging-trash")
  const trash = await ensurePrivateChild(stateVersion, "trash")
  const temporaryProduct = await ensurePrivateChild(
    roots.temporary,
    "verifier-oci",
  )
  const temporaryVersion = await ensurePrivateChild(
    temporaryProduct,
    `v${VERSION}`,
  )
  const subjects = await ensurePrivateChild(temporaryVersion, "subjects")

  if (
    leases !== roots.leases ||
    staging !== roots.staging ||
    stagingTrash !== roots.stagingTrash ||
    trash !== roots.trash ||
    subjects !== roots.subjects
  ) {
    throw new globalThis.Error("OCI lease roots did not resolve as expected")
  }
}

const writeExclusive = async (target: string, content: string) => {
  const handle = await fs.open(
    target,
    FsConstants.O_WRONLY |
      FsConstants.O_CREAT |
      FsConstants.O_EXCL |
      FsConstants.O_NOFOLLOW,
    FILE_MODE,
  )
  try {
    await handle.writeFile(content, "utf8")
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || mode(info.mode) !== FILE_MODE) {
      throw new globalThis.Error("OCI lease file was not created securely")
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsyncDirectory(path.dirname(target))
}

const readStrictFile = async (target: string, maximumBytes: number) => {
  const handle = await fs.open(
    target,
    FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      mode(info.mode) !== FILE_MODE ||
      info.size <= 0 ||
      info.size > maximumBytes
    ) {
      throw new globalThis.Error("OCI lease file is missing or insecure")
    }
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

const readStartBoundary = async (
  leaseDirectory: string,
  pendingNames: readonly string[],
) => {
  const target = path.join(leaseDirectory, "container-id")
  const handle = await fs.open(
    target,
    FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      mode(info.mode) !== FILE_MODE ||
      info.size <= 0 ||
      info.size > CONTAINER_ID_BYTES ||
      info.nlink < 1 ||
      info.nlink > 2
    )
      throw new globalThis.Error("OCI start boundary is missing or insecure")
    if (info.nlink === 2) {
      let matchingPending = 0
      for (const pendingName of pendingNames) {
        const pending = await fs.lstat(path.join(leaseDirectory, pendingName))
        if (pending.dev === info.dev && pending.ino === info.ino)
          matchingPending++
      }
      if (matchingPending !== 1)
        throw new globalThis.Error(
          "OCI start boundary has an unexplained hard link",
        )
    }
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

const decodeIntent = (raw: string, expectedLeaseID: LeaseID): Intent => {
  const parsed = JSON.parse(raw) as unknown
  const decoded = Schema.decodeUnknownSync(Intent)(parsed, STRICT_OPTIONS)
  const intent = freezeIntent(decoded)
  if (intent.leaseID !== expectedLeaseID || raw !== encodeIntent(intent)) {
    throw new globalThis.Error("OCI lease intent is not canonical")
  }
  return intent
}

const decodeAbsenceObservation = (
  raw: string,
  expectedLeaseID: LeaseID,
  expectedSequence: 1 | 2,
) => {
  const decoded = Schema.decodeUnknownSync(AbsenceObservation)(
    JSON.parse(raw) as unknown,
    STRICT_OPTIONS,
  )
  if (
    decoded.leaseID !== expectedLeaseID ||
    decoded.sequence !== expectedSequence ||
    raw !== encodeAbsenceObservation(decoded)
  ) {
    throw new globalThis.Error(
      "OCI no-start absence observation is not canonical",
    )
  }
  return decoded
}

const readAbsenceObservations = async (
  leaseDirectory: string,
  intent: Intent,
) => {
  const observations: AbsenceObservation[] = []
  for (const sequence of [1, 2] as const) {
    const target = path.join(leaseDirectory, absenceObservationName(sequence))
    const info = await lstatOptional(target)
    if (!info) {
      if (
        sequence === 1 &&
        (await lstatOptional(
          path.join(leaseDirectory, absenceObservationName(2)),
        ))
      ) {
        throw new globalThis.Error(
          "OCI no-start absence observation chain is incomplete",
        )
      }
      break
    }
    const observation = decodeAbsenceObservation(
      await readStrictFile(target, MAX_ABSENCE_OBSERVATION_BYTES),
      intent.leaseID,
      sequence,
    )
    if (
      observation.observedAtMs < intent.reapAfterMs ||
      (sequence === 2 &&
        observation.observedAtMs <
          observations[0]!.observedAtMs +
            RETIREMENT_POLICY.absenceObservationSpacingMs)
    ) {
      throw new globalThis.Error(
        "OCI no-start absence observation timing is invalid",
      )
    }
    observations.push(observation)
  }
  return observations
}

const retirementEvidence = (
  observations: readonly AbsenceObservation[],
  nowMs: number,
): RetirementEvidence => {
  const first = observations[0]?.observedAtMs
  const last = observations.at(-1)?.observedAtMs
  if (last !== undefined && last > nowMs)
    throw new globalThis.Error(
      "OCI no-start absence observation is in the future",
    )
  return Object.freeze({
    observations: observations.length,
    ...(first === undefined ? {} : { firstObservedAtMs: first }),
    ...(last === undefined ? {} : { lastObservedAtMs: last }),
    eligible:
      observations.length >= RETIREMENT_POLICY.absenceObservationsRequired &&
      first !== undefined &&
      nowMs >= first + RETIREMENT_POLICY.tombstoneMinimumAgeMs,
  })
}

const assertNoPendingStartBoundary = async (leaseDirectory: string) => {
  const names = await fs.readdir(leaseDirectory)
  if (names.some((name) => PENDING_BOUNDARY_PATTERN.test(name)))
    throw new globalThis.Error(
      "OCI no-start lease still contains a pending start request",
    )
}

const publishStartBoundary = async (
  leaseDirectory: string,
  content: ContainerID | typeof NO_START_BOUNDARY,
) => {
  const pendingPath = path.join(
    leaseDirectory,
    `container-id.pending-${randomBytes(8).toString("hex")}`,
  )
  const finalPath = path.join(leaseDirectory, "container-id")
  await writeExclusive(pendingPath, content)
  try {
    await fs.link(pendingPath, finalPath)
    await fsyncDirectory(leaseDirectory)
    await fs.unlink(pendingPath)
    await fsyncDirectory(leaseDirectory)
    if ((await readStrictFile(finalPath, CONTAINER_ID_BYTES)) !== content)
      throw new globalThis.Error(
        "Committed OCI start boundary did not round-trip",
      )
  } catch (cause) {
    try {
      await fs.unlink(pendingPath)
      await fsyncDirectory(leaseDirectory)
    } catch (cleanupCause) {
      if (errorCode(cleanupCause) !== "ENOENT") throw cleanupCause
    }
    throw cause
  }
}

const readLease = async (roots: Roots, leaseID: LeaseID) => {
  const leaseDirectory = path.join(roots.leases, leaseID)
  await assertPrivateDirectory(leaseDirectory)
  const entries = await fs.readdir(leaseDirectory, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  const pendingNames = names.filter((name) =>
    PENDING_BOUNDARY_PATTERN.test(name),
  )
  const absenceNames = names.filter((name) =>
    ABSENCE_OBSERVATION_PATTERN.test(name),
  )
  if (
    names.length < 1 ||
    pendingNames.length > MAX_PENDING_BOUNDARIES ||
    absenceNames.length > RETIREMENT_POLICY.absenceObservationsRequired ||
    !names.includes("intent.json") ||
    names.some(
      (name) =>
        name !== "intent.json" &&
        name !== "container-id" &&
        !ABSENCE_OBSERVATION_PATTERN.test(name) &&
        !PENDING_BOUNDARY_PATTERN.test(name),
    ) ||
    entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())
  ) {
    throw new globalThis.Error(
      "OCI lease directory contains unexpected entries",
    )
  }

  const intentRaw = await readStrictFile(
    path.join(leaseDirectory, "intent.json"),
    MAX_INTENT_BYTES,
  )
  const intent = decodeIntent(intentRaw, leaseID)
  const absenceObservations = await readAbsenceObservations(
    leaseDirectory,
    intent,
  )
  for (const pendingName of pendingNames) {
    const info = await fs.lstat(path.join(leaseDirectory, pendingName))
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      mode(info.mode) !== FILE_MODE ||
      info.size <= 0 ||
      info.size > CONTAINER_ID_BYTES ||
      info.nlink < 1 ||
      info.nlink > 2
    )
      throw new globalThis.Error("OCI pending start boundary is insecure")
  }
  if (!names.includes("container-id")) {
    if (absenceObservations.length > 0)
      throw new globalThis.Error(
        "OCI absence observations require a no-start boundary",
      )
    return makeLease(roots, intent)
  }
  const boundary = await readStartBoundary(leaseDirectory, pendingNames)
  if (boundary !== NO_START_BOUNDARY && absenceObservations.length > 0) {
    throw new globalThis.Error(
      "OCI absence observations are attached to a container lease",
    )
  }
  return boundary === NO_START_BOUNDARY
    ? makeLease(roots, intent, undefined, true)
    : makeLease(roots, intent, decodeContainerID(boundary))
}

const assertSubjectDirectory = async (roots: Roots, leaseID: LeaseID) => {
  const subject = path.join(roots.subjects, leaseID)
  await assertPrivateDirectory(subject)
  return subject
}

const removeDerivedDirectory = async (target: string) => {
  const info = await lstatOptional(target)
  if (!info) return
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    mode(info.mode) !== DIRECTORY_MODE
  ) {
    throw new globalThis.Error("Refusing to remove an insecure OCI lease path")
  }
  try {
    await fs.rm(target, { recursive: true })
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause
  }
}

const removeTerminalTrashDirectory = async (target: string) => {
  const directory = await lstatOptional(target)
  if (!directory) return
  const uid = process.getuid?.()
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    mode(directory.mode) !== DIRECTORY_MODE ||
    (uid !== undefined && directory.uid !== uid)
  ) {
    throw new globalThis.Error("Refusing to remove insecure OCI terminal trash")
  }

  const entries = await fs
    .readdir(target, { withFileTypes: true })
    .catch((cause) => {
      if (errorCode(cause) === "ENOENT") return undefined
      throw cause
    })
  if (!entries) return
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const boundary =
      entry.name === "container-id" || PENDING_BOUNDARY_PATTERN.test(entry.name)
    const absence = ABSENCE_OBSERVATION_PATTERN.test(entry.name)
    if (
      (entry.name !== "intent.json" && !boundary && !absence) ||
      entry.isSymbolicLink() ||
      !entry.isFile()
    ) {
      throw new globalThis.Error("OCI terminal trash contains an unsafe entry")
    }
    const info = await lstatOptional(path.join(target, entry.name))
    if (!info) continue
    const maximum = boundary
      ? CONTAINER_ID_BYTES
      : absence
        ? MAX_ABSENCE_OBSERVATION_BYTES
        : MAX_INTENT_BYTES
    const maximumLinks = boundary ? 2 : 1
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      mode(info.mode) !== FILE_MODE ||
      info.size <= 0 ||
      info.size > maximum ||
      info.nlink < 1 ||
      info.nlink > maximumLinks ||
      (uid !== undefined && info.uid !== uid)
    ) {
      throw new globalThis.Error(
        "OCI terminal trash file is missing or insecure",
      )
    }
  }

  // A committed lease contains files only. Unlink exact validated names and
  // then remove the empty directory; never recursively traverse trash.
  for (const entry of entries) {
    try {
      await fs.unlink(path.join(target, entry.name))
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause
    }
  }
  try {
    await fs.rmdir(target)
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause
  }
}

const stagingDeadline = (name: string) => {
  const match = STAGING_DIRECTORY_PATTERN.exec(name)
  if (!match) return undefined
  const value = Number(match[2])
  return Number.isSafeInteger(value) &&
    value >= 0 &&
    String(value).padStart(16, "0") === match[2]
    ? value
    : undefined
}

const canceledStagingSource = (name: string) => {
  const match = STAGING_TRASH_DIRECTORY_PATTERN.exec(name)
  if (!match) return undefined
  const source = `s-${match[1]}-${match[2]}-${match[3]}`
  return stagingDeadline(source) === undefined ? undefined : source
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

const privateDirectoryIdentityOptional = async (
  target: string,
): Promise<DirectoryIdentity | undefined> => {
  let info: BigIntStats
  try {
    info = await fs.lstat(target, { bigint: true })
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  }
  const uid = process.getuid?.()
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    Number(info.mode & 0o777n) !== DIRECTORY_MODE ||
    (uid !== undefined && info.uid !== BigInt(uid))
  ) {
    throw new globalThis.Error("OCI staging directory is missing or insecure")
  }
  return Object.freeze({ dev: info.dev, ino: info.ino })
}

const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity) =>
  left.dev === right.dev && left.ino === right.ino

const removeStagingTrashEnvelope = async (
  roots: Roots,
  target: string,
  retry = 0,
) => {
  if (!(await privateDirectoryIdentityOptional(target))) return
  const name = path.basename(target)
  const sourceName = canceledStagingSource(name)
  if (!sourceName || path.dirname(target) !== roots.stagingTrash) {
    throw new globalThis.Error("OCI staging trash name is invalid")
  }
  const source = path.join(roots.staging, sourceName)

  let envelopeEntries
  try {
    envelopeEntries = await fs.readdir(target, { withFileTypes: true })
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return
    throw cause
  }
  if (
    envelopeEntries.length > 1 ||
    envelopeEntries.some(
      (entry) =>
        entry.name !== "payload" ||
        entry.isSymbolicLink() ||
        !entry.isDirectory(),
    )
  ) {
    throw new globalThis.Error("OCI staging trash contains an unsafe entry")
  }

  if (envelopeEntries.length === 0) {
    // An empty envelope is published before its owner attempts the fencing
    // rename. Do not remove its destination parent while the exact source still
    // exists; a crashed envelope will become removable after the source is
    // published or canceled by this scan.
    if (await lstatOptional(source)) return
    try {
      await fs.rmdir(target)
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return
      if (errorCode(cause) === "ENOTEMPTY" && retry < 3) {
        return removeStagingTrashEnvelope(roots, target, retry + 1)
      }
      throw cause
    }
    return
  }

  const payload = path.join(target, "payload")
  if (!(await privateDirectoryIdentityOptional(payload))) return
  if (await lstatOptional(source)) {
    throw new globalThis.Error(
      "OCI staging source still exists beside canceled payload",
    )
  }
  // A cleaner may observe the payload before the canceling process fsyncs its
  // rename. Establish destination-then-source durability itself before
  // unlinking either side of the fence.
  try {
    await fsyncDirectory(target)
    await fsyncDirectory(roots.staging)
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return
    throw cause
  }
  let payloadEntries
  try {
    payloadEntries = await fs.readdir(payload, { withFileTypes: true })
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return
    throw cause
  }
  if (
    payloadEntries.length > 1 ||
    payloadEntries.some(
      (entry) =>
        entry.name !== "intent.json" ||
        entry.isSymbolicLink() ||
        !entry.isFile(),
    )
  ) {
    throw new globalThis.Error(
      "OCI staging trash payload contains an unsafe entry",
    )
  }
  if (payloadEntries.length === 1) {
    const targetFile = path.join(payload, "intent.json")
    const info = await lstatOptional(targetFile)
    const uid = process.getuid?.()
    if (info) {
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        mode(info.mode) !== FILE_MODE ||
        info.size > MAX_INTENT_BYTES ||
        info.nlink !== 1 ||
        (uid !== undefined && info.uid !== uid)
      ) {
        throw new globalThis.Error(
          "OCI staging trash file is missing or insecure",
        )
      }
      try {
        await fs.unlink(targetFile)
      } catch (cause) {
        if (errorCode(cause) !== "ENOENT") throw cause
      }
    }
  }
  try {
    await fs.rmdir(payload)
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause
  }
  try {
    await fs.rmdir(target)
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause
  }
}

const terminalizeStagingDirectory = async (
  roots: Roots,
  stagingName: string,
  expected?: DirectoryIdentity,
  retry = 0,
) => {
  const source = path.join(roots.staging, stagingName)
  const sourceIdentity = await privateDirectoryIdentityOptional(source)
  if (!sourceIdentity) return undefined
  if (expected && !sameDirectory(sourceIdentity, expected)) {
    throw new globalThis.Error("OCI staging generation changed before fence")
  }
  const match = STAGING_DIRECTORY_PATTERN.exec(stagingName)
  if (!match || stagingDeadline(stagingName) === undefined) {
    throw new globalThis.Error("OCI staging generation name is invalid")
  }
  const envelope = path.join(
    roots.stagingTrash,
    `cancel-${match[1]}-${match[2]}-${match[3]}-${randomBytes(16).toString("hex")}`,
  )
  await fs.mkdir(envelope, { mode: DIRECTORY_MODE })
  await privateDirectoryIdentityOptional(envelope)
  await fsyncDirectory(roots.stagingTrash)
  const payload = path.join(envelope, "payload")
  try {
    await fs.rename(source, payload)
  } catch (cause) {
    if (errorCode(cause) === "ENOENT" || errorCode(cause) === "EINVAL") {
      await removeStagingTrashEnvelope(roots, envelope)
      await fsyncDirectory(roots.stagingTrash)
      const remaining = await privateDirectoryIdentityOptional(source)
      if (remaining) {
        if (!sameDirectory(sourceIdentity, remaining)) {
          throw new globalThis.Error(
            "OCI staging generation changed after a failed fence",
          )
        }
        if (retry >= 3) {
          throw new globalThis.Error(
            "OCI staging generation could not be fenced",
          )
        }
        return terminalizeStagingDirectory(
          roots,
          stagingName,
          sourceIdentity,
          retry + 1,
        )
      }
      return undefined
    }
    throw cause
  }
  const payloadIdentity = await privateDirectoryIdentityOptional(payload)
  if (!payloadIdentity || !sameDirectory(sourceIdentity, payloadIdentity)) {
    throw new globalThis.Error("OCI staging generation changed during fence")
  }
  // The cross-directory rename is the generation fence. A writer that lost
  // this race cannot later publish a replacement generation through its old
  // pathname.
  await fsyncDirectory(envelope)
  await fsyncDirectory(roots.staging)
  return envelope
}

const reconcileStagingTrash = async (roots: Roots) => {
  const entries = await fs.readdir(roots.stagingTrash, {
    withFileTypes: true,
  })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const failures: unknown[] = []
  for (const entry of entries) {
    if (
      !canceledStagingSource(entry.name) ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      failures.push(
        new globalThis.Error("OCI staging trash contains an unsafe entry"),
      )
      continue
    }
    try {
      await removeStagingTrashEnvelope(
        roots,
        path.join(roots.stagingTrash, entry.name),
      )
    } catch (cause) {
      failures.push(cause)
    }
  }
  await fsyncDirectory(roots.stagingTrash)
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "OCI staging trash reconciliation was incomplete",
    )
  }
}

const reconcileExpiredStaging = async (roots: Roots, nowMs: number) => {
  const entries = await fs.readdir(roots.staging, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const failures: unknown[] = []
  let retired = 0
  for (const entry of entries) {
    const deadline = stagingDeadline(entry.name)
    let identity: DirectoryIdentity | undefined
    try {
      identity = await privateDirectoryIdentityOptional(
        path.join(roots.staging, entry.name),
      )
    } catch (cause) {
      failures.push(cause)
      continue
    }
    if (!identity) continue
    if (
      deadline === undefined ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      failures.push(
        new globalThis.Error("OCI staging contains an unsafe entry"),
      )
      continue
    }
    if (deadline > nowMs) continue
    if (retired >= RETIREMENT_POLICY.expiredStagingPerRead) continue
    retired++
    try {
      const terminal = await terminalizeStagingDirectory(
        roots,
        entry.name,
        identity,
      )
      if (terminal) await removeStagingTrashEnvelope(roots, terminal)
    } catch (cause) {
      failures.push(cause)
    }
  }
  // Persist every successful fence and cleanup before surfacing malformed
  // siblings. Safe entries therefore converge even during a fail-closed scan.
  await fsyncDirectory(roots.staging)
  await fsyncDirectory(roots.stagingTrash)
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "OCI staging reconciliation was incomplete",
    )
  }
}

const reconcileTerminalTrash = async (roots: Roots) => {
  const entries = await fs.readdir(roots.trash, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const failures: unknown[] = []
  for (const entry of entries) {
    if (
      !TRASH_DIRECTORY_PATTERN.test(entry.name) ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      failures.push(new globalThis.Error("OCI trash contains an unsafe entry"))
      continue
    }
    try {
      // Visibility in trash means the live lease was already atomically
      // terminalized. Concurrent removers may race here; ENOENT is success.
      await removeTerminalTrashDirectory(path.join(roots.trash, entry.name))
    } catch (cause) {
      failures.push(cause)
    }
  }
  // Make successful removals durable even when another malformed entry makes
  // this reconciliation fail closed after processing the complete scan.
  await fsyncDirectory(roots.trash)
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "OCI terminal trash reconciliation was incomplete",
    )
  }
}

const terminalizeLease = async (
  roots: Roots,
  leaseID: LeaseID,
  removeSubject = true,
) => {
  if (removeSubject) {
    await removeDerivedDirectory(path.join(roots.subjects, leaseID))
    await fsyncDirectory(roots.subjects)
  }
  const leaseDirectory = path.join(roots.leases, leaseID)
  const leaseInfo = await lstatOptional(leaseDirectory)
  if (!leaseInfo) {
    await fsyncDirectory(roots.leases)
    return
  }
  await assertPrivateDirectory(leaseDirectory)
  const trashDirectory = path.join(
    roots.trash,
    `${leaseID}-${randomBytes(8).toString("hex")}`,
  )
  try {
    await fs.rename(leaseDirectory, trashDirectory)
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      await fsyncDirectory(roots.leases)
      return
    }
    throw cause
  }
  await fsyncDirectory(roots.leases)
  await fsyncDirectory(roots.trash)
  await removeTerminalTrashDirectory(trashDirectory)
  await fsyncDirectory(roots.trash)
}

export const make = (
  global: Pick<AppPaths.Interface, "state" | "tmp">,
  options: Options = {},
): Interface => {
  const roots = Object.freeze({
    state: global.state,
    temporary: global.tmp,
    leases: path.join(global.state, "verifier-oci", `v${VERSION}`, "leases"),
    staging: path.join(global.state, "verifier-oci", `v${VERSION}`, "staging"),
    stagingTrash: path.join(
      global.state,
      "verifier-oci",
      `v${VERSION}`,
      "staging-trash",
    ),
    trash: path.join(global.state, "verifier-oci", `v${VERSION}`, "trash"),
    subjects: path.join(global.tmp, "verifier-oci", `v${VERSION}`, "subjects"),
  })
  const nextLeaseID = options.leaseID ?? (() => randomBytes(16).toString("hex"))
  const nextOwner = options.owner ?? randomUUID
  const nextStagingGeneration =
    options.stagingGeneration ?? (() => randomBytes(16).toString("hex"))
  const now = options.now ?? Date.now

  const prepare = Effect.fn("VerifierOciLease.prepare")((input: PrepareInput) =>
    withSnapshotRetentionBarrier(
      global.state,
      attempt("prepare", "Failed to prepare durable OCI lease", async () => {
        const leaseID = decodeLeaseID(nextLeaseID())
        const intent = freezeIntent(
          Schema.decodeUnknownSync(Intent)(
            {
              version: VERSION,
              leaseID,
              owner: nextOwner(),
              executionHash: input.executionHash,
              snapshot: input.snapshot,
              image: input.image,
              reapAfterMs: input.reapAfterMs,
            },
            STRICT_OPTIONS,
          ),
        )

        await ensureRoots(roots)
        const generation = nextStagingGeneration()
        if (!GENERATION_PATTERN.test(generation)) {
          throw new globalThis.Error("OCI staging generation is not canonical")
        }
        const deadline = String(intent.reapAfterMs).padStart(16, "0")
        const stagingName = `s-${leaseID}-${deadline}-${generation}`
        const stagingDirectory = path.join(roots.staging, stagingName)
        const leaseDirectory = path.join(roots.leases, leaseID)
        await fs.mkdir(stagingDirectory, { mode: DIRECTORY_MODE })
        let stagingIdentity: DirectoryIdentity | undefined
        try {
          stagingIdentity =
            await privateDirectoryIdentityOptional(stagingDirectory)
          if (!stagingIdentity) {
            throw new globalThis.Error("OCI staging generation disappeared")
          }
          await fsyncDirectory(roots.staging)
          const encodedIntent = encodeIntent(intent)
          await writeExclusive(
            path.join(stagingDirectory, "intent.json"),
            encodedIntent,
          )
          const beforePublish =
            await privateDirectoryIdentityOptional(stagingDirectory)
          if (
            !beforePublish ||
            !sameDirectory(stagingIdentity, beforePublish)
          ) {
            throw new globalThis.Error(
              "OCI staging generation changed before publish",
            )
          }
          const stagingEntries = await fs.readdir(stagingDirectory, {
            withFileTypes: true,
          })
          if (
            stagingEntries.length !== 1 ||
            stagingEntries[0]?.name !== "intent.json" ||
            stagingEntries[0].isSymbolicLink() ||
            !stagingEntries[0].isFile() ||
            (await readStrictFile(
              path.join(stagingDirectory, "intent.json"),
              MAX_INTENT_BYTES,
            )) !== encodedIntent
          ) {
            throw new globalThis.Error(
              "OCI staging intent changed before publish",
            )
          }
          await fs.rename(stagingDirectory, leaseDirectory)
          const publishedIdentity =
            await privateDirectoryIdentityOptional(leaseDirectory)
          if (
            !publishedIdentity ||
            !sameDirectory(stagingIdentity, publishedIdentity)
          ) {
            throw new globalThis.Error(
              "OCI staging generation changed during publish",
            )
          }
          await fsyncDirectory(roots.leases)
          await fsyncDirectory(roots.staging)
        } catch (cause) {
          const terminal = await terminalizeStagingDirectory(
            roots,
            stagingName,
            stagingIdentity,
          )
          if (terminal) {
            await removeStagingTrashEnvelope(roots, terminal)
            await fsyncDirectory(roots.stagingTrash)
          }
          throw cause
        }
        await assertPrivateDirectory(leaseDirectory)
        return makeLease(roots, intent)
      }).pipe(Effect.uninterruptible),
    ),
  )

  const commitContainerID = Effect.fn("VerifierOciLease.commitContainerID")(
    (leaseIDInput: string, containerIDInput: string) =>
      attempt(
        "commit-container-id",
        "Failed to commit durable OCI container ID",
        async () => {
          const leaseID = decodeLeaseID(leaseIDInput)
          const containerID = decodeContainerID(containerIDInput)
          await ensureRoots(roots)
          const lease = await readLease(roots, leaseID)
          if (lease.startDisabled)
            throw new globalThis.Error(
              "OCI lease start boundary has been permanently disabled",
            )
          await assertSubjectDirectory(roots, leaseID)
          await publishStartBoundary(
            path.join(roots.leases, leaseID),
            containerID,
          )
          return Object.freeze({ ...lease, containerID })
        },
      ).pipe(Effect.uninterruptible),
  )

  const readAll = Effect.fn("VerifierOciLease.readAll")((nowInput?: number) =>
    attempt("read", "Failed to read durable OCI leases", async () => {
      await ensureRoots(roots)
      const nowMs = nowInput ?? now()
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new globalThis.Error("OCI staging reconciliation time is invalid")
      }
      await reconcileTerminalTrash(roots)
      await reconcileStagingTrash(roots)
      await reconcileExpiredStaging(roots, nowMs)
      await reconcileStagingTrash(roots)
      const stateEntries = await fs.readdir(roots.leases, {
        withFileTypes: true,
      })
      stateEntries.sort((left, right) => left.name.localeCompare(right.name))
      const stateIDs = new Set<string>()
      const leases: Lease[] = []
      for (const entry of stateEntries) {
        if (
          !LEASE_ID_PATTERN.test(entry.name) ||
          entry.isSymbolicLink() ||
          !entry.isDirectory()
        ) {
          throw new globalThis.Error("OCI lease list contains an unsafe entry")
        }
        const leaseID = decodeLeaseID(entry.name)
        stateIDs.add(leaseID)
        leases.push(await readLease(roots, leaseID))
      }

      const subjectEntries = await fs.readdir(roots.subjects, {
        withFileTypes: true,
      })
      for (const entry of subjectEntries) {
        if (
          !LEASE_ID_PATTERN.test(entry.name) ||
          entry.isSymbolicLink() ||
          !entry.isDirectory() ||
          !stateIDs.has(entry.name)
        ) {
          throw new globalThis.Error(
            "OCI subject list contains an orphan or unsafe entry",
          )
        }
        await assertPrivateDirectory(path.join(roots.subjects, entry.name))
      }
      return Object.freeze(leases)
    }),
  )

  const removeSubject = Effect.fn("VerifierOciLease.removeSubject")(
    (leaseIDInput: string) =>
      attempt(
        "remove-subject",
        "Failed to remove durable OCI lease subject",
        async () => {
          const leaseID = decodeLeaseID(leaseIDInput)
          await ensureRoots(roots)
          let lease = await readLease(roots, leaseID)
          if (lease.containerID)
            throw new globalThis.Error(
              "Refusing to remove a subject after container identity commit",
            )
          if (!lease.startDisabled) {
            try {
              await publishStartBoundary(
                path.join(roots.leases, leaseID),
                NO_START_BOUNDARY,
              )
            } catch (cause) {
              lease = await readLease(roots, leaseID)
              if (!lease.startDisabled) throw cause
            }
          }
          await removeDerivedDirectory(path.join(roots.subjects, leaseID))
          await fsyncDirectory(roots.subjects)
        },
      ).pipe(Effect.uninterruptible),
  )

  const observeNoStartAbsence = Effect.fn(
    "VerifierOciLease.observeNoStartAbsence",
  )((leaseIDInput: string, nowMs: number) =>
    attempt(
      "observe-no-start",
      "Failed to record OCI no-start absence observation",
      async () => {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0)
          throw new globalThis.Error("OCI no-start observation time is invalid")
        const leaseID = decodeLeaseID(leaseIDInput)
        await ensureRoots(roots)
        const lease = await readLease(roots, leaseID)
        if (!lease.startDisabled || lease.containerID)
          throw new globalThis.Error(
            "OCI absence can only be observed for a no-start lease",
          )
        if (nowMs < lease.reapAfterMs)
          throw new globalThis.Error(
            "OCI no-start lease has not reached its hard deadline",
          )
        const leaseDirectory = path.join(roots.leases, leaseID)
        await assertNoPendingStartBoundary(leaseDirectory)
        if (await lstatOptional(path.join(roots.subjects, leaseID)))
          throw new globalThis.Error(
            "OCI no-start subject is still materialized",
          )

        let observations = await readAbsenceObservations(leaseDirectory, lease)
        const last = observations.at(-1)?.observedAtMs
        if (last !== undefined && nowMs < last)
          throw new globalThis.Error(
            "OCI no-start observation time moved backwards",
          )
        if (
          observations.length < RETIREMENT_POLICY.absenceObservationsRequired &&
          (last === undefined ||
            nowMs >= last + RETIREMENT_POLICY.absenceObservationSpacingMs)
        ) {
          const sequence = (observations.length + 1) as 1 | 2
          const observation = Schema.decodeUnknownSync(AbsenceObservation)(
            {
              version: VERSION,
              leaseID,
              sequence,
              observedAtMs: nowMs,
            },
            STRICT_OPTIONS,
          )
          try {
            await writeExclusive(
              path.join(leaseDirectory, absenceObservationName(sequence)),
              encodeAbsenceObservation(observation),
            )
          } catch (cause) {
            // Concurrent observers converge on the single fixed sequence slot.
            if (errorCode(cause) !== "EEXIST") throw cause
          }
          const confirmed = await readLease(roots, leaseID)
          if (!confirmed.startDisabled || confirmed.containerID)
            throw new globalThis.Error(
              "OCI no-start boundary changed during observation",
            )
          observations = await readAbsenceObservations(
            leaseDirectory,
            confirmed,
          )
        }
        return retirementEvidence(observations, nowMs)
      },
    ).pipe(Effect.uninterruptible),
  )

  const resetNoStartAbsence = Effect.fn("VerifierOciLease.resetNoStartAbsence")(
    (leaseIDInput: string) =>
      attempt(
        "reset-no-start",
        "Failed to reset OCI no-start absence observations",
        async () => {
          const leaseID = decodeLeaseID(leaseIDInput)
          await ensureRoots(roots)
          const lease = await readLease(roots, leaseID)
          if (!lease.startDisabled || lease.containerID)
            throw new globalThis.Error(
              "OCI absence history belongs only to a no-start lease",
            )
          const leaseDirectory = path.join(roots.leases, leaseID)
          // Delete newest-first so an interrupted reset cannot leave a valid
          // two-observation chain that predates the late-container sighting.
          for (const sequence of [2, 1] as const) {
            try {
              await fs.unlink(
                path.join(leaseDirectory, absenceObservationName(sequence)),
              )
            } catch (cause) {
              if (errorCode(cause) !== "ENOENT") throw cause
            }
          }
          await fsyncDirectory(leaseDirectory)
        },
      ).pipe(Effect.uninterruptible),
  )

  const retireNoStart = Effect.fn("VerifierOciLease.retireNoStart")(
    (leaseIDInput: string, nowMs: number) =>
      attempt(
        "retire-no-start",
        "Failed to retire OCI no-start tombstone",
        async () => {
          if (!Number.isSafeInteger(nowMs) || nowMs < 0)
            throw new globalThis.Error(
              "OCI no-start retirement time is invalid",
            )
          const leaseID = decodeLeaseID(leaseIDInput)
          await ensureRoots(roots)
          const lease = await readLease(roots, leaseID)
          if (!lease.startDisabled || lease.containerID)
            throw new globalThis.Error(
              "Only a no-start tombstone may be retired",
            )
          const leaseDirectory = path.join(roots.leases, leaseID)
          await assertNoPendingStartBoundary(leaseDirectory)
          if (await lstatOptional(path.join(roots.subjects, leaseID)))
            throw new globalThis.Error(
              "Refusing to retire a materialized no-start subject",
            )
          const evidence = retirementEvidence(
            await readAbsenceObservations(leaseDirectory, lease),
            nowMs,
          )
          if (!evidence.eligible)
            throw new globalThis.Error(
              "OCI no-start tombstone has insufficient aged absence evidence",
            )
          // Do not recursively remove the subject here: absence is a required
          // precondition, not cleanup delegated to this destructive boundary.
          await terminalizeLease(roots, leaseID, false)
        },
      ).pipe(Effect.uninterruptible),
  )

  const remove = Effect.fn("VerifierOciLease.remove")((leaseIDInput: string) =>
    attempt("remove", "Failed to remove durable OCI lease", async () => {
      const leaseID = decodeLeaseID(leaseIDInput)
      await ensureRoots(roots)
      await terminalizeLease(roots, leaseID)
    }).pipe(Effect.uninterruptible),
  )

  return Object.freeze({
    prepare,
    commitContainerID,
    readAll,
    removeSubject,
    observeNoStartAbsence,
    resetNoStartAbsence,
    retireNoStart,
    remove,
  })
}
