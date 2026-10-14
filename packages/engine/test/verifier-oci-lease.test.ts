import { describe, expect } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppPaths } from "../src/runtime/paths"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { VerifierOciLease } from "../src/verification/oci/lease"
import { VerifierRegistry } from "../src/verification/registry"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const LEASE_ID = VerifierOciLease.LeaseID.make("1".repeat(32))
const SECOND_LEASE_ID = VerifierOciLease.LeaseID.make("0".repeat(32))
const OWNER = "00000000-0000-4000-8000-000000000001"
const CONTAINER_ID = VerifierOciLease.ContainerID.make("d".repeat(64))
const DIGEST = `sha256:${"a".repeat(64)}`
const REFERENCE = `registry.example/phins/verifier@${DIGEST}`
const EXECUTION_HASH = `sha256:${"b".repeat(64)}`
const SNAPSHOT = Snapshot.ID.make("c".repeat(40))
const REAP_AFTER_MS = 1_800_000_000_000
const IMAGE = VerifierRegistry.OciImage.make({
  reference: REFERENCE,
  platform: "linux/amd64",
})

const input = {
  executionHash: EXECUTION_HASH,
  snapshot: SNAPSHOT,
  image: IMAGE,
  reapAfterMs: REAP_AFTER_MS,
}

interface Fixture {
  readonly root: Awaited<ReturnType<typeof tmpdir>>
  readonly state: string
  readonly temporary: string
  readonly global: AppPaths.Interface
}

const fixture = async (): Promise<Fixture> => {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  const temporary = path.join(root.path, "tmp")
  await Promise.all([
    fs.mkdir(state, { mode: 0o755 }),
    fs.mkdir(temporary, { mode: 0o755 }),
  ])
  return {
    root,
    state,
    temporary,
    global: AppPaths.resolvePaths({ state, tmp: temporary }),
  }
}

const withFixture = <A, E>(use: (value: Fixture) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(Effect.promise(fixture), use, (value) =>
    Effect.promise(() => value.root[Symbol.asyncDispose]()),
  )

const storeFor = (value: Fixture, leaseID: () => string = () => LEASE_ID) =>
  VerifierOciLease.make(value.global, {
    leaseID,
    owner: () => OWNER,
  })

const leaseDirectory = (value: Fixture, leaseID = LEASE_ID) =>
  path.join(value.state, "verifier-oci", "v1", "leases", leaseID)

const subjectRoot = (value: Fixture) =>
  path.join(value.temporary, "verifier-oci", "v1", "subjects")

const stateVersionRoot = (value: Fixture) =>
  path.join(value.state, "verifier-oci", "v1")

const stagingRoot = (value: Fixture) =>
  path.join(stateVersionRoot(value), "staging")

const stagingTrashRoot = (value: Fixture) =>
  path.join(stateVersionRoot(value), "staging-trash")

const stagingName = (
  leaseID: string,
  reapAfterMs: number,
  generation: string,
) =>
  `s-${leaseID}-${String(reapAfterMs).padStart(16, "0")}-${generation}`

const cancellationName = (
  leaseID: string,
  reapAfterMs: number,
  generation: string,
  cancellation: string,
) =>
  `cancel-${leaseID}-${String(reapAfterMs).padStart(16, "0")}-${generation}-${cancellation}`

const permissions = async (target: string) =>
  (await fs.lstat(target)).mode & 0o777

const exists = async (target: string) => {
  try {
    await fs.lstat(target)
    return true
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return false
    }
    throw cause
  }
}

