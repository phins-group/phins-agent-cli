import { describe, expect } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppPaths } from "../src/runtime/paths"
import { AbsolutePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { VerifierOciLease } from "../src/verification/oci/lease"
import { VerifierOciRuntime } from "../src/verification/oci/runtime"
import { VerifierOciSupervisor } from "../src/verification/oci/supervisor"
import { VerifierRegistry } from "../src/verification/registry"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const containerID = VerifierOciLease.ContainerID.make("d".repeat(64))
const leaseID = VerifierOciLease.LeaseID.make("1".repeat(32))
const digest = `sha256:${"a".repeat(64)}`
const reference = `registry.example/phins/verifier@${digest}`
const lease: VerifierOciLease.Lease = Object.freeze({
  version: 1,
  leaseID,
  owner: "00000000-0000-4000-8000-000000000001",
  executionHash: `sha256:${"b".repeat(64)}`,
  snapshot: Snapshot.ID.make("c".repeat(40)),
  image: VerifierRegistry.OciImage.make({ reference, platform: "linux/amd64" }),
  reapAfterMs: 100,
  subject: AbsolutePath.make(`/tmp/phins/verifier-oci/v1/subjects/${leaseID}`),
})

const result = (
  args: readonly string[],
  overrides: Partial<{
    exitCode: number
    stdout: Buffer
    stderr: Buffer
    stdoutTruncated: boolean
    stderrTruncated: boolean
  }> = {},
) => ({
  command: args.join(" "),
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
})

const metadata = (
  inputLease: VerifierOciLease.Lease,
  inputContainerID = containerID,
  labels: Readonly<Record<string, string>> = VerifierOciSupervisor.labelsFor(inputLease),
) =>
  Buffer.from(
    JSON.stringify([
      {
        Id: inputContainerID,
        Config: { Image: inputLease.image.reference, Labels: labels },
        State: { Status: "exited", Running: false, ExitCode: 0, OOMKilled: false, Error: "" },
      },
    ]),
  )

const store = (current: readonly VerifierOciLease.Lease[]) => {
  const removed: string[] = []
  const removedSubjects: string[] = []
  const retired: string[] = []
  const resetAbsences: string[] = []
  const readAt: Array<number | undefined> = []
  const service: VerifierOciLease.Interface = {
    prepare: () => Effect.die("unused prepare"),
    commitContainerID: () => Effect.die("unused commit"),
    readAll: (nowMs) =>
      Effect.sync(() => {
        readAt.push(nowMs)
        return current
      }),
    removeSubject: (id) => Effect.sync(() => void removedSubjects.push(id)),
    observeNoStartAbsence: (_id, observedAtMs) =>
      Effect.succeed({
        observations: 1,
        firstObservedAtMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        eligible: false,
      }),
    resetNoStartAbsence: (id) =>
      Effect.sync(() => void resetAbsences.push(id)),
    retireNoStart: (id) => Effect.sync(() => void retired.push(id)),
    remove: (id) => Effect.sync(() => void removed.push(id)),
  }
  return {
    service,
    removed,
    removedSubjects,
    retired,
    resetAbsences,
    readAt,
  }
}

const withLedger = <A, E>(use: (global: AppPaths.Interface) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      const state = path.join(root.path, "state")
      const temporary = path.join(root.path, "tmp")
      await Promise.all([
        fs.mkdir(state, { mode: 0o755 }),
        fs.mkdir(temporary, { mode: 0o755 }),
      ])
      return { root, global: AppPaths.resolvePaths({ state, tmp: temporary }) }
    }),
    ({ global }) => use(global),
    ({ root }) => Effect.promise(() => root[Symbol.asyncDispose]()),
  )

const prepareExpired = (global: AppPaths.Interface) => {
  const leases = VerifierOciLease.make(global, {
    leaseID: () => leaseID,
    owner: () => lease.owner,
  })
  return Effect.gen(function* () {
    yield* leases.prepare({
      executionHash: lease.executionHash,
      snapshot: lease.snapshot,
      image: lease.image,
      reapAfterMs: lease.reapAfterMs,
    })
    return leases
  })
}

describe("VerifierOciSupervisor", () => {
  it.effect("one-shot reconciliation fails closed when the OCI runtime is unavailable", () =>
    withLedger((global) =>
      Effect.gen(function* () {
        const leases = yield* prepareExpired(global)

        const error = yield* Effect.flip(
          VerifierOciSupervisor.reapOnce(lease.reapAfterMs).pipe(
            Effect.provideService(AppPaths.Service, AppPaths.Service.of(global)),
            Effect.provideService(VerifierOciRuntime.Service, VerifierOciRuntime.Service.of({})),
          ),
        )

        expect(error.operation).toBe("reap")
        expect(error.message).toBe("OCI runtime is unavailable")
        const retained = yield* leases.readAll()
        expect(retained).toHaveLength(1)
        expect(retained[0]?.leaseID).toBe(leaseID)
        expect(retained[0]?.startDisabled).toBeUndefined()
      }),
    ),
  )

  it.effect("one-shot reconciliation uses only the supplied global ledger and runtime", () =>
    withLedger((global) =>
      Effect.gen(function* () {
        const leases = yield* prepareExpired(global)
        const calls: string[][] = []
        const runtime: VerifierOciRuntime.Backend = {
          kind: "docker",
          binary: AbsolutePath.make("/usr/bin/docker"),
          run: (args) =>
            Effect.sync(() => {
              calls.push([...args])
              return result(args)
            }),
        }

        const report = yield* VerifierOciSupervisor.reapOnce(lease.reapAfterMs).pipe(
          Effect.provideService(AppPaths.Service, AppPaths.Service.of(global)),
          Effect.provideService(
            VerifierOciRuntime.Service,
            VerifierOciRuntime.Service.of({ backend: runtime }),
          ),
        )

        expect(report).toEqual({
          examined: 1,
          expired: 1,
          deferredExpired: 0,
          removedContainers: 0,
          terminalLeases: 0,
          tombstones: 1,
          retiredTombstones: 0,
        })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.slice(0, 6)).toEqual([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
        ])
        expect(yield* leases.readAll()).toEqual([
          expect.objectContaining({ leaseID, startDisabled: true }),
        ])
      }),
    ),
  )

  it.effect("retires an aged no-start tombstone only after a final empty runtime scan", () =>
    withLedger((global) =>
      Effect.gen(function* () {
        const leases = yield* prepareExpired(global)
        let listCalls = 0
        const runtime: VerifierOciRuntime.Backend = {
          kind: "docker",
          binary: AbsolutePath.make("/usr/bin/docker"),
          run: (args) =>
            Effect.sync(() => {
              if (args[1] === "ls") listCalls++
              return result(args)
            }),
        }
        const supervisor = VerifierOciSupervisor.make({ runtime, leases })

        const fenced = yield* supervisor.reap(lease.reapAfterMs)
        expect(fenced.tombstones).toBe(1)
        expect(fenced.retiredTombstones).toBe(0)

        const firstObservedAt = lease.reapAfterMs + 1
        const observed = yield* supervisor.reap(firstObservedAt)
        expect(observed.tombstones).toBe(1)
        expect(observed.retiredTombstones).toBe(0)

        const matureAt =
          firstObservedAt +
          VerifierOciLease.RETIREMENT_POLICY.tombstoneMinimumAgeMs
        const retired = yield* supervisor.reap(matureAt)
        expect(retired.tombstones).toBe(0)
        expect(retired.retiredTombstones).toBe(1)
        expect(retired.removedContainers).toBe(0)
        expect(listCalls).toBe(4)
        expect(yield* leases.readAll(matureAt)).toEqual([])
      }),
    ),
  )

  it.effect("does not touch a live lease before its hard deadline", () =>
    Effect.gen(function* () {
      const leases = store([lease])
      const supervisor = VerifierOciSupervisor.make({ leases: leases.service })

      const report = yield* supervisor.reap(99)

      expect(report).toEqual({
        examined: 1,
        expired: 0,
        deferredExpired: 0,
        removedContainers: 0,
        terminalLeases: 0,
        tombstones: 0,
        retiredTombstones: 0,
      })
      expect(leases.removed).toEqual([])
      expect(leases.removedSubjects).toEqual([])
      expect(leases.readAt).toEqual([99])
    }),
  )

  it.effect("bounds expired lease reconciliation and reports deferred work", () =>
    Effect.gen(function* () {
      const total =
        VerifierOciLease.RETIREMENT_POLICY.expiredLeasesPerReap + 1
      const expired = Array.from({ length: total }, (_, index) =>
        Object.freeze({
          ...lease,
          leaseID: VerifierOciLease.LeaseID.make(
            index.toString(16).padStart(32, "0"),
          ),
          containerID: VerifierOciLease.ContainerID.make(
            index.toString(16).padStart(64, "0"),
          ),
        }),
      )
      const leases = store(expired)
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) =>
          Effect.succeed(
            result(args, {
              exitCode: 1,
              stderr: Buffer.from("Error: No such container: verifier"),
            }),
          ),
      }

      const report = yield* VerifierOciSupervisor.make({
        runtime,
        leases: leases.service,
      }).reap(lease.reapAfterMs)

      expect(report).toMatchObject({
        examined: total,
        expired: total,
        deferredExpired: 1,
        terminalLeases:
          VerifierOciLease.RETIREMENT_POLICY.expiredLeasesPerReap,
      })
      expect(leases.removed).toHaveLength(
        VerifierOciLease.RETIREMENT_POLICY.expiredLeasesPerReap,
      )
    }),
  )

  it.effect("removes a known expired container by immutable ID before terminalizing its lease", () =>
    Effect.gen(function* () {
      const committed = Object.freeze({ ...lease, containerID })
      const leases = store([committed])
      const calls: string[][] = []
      let exists = true
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) =>
          Effect.sync(() => {
            calls.push([...args])
            if (args[1] === "inspect")
              return exists
                ? result(args, { stdout: metadata(committed) })
                : result(args, { exitCode: 1, stderr: Buffer.from("Error: No such container: verifier") })
            if (args[1] === "rm") {
              exists = false
              // Lost/negative acknowledgement is accepted only after strict
              // re-inspection proves the exact ID absent.
              return result(args, { exitCode: 1 })
            }
            return result(args, { exitCode: 1 })
          }),
      }
      const supervisor = VerifierOciSupervisor.make({ runtime, leases: leases.service })

      const report = yield* supervisor.reap(100)

      expect(exists).toBe(false)
      expect(report.removedContainers).toBe(1)
      expect(report.terminalLeases).toBe(1)
      expect(leases.removed).toEqual([leaseID])
      expect(leases.removedSubjects).toEqual([])
      expect(calls.find((args) => args[1] === "rm")?.at(-1)).toBe(containerID)
    }),
  )

  it.effect("fails closed instead of removing a container whose labels do not match", () =>
    Effect.gen(function* () {
      const committed = Object.freeze({ ...lease, containerID })
      const leases = store([committed])
      let removeCalls = 0
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) => {
          if (args[1] === "rm") removeCalls++
          return Effect.succeed(
            result(args, {
              stdout: metadata(committed, containerID, {
                ...VerifierOciSupervisor.labelsFor(committed),
                [VerifierOciSupervisor.LABEL.owner]: "00000000-0000-4000-8000-000000000002",
              }),
            }),
          )
        },
      }
      const supervisor = VerifierOciSupervisor.make({ runtime, leases: leases.service })

      const error = yield* Effect.flip(supervisor.reap(100))

      expect(error.operation).toBe("reap")
      expect(removeCalls).toBe(0)
      expect(leases.removed).toEqual([])
      expect(leases.removedSubjects).toEqual([])
    }),
  )

  it.effect("continues reaping later leases after one expired lease fails", () =>
    Effect.gen(function* () {
      const firstID = VerifierOciLease.ContainerID.make("c".repeat(64))
      const secondID = VerifierOciLease.ContainerID.make("e".repeat(64))
      const first = Object.freeze({ ...lease, containerID: firstID })
      const second = Object.freeze({
        ...lease,
        leaseID: VerifierOciLease.LeaseID.make("2".repeat(32)),
        owner: "00000000-0000-4000-8000-000000000003",
        executionHash: `sha256:${"f".repeat(64)}`,
        containerID: secondID,
      })
      const leases = store([first, second])
      const existing = new Set<string>([firstID, secondID])
      const removedTargets: string[] = []
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) =>
          Effect.sync(() => {
            const target = args.at(-1)!
            if (args[1] === "inspect") {
              if (!existing.has(target))
                return result(args, {
                  exitCode: 1,
                  stderr: Buffer.from("Error: No such container: verifier"),
                })
              const targetLease = target === firstID ? first : second
              const labels =
                target === firstID
                  ? {
                      ...VerifierOciSupervisor.labelsFor(targetLease),
                      [VerifierOciSupervisor.LABEL.owner]:
                        "00000000-0000-4000-8000-000000000004",
                    }
                  : VerifierOciSupervisor.labelsFor(targetLease)
              return result(args, {
                stdout: metadata(targetLease, target as VerifierOciLease.ContainerID, labels),
              })
            }
            if (args[1] === "rm") {
              removedTargets.push(target)
              existing.delete(target)
              return result(args)
            }
            return result(args, { exitCode: 1 })
          }),
      }
      const supervisor = VerifierOciSupervisor.make({ runtime, leases: leases.service })

      const error = yield* Effect.flip(supervisor.reap(100))

      expect(error.operation).toBe("reap")
      expect(existing.has(firstID)).toBe(true)
      expect(existing.has(secondID)).toBe(false)
      expect(removedTargets).toEqual([secondID])
      expect(leases.removed).toEqual([second.leaseID])
    }),
  )

  it.effect("keeps a no-ID tombstone and catches a container that appears after the first scan", () =>
    Effect.gen(function* () {
      const leases = store([lease])
      let scan = 0
      let exists = false
      let removes = 0
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) =>
          Effect.sync(() => {
            if (args[1] === "ls") {
              scan++
              if (scan === 2) exists = true
              return result(args, { stdout: exists ? Buffer.from(`${containerID}\n`) : Buffer.alloc(0) })
            }
            if (args[1] === "inspect")
              return exists
                ? result(args, { stdout: metadata(lease) })
                : result(args, { exitCode: 1, stderr: Buffer.from("Error: No such object: verifier") })
            if (args[1] === "rm") {
              removes++
              exists = false
              return result(args)
            }
            return result(args, { exitCode: 1 })
          }),
      }
      const supervisor = VerifierOciSupervisor.make({ runtime, leases: leases.service })

      const first = yield* supervisor.reap(100)
      const second = yield* supervisor.reap(101)

      expect(first.tombstones).toBe(1)
      expect(first.removedContainers).toBe(0)
      expect(second.tombstones).toBe(1)
      expect(second.removedContainers).toBe(1)
      expect(removes).toBe(1)
      expect(leases.removed).toEqual([])
      expect(leases.removedSubjects).toEqual([leaseID, leaseID])
    }),
  )

  it.effect("rejects truncated container IDs returned by label discovery", () =>
    Effect.gen(function* () {
      const leases = store([lease])
      const runtime: VerifierOciRuntime.Backend = {
        kind: "docker",
        binary: AbsolutePath.make("/usr/bin/docker"),
        run: (args) => Effect.succeed(result(args, { stdout: Buffer.from(`${"d".repeat(12)}\n`) })),
      }
      const supervisor = VerifierOciSupervisor.make({ runtime, leases: leases.service })

      const error = yield* Effect.flip(supervisor.reap(100))

      expect(error.operation).toBe("reap")
      expect(leases.removedSubjects).toEqual([])
    }),
  )
})