describe("VerifierOciLease", () => {
  it.effect("prepares one canonical durable intent and derived subject", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        const directory = leaseDirectory(value)
        const intentPath = path.join(directory, "intent.json")
        const expected = JSON.stringify({
          version: 1,
          leaseID: LEASE_ID,
          owner: OWNER,
          executionHash: EXECUTION_HASH,
          snapshot: SNAPSHOT,
          image: {
            reference: REFERENCE,
            platform: "linux/amd64",
          },
          reapAfterMs: REAP_AFTER_MS,
        })

        expect(lease).toEqual({
          ...JSON.parse(expected),
          subject: path.join(subjectRoot(value), LEASE_ID),
        })
        expect(Object.isFrozen(lease)).toBe(true)
        expect(Object.isFrozen(lease.image)).toBe(true)
        expect(
          yield* Effect.promise(() => fs.readFile(intentPath, "utf8")),
        ).toBe(expected)
        expect(yield* Effect.promise(() => permissions(directory))).toBe(0o700)
        expect(yield* Effect.promise(() => permissions(intentPath))).toBe(0o600)
        expect(yield* Effect.promise(() => exists(lease.subject))).toBe(false)
        expect(yield* store.readAll()).toEqual([lease])
      }),
    ),
  )

  it.effect("survives concurrent EEXIST initialization on fresh roots", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const firstStore = storeFor(value, () => LEASE_ID)
        const secondStore = storeFor(value, () => SECOND_LEASE_ID)
        const [first, second] = yield* Effect.all(
          [
            firstStore.prepare(input),
            secondStore.prepare({
              ...input,
              snapshot: Snapshot.ID.make("e".repeat(40)),
            }),
          ],
          { concurrency: "unbounded" },
        )
        const expected = [second, first]

        expect(yield* firstStore.readAll()).toEqual(expected)
        expect(yield* secondStore.readAll()).toEqual(expected)
      }),
    ),
  )

  it.effect("commits a full container ID exactly once", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))
        const committed = yield* store.commitContainerID(
          lease.leaseID,
          CONTAINER_ID,
        )
        const containerIDPath = path.join(leaseDirectory(value), "container-id")

        expect(committed.containerID).toBe(CONTAINER_ID)
        expect(
          yield* Effect.promise(() => fs.readFile(containerIDPath, "utf8")),
        ).toBe(CONTAINER_ID)
        expect(yield* Effect.promise(() => permissions(containerIDPath))).toBe(
          0o600,
        )
        expect(yield* store.readAll()).toEqual([committed])

        const lateReaper = yield* Effect.flip(
          store.removeSubject(lease.leaseID),
        )
        expect(lateReaper.operation).toBe("remove-subject")
        expect(yield* Effect.promise(() => exists(lease.subject))).toBe(true)

        const duplicate = yield* Effect.flip(
          store.commitContainerID(lease.leaseID, "e".repeat(64)),
        )
        expect(duplicate).toBeInstanceOf(VerifierOciLease.Error)
        expect(duplicate.operation).toBe("commit-container-id")
        expect(
          yield* Effect.promise(() => fs.readFile(containerIDPath, "utf8")),
        ).toBe(CONTAINER_ID)
      }),
    ),
  )

  it.effect("atomically disables start before reaping a no-ID subject", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))

        yield* store.removeSubject(lease.leaseID)
        yield* store.removeSubject(lease.leaseID)

        expect(yield* Effect.promise(() => exists(lease.subject))).toBe(false)
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(leaseDirectory(value), "container-id"), "utf8"),
          ),
        ).toBe("no-start")
        const [disabled] = yield* store.readAll()
        expect(disabled?.startDisabled).toBe(true)
        expect(disabled?.containerID).toBeUndefined()

        const lateCommit = yield* Effect.flip(
          store.commitContainerID(lease.leaseID, CONTAINER_ID),
        )
        expect(lateCommit.operation).toBe("commit-container-id")
      }),
    ),
  )

  it.effect("retires a no-start tombstone only after aged repeated absence evidence", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))
        yield* store.removeSubject(lease.leaseID)

        const first = yield* store.observeNoStartAbsence(
          lease.leaseID,
          REAP_AFTER_MS,
        )
        expect(first).toEqual({
          observations: 1,
          firstObservedAtMs: REAP_AFTER_MS,
          lastObservedAtMs: REAP_AFTER_MS,
          eligible: false,
        })
        expect(
          (yield* store.observeNoStartAbsence(
            lease.leaseID,
            REAP_AFTER_MS +
              VerifierOciLease.RETIREMENT_POLICY
                .absenceObservationSpacingMs -
              1,
          )).observations,
        ).toBe(1)
        const secondAt =
          REAP_AFTER_MS +
          VerifierOciLease.RETIREMENT_POLICY.absenceObservationSpacingMs
        const second = yield* store.observeNoStartAbsence(
          lease.leaseID,
          secondAt,
        )
        expect(second.observations).toBe(2)
        expect(second.eligible).toBe(false)

        const early = yield* Effect.flip(
          store.retireNoStart(lease.leaseID, secondAt),
        )
        expect(early.operation).toBe("retire-no-start")
        expect(yield* Effect.promise(() => exists(leaseDirectory(value)))).toBe(
          true,
        )

        const matureAt =
          REAP_AFTER_MS +
          VerifierOciLease.RETIREMENT_POLICY.tombstoneMinimumAgeMs
        expect(
          (yield* store.observeNoStartAbsence(lease.leaseID, matureAt))
            .eligible,
        ).toBe(true)
        yield* store.retireNoStart(lease.leaseID, matureAt)

        expect(yield* Effect.promise(() => exists(leaseDirectory(value)))).toBe(
          false,
        )
        expect(yield* store.readAll(matureAt)).toEqual([])
      }),
    ),
  )

  it.effect("refuses no-start evidence while a subject or start request remains", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))
        yield* store.removeSubject(lease.leaseID)

        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))
        expect(
          (yield* Effect.flip(
            store.observeNoStartAbsence(lease.leaseID, REAP_AFTER_MS),
          )).operation,
        ).toBe("observe-no-start")
        yield* Effect.promise(() => fs.rmdir(lease.subject))

        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(
              leaseDirectory(value),
              "container-id.pending-1111111111111111",
            ),
            CONTAINER_ID,
            { mode: 0o600, flag: "wx" },
          ),
        )
        expect(
          (yield* Effect.flip(
            store.observeNoStartAbsence(lease.leaseID, REAP_AFTER_MS),
          )).operation,
        ).toBe("observe-no-start")
      }),
    ),
  )

  it.effect("rejects invalid IDs before committing filesystem state", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const invalidOwner = VerifierOciLease.make(value.global, {
          leaseID: () => LEASE_ID,
          owner: () => "not-a-uuid",
        })
        const invalidLease = yield* Effect.flip(invalidOwner.prepare(input))
        expect(invalidLease.operation).toBe("prepare")
        expect(yield* Effect.promise(() => exists(leaseDirectory(value)))).toBe(
          false,
        )

        const store = storeFor(value)
        const invalidSnapshot = yield* Effect.flip(
          store.prepare({
            ...input,
            snapshot: Snapshot.ID.make("non-canonical-snapshot"),
          }),
        )
        expect(invalidSnapshot.operation).toBe("prepare")
        expect(yield* Effect.promise(() => exists(leaseDirectory(value)))).toBe(
          false,
        )

        const lease = yield* store.prepare(input)
        const invalidContainer = yield* Effect.flip(
          store.commitContainerID(lease.leaseID, "d".repeat(63)),
        )
        expect(invalidContainer.operation).toBe("commit-container-id")
        expect(
          yield* Effect.promise(() =>
            exists(path.join(leaseDirectory(value), "container-id")),
          ),
        ).toBe(false)

        const missingSubject = yield* Effect.flip(
          store.commitContainerID(lease.leaseID, CONTAINER_ID),
        )
        expect(missingSubject.operation).toBe("commit-container-id")
        expect(
          yield* Effect.promise(() =>
            exists(path.join(leaseDirectory(value), "container-id")),
          ),
        ).toBe(false)

        const traversal = yield* Effect.flip(store.remove("../outside"))
        expect(traversal.operation).toBe("remove")
      }),
    ),
  )

  it.effect("preserves the first lease when exclusive prepare collides", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const first = yield* store.prepare(input)
        const original = yield* Effect.promise(() =>
          fs.readFile(path.join(leaseDirectory(value), "intent.json"), "utf8"),
        )
        const collision = yield* Effect.flip(store.prepare(input))

        expect(collision.operation).toBe("prepare")
        expect(
          yield* Effect.promise(() =>
            fs.readFile(
              path.join(leaseDirectory(value), "intent.json"),
              "utf8",
            ),
          ),
        ).toBe(original)
        expect(yield* store.readAll()).toEqual([first])
      }),
    ),
  )

  it.effect("strictly rejects non-canonical and torn lease files", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        const intentPath = path.join(leaseDirectory(value), "intent.json")
        const original = yield* Effect.promise(() =>
          fs.readFile(intentPath, "utf8"),
        )
        const decoded = JSON.parse(original) as Record<string, unknown>
        yield* Effect.promise(() =>
          fs.writeFile(
            intentPath,
            JSON.stringify({ owner: decoded.owner, ...decoded }),
          ),
        )
        const nonCanonical = yield* Effect.flip(store.readAll())
        expect(nonCanonical.operation).toBe("read")

        yield* Effect.promise(() => fs.writeFile(intentPath, original))
        yield* Effect.promise(() => fs.mkdir(lease.subject, { mode: 0o700 }))
        yield* store.commitContainerID(lease.leaseID, CONTAINER_ID)
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(leaseDirectory(value), "container-id"),
            "d".repeat(63),
          ),
        )
        const torn = yield* Effect.flip(store.readAll())
        expect(torn.operation).toBe("read")
      }),
    ),
  )

  it.effect("recovers recognized crash artifacts without wedging published leases", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const lease = yield* store.prepare(input)
        const directory = leaseDirectory(value)
        const versionRoot = stateVersionRoot(value)
        const pendingOnly = path.join(
          directory,
          "container-id.pending-1111111111111111",
        )
        const pendingLinked = path.join(
          directory,
          "container-id.pending-2222222222222222",
        )
        const committed = path.join(directory, "container-id")

        // A crash before publishing the staged intent cannot affect the live
        // lease namespace.
        const futureStage = path.join(
          versionRoot,
          "staging",
          stagingName("f".repeat(32), REAP_AFTER_MS, "6".repeat(32)),
        )
        yield* Effect.promise(() => fs.mkdir(futureStage, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(futureStage, "intent.json"),
            "torn",
            { mode: 0o600 },
          ),
        )
        const terminalTrash = path.join(
          versionRoot,
          "trash",
          `${"e".repeat(32)}-${"4".repeat(16)}`,
        )
        yield* Effect.promise(() =>
          fs.mkdir(terminalTrash, { mode: 0o700 }),
        )
        expect(yield* store.readAll()).toEqual([lease])
        expect(yield* Effect.promise(() => exists(terminalTrash))).toBe(false)

        // A pending-only ID was never durably committed. Readers leave the
        // generation untouched and preserve the no-ID invariant, allowing a
        // concurrent writer to finish without destructive recovery races.
        yield* Effect.promise(() =>
          fs.writeFile(pendingOnly, "d".repeat(12), {
            mode: 0o600,
            flag: "wx",
          }),
        )
        expect(yield* store.readAll()).toEqual([lease])
        expect(yield* Effect.promise(() => exists(pendingOnly))).toBe(true)

        // A crash after the atomic hard link leaves two names for one fsynced
        // inode. Readers accept that recognized state without unlinking a live
        // or crashed writer's generation.
        yield* Effect.promise(() =>
          fs.writeFile(pendingLinked, CONTAINER_ID, {
            mode: 0o600,
            flag: "wx",
          }),
        )
        yield* Effect.promise(() => fs.link(pendingLinked, committed))
        const [recovered] = yield* store.readAll()
        expect(recovered?.containerID).toBe(CONTAINER_ID)
        expect(yield* Effect.promise(() => exists(pendingLinked))).toBe(true)
        expect((yield* Effect.promise(() => fs.lstat(committed))).nlink).toBe(2)
      }),
    ),
  )

  it.effect("generation-fences expired staging before allowing a new prepare", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const deadline = 1_000
        const expiredName = stagingName(
          LEASE_ID,
          deadline,
          "1".repeat(32),
        )
        const expired = path.join(stagingRoot(value), expiredName)
        const store = VerifierOciLease.make(value.global, {
          leaseID: () => LEASE_ID,
          owner: () => OWNER,
          stagingGeneration: () => "2".repeat(32),
        })
        yield* store.readAll(deadline - 1)
        yield* Effect.promise(() => fs.mkdir(expired, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(expired, "intent.json"), "", {
            mode: 0o600,
          }),
        )

        expect(yield* store.readAll(deadline - 1)).toEqual([])
        expect(yield* Effect.promise(() => exists(expired))).toBe(true)
        expect(yield* store.readAll(deadline)).toEqual([])
        expect(yield* Effect.promise(() => exists(expired))).toBe(false)
        expect(
          yield* Effect.promise(() => fs.readdir(stagingTrashRoot(value))),
        ).toEqual([])

        const stalePublishCode = yield* Effect.promise(async () => {
          try {
            await fs.rename(expired, leaseDirectory(value))
            return undefined
          } catch (cause) {
            return cause && typeof cause === "object" && "code" in cause
              ? String(cause.code)
              : "unknown"
          }
        })
        expect(stalePublishCode).toBe("ENOENT")

        const lease = yield* store.prepare(input)
        expect(lease.leaseID).toBe(LEASE_ID)
        expect(yield* store.readAll()).toEqual([lease])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingRoot(value))),
        ).toEqual([])
      }),
    ),
  )

  it.effect("bounds expired staging retirement work per read", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const deadline = 4_000
        yield* store.readAll(deadline - 1)
        const total =
          VerifierOciLease.RETIREMENT_POLICY.expiredStagingPerRead + 1
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: total }, (_, index) =>
              fs.mkdir(
                path.join(
                  stagingRoot(value),
                  stagingName(
                    index.toString(16).padStart(32, "0"),
                    deadline,
                    (index + total).toString(16).padStart(32, "0"),
                  ),
                ),
                { mode: 0o700 },
              ),
            ),
          ),
        )

        expect(yield* store.readAll(deadline)).toEqual([])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingRoot(value))),
        ).toHaveLength(1)
        expect(yield* store.readAll(deadline)).toEqual([])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingRoot(value))),
        ).toEqual([])
      }),
    ),
  )

  it.effect("concurrently converges expired staging cancellation", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const stores = Array.from({ length: 32 }, () => storeFor(value))
        const deadline = 2_000
        yield* stores[0]!.readAll(deadline - 1)
        const expired = path.join(
          stagingRoot(value),
          stagingName(LEASE_ID, deadline, "3".repeat(32)),
        )
        yield* Effect.promise(() => fs.mkdir(expired, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(expired, "intent.json"), "partial", {
            mode: 0o600,
          }),
        )

        const results = yield* Effect.all(
          stores.map((store) => store.readAll(deadline)),
          { concurrency: "unbounded" },
        )

        expect(results).toEqual(stores.map(() => []))
        expect(
          yield* Effect.promise(() => fs.readdir(stagingRoot(value))),
        ).toEqual([])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingTrashRoot(value))),
        ).toEqual([])
      }),
    ),
  )

  it.effect("recovers exact staging-trash crash envelopes", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.readAll(0)
        const root = stagingTrashRoot(value)
        const names = ["4", "5", "6", "7"].map((digit) =>
          cancellationName(
            LEASE_ID,
            1_000,
            digit.repeat(32),
            "8".repeat(32),
          ),
        )
        const envelopes = names.map((name) => path.join(root, name))
        yield* Effect.promise(() =>
          Promise.all(
            envelopes.map((envelope) =>
              fs.mkdir(envelope, { mode: 0o700 }),
            ),
          ),
        )
        for (const envelope of envelopes.slice(1)) {
          yield* Effect.promise(() =>
            fs.mkdir(path.join(envelope, "payload"), { mode: 0o700 }),
          )
        }
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(envelopes[2]!, "payload", "intent.json"),
            "",
            { mode: 0o600 },
          ),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(envelopes[3]!, "payload", "intent.json"),
            "partial",
            { mode: 0o600 },
          ),
        )

        expect(yield* store.readAll(0)).toEqual([])
        expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([])
      }),
    ),
  )

  it.effect("cleans a crashed empty cancel envelope after fencing its source", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const deadline = 2_500
        const generation = "8".repeat(32)
        yield* store.readAll(deadline - 1)
        const source = path.join(
          stagingRoot(value),
          stagingName(LEASE_ID, deadline, generation),
        )
        const crashedEnvelope = path.join(
          stagingTrashRoot(value),
          cancellationName(
            LEASE_ID,
            deadline,
            generation,
            "9".repeat(32),
          ),
        )
        yield* Effect.promise(() => fs.mkdir(source, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.mkdir(crashedEnvelope, { mode: 0o700 }),
        )

        expect(yield* store.readAll(deadline)).toEqual([])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingRoot(value))),
        ).toEqual([])
        expect(
          yield* Effect.promise(() => fs.readdir(stagingTrashRoot(value))),
        ).toEqual([])
      }),
    ),
  )

  it.effect("fails closed on malformed staging while cleaning safe siblings", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const deadline = 3_000
        yield* store.readAll(deadline - 1)
        const safeStage = path.join(
          stagingRoot(value),
          stagingName(LEASE_ID, deadline, "9".repeat(32)),
        )
        const legacyStage = path.join(stagingRoot(value), "a".repeat(32))
        yield* Effect.promise(() => fs.mkdir(safeStage, { mode: 0o700 }))
        yield* Effect.promise(() => fs.mkdir(legacyStage, { mode: 0o700 }))

        const error = yield* Effect.flip(store.readAll(deadline))

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => exists(safeStage))).toBe(false)
        expect(yield* Effect.promise(() => exists(legacyStage))).toBe(true)
      }),
    ),
  )

  it.effect("retains unsafe staging-trash payloads without traversing them", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.readAll(0)
        const safe = path.join(
          stagingTrashRoot(value),
          cancellationName(
            LEASE_ID,
            1_000,
            "a".repeat(32),
            "b".repeat(32),
          ),
        )
        const unsafe = path.join(
          stagingTrashRoot(value),
          cancellationName(
            LEASE_ID,
            1_000,
            "c".repeat(32),
            "d".repeat(32),
          ),
        )
        const nested = path.join(unsafe, "payload", "nested")
        const marker = path.join(nested, "marker")
        yield* Effect.promise(() => fs.mkdir(safe, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.mkdir(nested, { recursive: true, mode: 0o700 }),
        )
        yield* Effect.promise(() => fs.writeFile(marker, "keep"))

        const error = yield* Effect.flip(store.readAll(0))

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => exists(safe))).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe(
          "keep",
        )
      }),
    ),
  )

  it.effect("does not follow staging-trash symlinks or unlink hardlink targets", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.readAll(0)
        const outside = path.join(value.root.path, "staging-trash-targets")
        const symlinkTarget = path.join(outside, "symlink-target")
        const hardlinkTarget = path.join(outside, "hardlink-target")
        yield* Effect.promise(() => fs.mkdir(outside, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.writeFile(symlinkTarget, "keep-symlink", { mode: 0o600 }),
        )
        yield* Effect.promise(() =>
          fs.writeFile(hardlinkTarget, "keep-hardlink", { mode: 0o600 }),
        )
        const envelopes = ["3", "4"].map((digit) =>
          path.join(
            stagingTrashRoot(value),
            cancellationName(
              LEASE_ID,
              1_000,
              digit.repeat(32),
              "5".repeat(32),
            ),
          ),
        )
        for (const envelope of envelopes) {
          yield* Effect.promise(() =>
            fs.mkdir(path.join(envelope, "payload"), {
              recursive: true,
              mode: 0o700,
            }),
          )
        }
        yield* Effect.promise(() =>
          fs.symlink(
            symlinkTarget,
            path.join(envelopes[0]!, "payload", "intent.json"),
          ),
        )
        yield* Effect.promise(() =>
          fs.link(
            hardlinkTarget,
            path.join(envelopes[1]!, "payload", "intent.json"),
          ),
        )

        const error = yield* Effect.flip(store.readAll(0))

        expect(error.operation).toBe("read")
        expect(
          yield* Effect.promise(() => fs.readFile(symlinkTarget, "utf8")),
        ).toBe("keep-symlink")
        expect(
          yield* Effect.promise(() => fs.readFile(hardlinkTarget, "utf8")),
        ).toBe("keep-hardlink")
        expect((yield* Effect.promise(() => fs.lstat(hardlinkTarget))).nlink).toBe(
          2,
        )
      }),
    ),
  )

  it.effect("fails closed when canceled payload and exact source both exist", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        const deadline = 4_000
        const generation = "e".repeat(32)
        yield* store.readAll(0)
        const source = path.join(
          stagingRoot(value),
          stagingName(LEASE_ID, deadline, generation),
        )
        const envelope = path.join(
          stagingTrashRoot(value),
          cancellationName(
            LEASE_ID,
            deadline,
            generation,
            "f".repeat(32),
          ),
        )
        yield* Effect.promise(() => fs.mkdir(source, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.mkdir(path.join(envelope, "payload"), {
            recursive: true,
            mode: 0o700,
          }),
        )

        const error = yield* Effect.flip(store.readAll(0))

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => exists(source))).toBe(true)
        expect(yield* Effect.promise(() => exists(envelope))).toBe(true)
      }),
    ),
  )

  it.effect("retains non-canonical staging-trash deadlines", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.readAll(0)
        const overflow = path.join(
          stagingTrashRoot(value),
          `cancel-${LEASE_ID}-9999999999999999-${"1".repeat(32)}-${"2".repeat(32)}`,
        )
        yield* Effect.promise(() => fs.mkdir(overflow, { mode: 0o700 }))

        const error = yield* Effect.flip(store.readAll(0))

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => exists(overflow))).toBe(true)
      }),
    ),
  )

  it.effect("concurrently converges recognized terminal trash cleanup", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const stores = Array.from({ length: 8 }, () => storeFor(value))
        const lease = yield* stores[0]!.prepare(input)
        const trashRoot = path.join(
          value.state,
          "verifier-oci",
          "v1",
          "trash",
        )
        const terminalTrash = Array.from({ length: 16 }, (_, index) =>
          path.join(
            trashRoot,
            `${(index + 2).toString(16).padStart(32, "0")}-${(index + 1).toString(16).padStart(16, "0")}`,
          ),
        )
        yield* Effect.promise(() =>
          Promise.all(
            terminalTrash.map((target) =>
              fs.mkdir(target, { mode: 0o700 }),
            ),
          ),
        )

        const results = yield* Effect.all(
          stores.map((store) => store.readAll()),
          { concurrency: "unbounded" },
        )

        expect(results).toEqual(stores.map(() => [lease]))
        expect(yield* Effect.promise(() => fs.readdir(trashRoot))).toEqual([])
      }),
    ),
  )

  it.effect("fails closed on terminal trash symlinks without touching targets", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.prepare(input)
        const outside = path.join(value.root.path, "trash-target")
        const marker = path.join(outside, "marker")
        const safeTrash = path.join(
          value.state,
          "verifier-oci",
          "v1",
          "trash",
          `${"e".repeat(32)}-${"7".repeat(16)}`,
        )
        yield* Effect.promise(() => fs.mkdir(outside, { mode: 0o700 }))
        yield* Effect.promise(() => fs.writeFile(marker, "keep"))
        yield* Effect.promise(() => fs.mkdir(safeTrash, { mode: 0o700 }))
        yield* Effect.promise(() =>
          fs.symlink(
            outside,
            path.join(
              value.state,
              "verifier-oci",
              "v1",
              "trash",
              `${"e".repeat(32)}-${"6".repeat(16)}`,
            ),
          ),
        )

        const error = yield* Effect.flip(store.readAll())

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe(
          "keep",
        )
        expect(yield* Effect.promise(() => exists(safeTrash))).toBe(false)
      }),
    ),
  )

  it.effect("retains terminal trash containing nested directories", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.prepare(input)
        const malformedTrash = path.join(
          value.state,
          "verifier-oci",
          "v1",
          "trash",
          `${"e".repeat(32)}-${"8".repeat(16)}`,
        )
        const nested = path.join(malformedTrash, "nested")
        const marker = path.join(nested, "marker")
        yield* Effect.promise(() =>
          fs.mkdir(nested, { recursive: true, mode: 0o700 }),
        )
        yield* Effect.promise(() => fs.writeFile(marker, "keep"))

        const error = yield* Effect.flip(store.readAll())

        expect(error.operation).toBe("read")
        expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe(
          "keep",
        )
      }),
    ),
  )

  it.effect("strictly rejects symlink and orphan list entries", () =>
    withFixture((value) =>
      Effect.gen(function* () {
        const store = storeFor(value)
        yield* store.prepare(input)
        const outside = path.join(value.root.path, "outside")
        yield* Effect.promise(() => fs.mkdir(outside, { mode: 0o700 }))
        const symlinkID = "2".repeat(32)
        const link = path.join(
          value.state,
          "verifier-oci",
          "v1",
          "leases",
          symlinkID,
        )
        yield* Effect.promise(() => fs.symlink(outside, link))
        const linked = yield* Effect.flip(store.readAll())
        expect(linked.operation).toBe("read")

        yield* Effect.promise(() => fs.unlink(link))
        const orphanID = "3".repeat(32)
        yield* Effect.promise(() =>
          fs.mkdir(path.join(subjectRoot(value), orphanID), { mode: 0o700 }),
        )
        const orphan = yield* Effect.flip(store.readAll())
        expect(orphan.operation).toBe("read")
      }),
    ),
  )

  it.effect(
    "lists leases deterministically and removes only derived paths",
    () =>
      withFixture((value) =>
        Effect.gen(function* () {
          const ids = [LEASE_ID, SECOND_LEASE_ID]
          const store = storeFor(value, () => ids.shift()!)
          const first = yield* store.prepare(input)
          const second = yield* store.prepare({
            ...input,
            snapshot: Snapshot.ID.make("e".repeat(40)),
          })
          yield* Effect.promise(() => fs.mkdir(first.subject, { mode: 0o700 }))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(first.subject, "payload"), "snapshot bytes"),
          )
          const unrelated = path.join(value.root.path, "unrelated")
          yield* Effect.promise(() => fs.mkdir(unrelated, { mode: 0o700 }))

          expect(
            (yield* store.readAll()).map((lease) => lease.leaseID),
          ).toEqual([SECOND_LEASE_ID, LEASE_ID])
          yield* store.removeSubject(first.leaseID)
          yield* store.removeSubject(first.leaseID)
          expect(yield* Effect.promise(() => exists(first.subject))).toBe(false)
          expect(
            yield* Effect.promise(() =>
              exists(leaseDirectory(value, LEASE_ID)),
            ),
          ).toBe(true)
          expect(
            (yield* store.readAll()).map((lease) => lease.leaseID),
          ).toEqual([SECOND_LEASE_ID, LEASE_ID])
          yield* store.remove(first.leaseID)
          yield* store.remove(first.leaseID)

          expect(yield* Effect.promise(() => exists(first.subject))).toBe(false)
          expect(
            yield* Effect.promise(() =>
              exists(leaseDirectory(value, LEASE_ID)),
            ),
          ).toBe(false)
          expect(yield* Effect.promise(() => exists(unrelated))).toBe(true)
          expect(yield* store.readAll()).toEqual([second])
        }),
      ),
  )

  it.effect(
    "refuses a symlinked fixed lease root without touching its target",
    () =>
      withFixture((value) =>
        Effect.gen(function* () {
          const target = path.join(value.root.path, "target")
          const product = path.join(value.state, "verifier-oci")
          yield* Effect.promise(() => fs.mkdir(target, { mode: 0o700 }))
          yield* Effect.promise(() => fs.symlink(target, product))
          const store = storeFor(value)

          const error = yield* Effect.flip(store.readAll())
          expect(error.operation).toBe("read")
          expect(yield* Effect.promise(() => fs.readdir(target))).toEqual([])
        }),
      ),
  )
})
