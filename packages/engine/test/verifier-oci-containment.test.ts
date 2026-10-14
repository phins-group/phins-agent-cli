import { describe, expect } from "bun:test"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { FileAccess } from "../src/workspace/files/access"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { VerifierOciContainment } from "../src/verification/oci/containment"
import { VerifierOciLease } from "../src/verification/oci/lease"
import { VerifierOciRuntime } from "../src/verification/oci/runtime"
import { VerifierOciSupervisor } from "../src/verification/oci/supervisor"
import { VerifierRegistry } from "../src/verification/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FileAccess.defaultLayer)
const projectID = ProjectRegistry.ID.make("project_oci_containment_test")
const projectRoot = AbsolutePath.make("/project")
const snapshot = Snapshot.ID.make("a".repeat(40))
const subject = {
  executionID: VerificationReceipt.ID.make("verification_oci_containment_test"),
  snapshot,
  projectID,
  locationKey: VerificationReceipt.LocationKey.make("location_oci_containment_test"),
} as const
const bundleDigest = `sha256:${"a".repeat(64)}`
const reference = `registry.example/phins/verifier@${bundleDigest}`
const provenance = {
  kind: "signed-policy" as const,
  authorityID: "oci-test-policy",
  keyID: `sha256:${"b".repeat(64)}`,
  revision: 1,
  policyDigest: `sha256:${"c".repeat(64)}`,
}
const projectRootIdentity: VerifierRegistry.ProjectRootIdentity = {
  schema: "phins.verifier-project-root-identity.v1",
  canonicalPath: projectRoot,
  device: "7",
  inode: "11",
}
const leaseID = VerifierOciLease.LeaseID.make("1".repeat(32))
const containerID = VerifierOciLease.ContainerID.make("d".repeat(64))

const plan = (timeoutMs = 120_000, maxOutputBytes = 16_384) => ({
  id: "oci-project-tests",
  version: "1",
  source: "policy" as const,
  check: {
    id: "unit",
    argv: ["node", "--eval", "literal;$(never-a-shell)"],
    cwd: ".",
    timeoutMs,
    maxOutputBytes,
  },
  executor: {
    id: VerifierOciContainment.EXECUTOR_ID,
    version: VerifierOciContainment.EXECUTOR_VERSION,
    bundleDigest,
    oci: { reference, platform: "linux/amd64" as const },
  },
  containment: {
    subject: "snapshot-copy" as const,
    filesystem: "read-only" as const,
    network: "network-deny" as const,
    environment: "sanitized-env" as const,
    profile: VerifierOciContainment.PROFILE,
  },
})

const selection = (timeoutMs?: number, maxOutputBytes?: number) =>
  VerifierRegistry.pin(
    plan(timeoutMs, maxOutputBytes),
    { projectID, projectRoot, projectRootIdentity },
    provenance,
  )

const runResult = (
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

const imageMetadata = (digest = bundleDigest, volumes: Record<string, unknown> | null = null) =>
  Buffer.from(
    JSON.stringify([
      {
        RepoDigests: [`registry.example/phins/verifier@${digest}`],
        Os: "linux",
        Architecture: "amd64",
        Config: { Volumes: volumes },
      },
    ]),
  )

interface LeaseStoreOptions {
  readonly failPrepare?: boolean
  readonly failCommit?: boolean
}

const leaseStore = (directory: AbsolutePath, events: string[], options: LeaseStoreOptions = {}) => {
  let current: VerifierOciLease.Lease | undefined
  const service: VerifierOciLease.Interface = {
    prepare: (input) => {
      if (options.failPrepare)
        return Effect.fail(
          new VerifierOciLease.Error({ operation: "prepare", message: "intent fsync failed" }),
        )
      return Effect.sync(() => {
        events.push("intent")
        current = Object.freeze({
          version: 1 as const,
          leaseID,
          owner: "00000000-0000-4000-8000-000000000001",
          executionHash: input.executionHash,
          snapshot: input.snapshot,
          image: input.image,
          reapAfterMs: input.reapAfterMs,
          subject: directory,
        })
        return current
      })
    },
    commitContainerID: (_inputLeaseID, inputContainerID) => {
      if (options.failCommit)
        return Effect.fail(
          new VerifierOciLease.Error({
            operation: "commit-container-id",
            message: "container ID fsync failed",
          }),
        )
      return Effect.sync(() => {
        events.push("commit-id")
        if (!current) throw new Error("lease was not prepared")
        current = Object.freeze({
          ...current,
          containerID: VerifierOciLease.ContainerID.make(inputContainerID),
        })
        return current
      })
    },
    readAll: () => Effect.sync(() => (current ? [current] : [])),
    removeSubject: () =>
      Effect.sync(() => {
        events.push("subject-reap")
      }),
    observeNoStartAbsence: (_inputLeaseID, observedAtMs) =>
      Effect.succeed({
        observations: 1,
        firstObservedAtMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        eligible: false,
      }),
    resetNoStartAbsence: () => Effect.void,
    retireNoStart: () => Effect.die("unused no-start retirement"),
    remove: () =>
      Effect.sync(() => {
        events.push("lease-remove")
        current = undefined
      }),
  }
  return { service, current: () => current }
}

interface DaemonOptions {
  readonly image?: Buffer
  readonly createOutput?: Buffer
  readonly createExitCode?: number
  readonly startOutput?: Buffer
  readonly startExitCode?: number
  readonly verifierExitCode?: number
  readonly oomKilled?: boolean
  readonly stateError?: string
  readonly foreignOwner?: boolean
  readonly removeKeepsContainer?: boolean
  readonly hangStart?: boolean
  readonly onCreate?: () => void
  readonly mountSource?: string
  readonly mountReadWrite?: boolean
  readonly mountPropagation?: string
  readonly onStart?: () => Effect.Effect<void>
}

const daemon = (
  ledger: ReturnType<typeof leaseStore>,
  events: string[],
  options: DaemonOptions = {},
) => {
  let exists = false
  let status = "created"
  const calls: string[][] = []
  const metadata = () => {
    const current = ledger.current()
    if (!current) throw new Error("container was inspected without a durable lease")
    const labels = {
      ...VerifierOciSupervisor.labelsFor(current),
      ...(options.foreignOwner
        ? { [VerifierOciSupervisor.LABEL.owner]: "00000000-0000-4000-8000-000000000002" }
        : {}),
    }
    return Buffer.from(
      JSON.stringify([
        {
          Id: containerID,
          Config: { Image: current.image.reference, Labels: labels },
          State: {
            Status: status,
            Running: status === "running",
            ExitCode: status === "exited" ? (options.verifierExitCode ?? 0) : 0,
            OOMKilled: options.oomKilled ?? false,
            Error: options.stateError ?? "",
          },
          Mounts: [
            {
              Type: "bind",
              Source: options.mountSource ?? current.subject,
              Destination: "/workspace",
              RW: options.mountReadWrite ?? false,
              Propagation: options.mountPropagation ?? "rprivate",
            },
          ],
        },
      ]),
    )
  }
  const runtime: VerifierOciRuntime.Backend = {
    kind: "docker",
    binary: AbsolutePath.make("/usr/bin/docker"),
    run: (args) => {
      calls.push([...args])
      if (args[0] === "image") return Effect.succeed(runResult(args, { stdout: options.image ?? imageMetadata() }))
      if (args[0] === "container" && args[1] === "create")
        return Effect.sync(() => {
          options.onCreate?.()
          events.push("create")
          exists = true
          status = "created"
          return runResult(args, {
            exitCode: options.createExitCode ?? 0,
            stdout: options.createOutput ?? Buffer.from(`${containerID}\n`),
          })
        })
      if (args[0] === "container" && args[1] === "start") {
        status = "running"
        events.push("start")
        const signaled = options.onStart?.() ?? Effect.void
        if (options.hangStart) return signaled.pipe(Effect.andThen(Effect.never))
        return signaled.pipe(
          Effect.andThen(
            Effect.sync(() => {
              status = "exited"
              return runResult(args, {
                exitCode: options.startExitCode ?? options.verifierExitCode ?? 0,
                stdout: options.startOutput ?? Buffer.from("ok\n"),
              })
            }),
          ),
        )
      }
      if (args[0] === "container" && args[1] === "inspect")
        return Effect.sync(() => {
          events.push(exists ? `inspect-${status}` : "inspect-absent")
          return exists
            ? runResult(args, { stdout: metadata() })
            : runResult(args, {
                exitCode: 1,
                stderr: Buffer.from("Error: No such container: verifier"),
              })
        })
      if (args[0] === "container" && args[1] === "rm")
        return Effect.sync(() => {
          events.push("rm")
          if (!options.removeKeepsContainer) exists = false
          return runResult(args)
        })
      if (args[0] === "container" && args[1] === "ls") return Effect.succeed(runResult(args))
      return Effect.succeed(runResult(args, { exitCode: 1 }))
    },
  }
  return { runtime, calls, exists: () => exists }
}

const snapshotService = (
  directory: AbsolutePath,
  events: string[],
  onCleanup: () => void,
  onMaterialize?: () => void,
) =>
  Snapshot.Service.of({
    capture: () => Effect.succeed(snapshot),
    captureVerification: () => Effect.succeed(snapshot),
    captureObservation: () => Effect.succeed(snapshot),
    retain: () => Effect.sync(() => events.push("retain")).pipe(Effect.asVoid),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    materialize: (requested) =>
      Effect.sync(() => ({
        directory,
        projectRoot,
        snapshot: requested,
        cleanup: Effect.sync(() => {
          events.push("subject-cleanup")
          onCleanup()
        }),
      })),
    materializeAt: (requested, destination) =>
      Effect.sync(() => {
        events.push("materialize")
        onMaterialize?.()
        return {
          directory: destination,
          projectRoot,
          snapshot: requested,
          cleanup: Effect.sync(() => {
            events.push("subject-cleanup")
            onCleanup()
          }),
        }
      }),
  })

const containment = (
  runtime: VerifierOciRuntime.Backend,
  fs: FileAccess.Interface,
  snapshots: Snapshot.Interface,
  ledger: ReturnType<typeof leaseStore>,
  inspectProjectRoot: VerifierRegistry.ProjectRootInspector = (candidate) =>
    Effect.succeed(
      candidate === projectRoot
        ? projectRootIdentity
        : {
            ...projectRootIdentity,
            canonicalPath: candidate,
            inode: "13",
          },
    ),
) =>
  VerifierOciContainment.make({
    runtime,
    fs,
    snapshots,
    supervisor: VerifierOciSupervisor.make({ runtime, leases: ledger.service }),
    inspectProjectRoot,
  })

const withTemporary = <A, E, R>(use: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (temporary) => use(AbsolutePath.make(temporary.path)),
    (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
  )

describe("VerifierOciContainment", () => {
  it.effect("commits create identity before start and cleans container before subject and lease", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        let materializations = 0
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++, () => materializations++),
          ledger,
        )

        const result = yield* service.execute({ selection: selection(), subject })
        const create = docker.calls.find((args) => args[0] === "container" && args[1] === "create")
        const start = docker.calls.find((args) => args[0] === "container" && args[1] === "start")

        expect(result.status).toBe("passed")
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("ok\n")
        expect(materializations).toBe(1)
        expect(cleanups).toBe(1)
        expect(create).toBeDefined()
        expect(create).toContain("--pull=never")
        expect(create).toContain("--restart=no")
        expect(create).toContain("--network=none")
        expect(create).toContain("--read-only")
        expect(create).toContain("--cap-drop=ALL")
        expect(create).toContain("--security-opt=no-new-privileges")
        expect(create?.some((argument) => argument.startsWith("--pid="))).toBe(false)
        expect(create?.some((argument) => argument.startsWith("--uts="))).toBe(false)
        expect(create).toContain(`--memory-swap=${VerifierOciContainment.LIMITS.memoryBytes}`)
        expect(create).toContain("--ulimit=core=0:0")
        expect(create).toContain("--entrypoint=node")
        expect(create).toContain("--env=HTTP_PROXY=")
        expect(create).toContain(reference)
        expect(create).not.toContain("--rm")
        expect(create).not.toContain(projectRoot)
        expect(create?.slice(-3)).toEqual([reference, "--eval", "literal;$(never-a-shell)"])
        expect(start).toEqual(["container", "start", "--attach", containerID])
        expect(events.indexOf("retain")).toBeLessThan(events.indexOf("intent"))
        expect(events.indexOf("intent")).toBeLessThan(events.indexOf("materialize"))
        expect(events.indexOf("materialize")).toBeLessThan(events.indexOf("create"))
        expect(events.indexOf("create")).toBeLessThan(events.indexOf("commit-id"))
        expect(events.indexOf("commit-id")).toBeLessThan(events.indexOf("start"))
        expect(events.indexOf("rm")).toBeLessThan(events.indexOf("subject-cleanup"))
        expect(events.indexOf("subject-cleanup")).toBeLessThan(events.indexOf("lease-remove"))
      }),
    ),
  )

  it.effect("rejects unsigned descriptors before runtime, lease, or materialization", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
        )
        const unsigned = VerifierRegistry.pin(plan(), { projectID, projectRoot })

        const error = yield* Effect.flip(service.execute({ selection: unsigned, subject }))

        expect(error.reason).toBe("descriptor-mismatch")
        expect(docker.calls).toEqual([])
        expect(events).toEqual([])
      }),
    ),
  )

  it.effect("rejects a replaced project root before any runtime operation", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
          (candidate) =>
            Effect.succeed({
              ...projectRootIdentity,
              canonicalPath: candidate,
              inode: candidate === projectRoot ? "12" : "13",
            }),
        )

        const error = yield* Effect.flip(
          service.execute({ selection: selection(), subject }),
        )

        expect(error.reason).toBe("subject-mismatch")
        expect(docker.calls).toEqual([])
        expect(events).toEqual([])
      }),
    ),
  )

  it.effect("does not create or start a verifier after the root is replaced during materialization", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let replaced = false
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(
            directory,
            events,
            () => undefined,
            () => {
              replaced = true
            },
          ),
          ledger,
          (candidate) =>
            Effect.succeed(
              candidate === projectRoot
                ? replaced
                  ? { ...projectRootIdentity, inode: "12" }
                  : projectRootIdentity
                : {
                    ...projectRootIdentity,
                    canonicalPath: candidate,
                    inode: "13",
                  },
            ),
        )

        const error = yield* Effect.flip(
          service.execute({ selection: selection(), subject }),
        )

        expect(error.reason).toBe("subject-mismatch")
        expect(
          docker.calls.some(
            (args) =>
              args[0] === "container" &&
              (args[1] === "create" || args[1] === "start"),
          ),
        ).toBe(false)
        expect(events).toContain("materialize")
        expect(events).toContain("subject-cleanup")
        expect(events).toContain("lease-remove")
      }),
    ),
  )

  it.effect("does not start after the materialized mount path is replaced during container create", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let mountReplaced = false
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, {
          onCreate: () => {
            mountReplaced = true
          },
        })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
          (candidate) =>
            Effect.succeed(
              candidate === projectRoot
                ? projectRootIdentity
                : {
                    ...projectRootIdentity,
                    canonicalPath: candidate,
                    inode: mountReplaced ? "14" : "13",
                  },
            ),
        )

        const error = yield* Effect.flip(
          service.execute({ selection: selection(), subject }),
        )

        expect(error.reason).toBe("materialization")
        expect(
          docker.calls.some(
            (args) =>
              args[0] === "container" && args[1] === "start",
          ),
        ).toBe(false)
        expect(events).toContain("create")
        expect(events).toContain("rm")
        expect(events).toContain("subject-cleanup")
      }),
    ),
  )

  it.effect("rejects a daemon-reported subject mount rewrite before start", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, {
          mountSource: "/replaced-subject",
        })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
        )

        const error = yield* Effect.flip(
          service.execute({ selection: selection(), subject }),
        )

        expect(error.reason).toBe("subject-mismatch")
        expect(
          docker.calls.some(
            (args) =>
              args[0] === "container" && args[1] === "start",
          ),
        ).toBe(false)
        expect(events).toContain("create")
        expect(events).toContain("rm")
      }),
    ),
  )

  it.effect("rejects evidence when materialization identity changes during container start", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let mountReplaced = false
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, {
          onStart: () =>
            Effect.sync(() => {
              mountReplaced = true
            }),
        })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
          (candidate) =>
            Effect.succeed(
              candidate === projectRoot
                ? projectRootIdentity
                : {
                    ...projectRootIdentity,
                    canonicalPath: candidate,
                    inode: mountReplaced ? "14" : "13",
                  },
            ),
        )

        const error = yield* Effect.flip(
          service.execute({ selection: selection(), subject }),
        )

        expect(error.reason).toBe("materialization")
        expect(events).toContain("start")
        expect(events).toContain("rm")
        expect(events).toContain("subject-cleanup")
      }),
    ),
  )

  it.effect("fails closed before durable intent when image digest or volume policy mismatches", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        for (const image of [
          imageMetadata(`sha256:${"d".repeat(64)}`),
          imageMetadata(bundleDigest, { "/unbounded-cache": {} }),
          Buffer.from(
            JSON.stringify([
              {
                RepoDigests: [reference],
                Os: "linux",
                Architecture: "amd64",
                Config: [],
              },
            ]),
          ),
        ]) {
          const events: string[] = []
          const ledger = leaseStore(directory, events)
          const docker = daemon(ledger, events, { image })
          const service = containment(
            docker.runtime,
            fs,
            snapshotService(directory, events, () => undefined),
            ledger,
          )

          const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))
          expect(error.reason).toBe("descriptor-mismatch")
          expect(events).toEqual([])
        }
      }),
    ),
  )

  it.effect("does not materialize or create when durable intent persistence fails", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events, { failPrepare: true })
        const docker = daemon(ledger, events)
        let materializations = 0
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined, () => materializations++),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("unavailable")
        expect(materializations).toBe(0)
        expect(events).toEqual(["retain"])
        expect(docker.calls.some((args) => args[1] === "create")).toBe(false)
      }),
    ),
  )

  it.effect("does not publish a lease when the snapshot cannot be retained", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const snapshots = snapshotService(directory, events, () => undefined)
        const service = containment(
          docker.runtime,
          fs,
          Snapshot.Service.of({
            ...snapshots,
            retain: () =>
              Effect.fail(
                new Snapshot.Error({
                  operation: "retain",
                  message: "missing snapshot tree",
                }),
              ),
          }),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("materialization")
        expect(events).toEqual([])
        expect(ledger.current()).toBeUndefined()
        expect(docker.calls.some((args) => args[1] === "create")).toBe(false)
      }),
    ),
  )

  it.effect("never starts when durable container ID persistence fails", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const ledger = leaseStore(directory, events, { failCommit: true })
        const docker = daemon(ledger, events)
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("launch")
        expect(events).toContain("create")
        expect(events).not.toContain("start")
        expect(events).toContain("rm")
        expect(cleanups).toBe(1)
      }),
    ),
  )

  it.effect("retains an intent tombstone and subject after an ambiguous create response", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, { createOutput: Buffer.from("ambiguous\n") })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("launch")
        expect(events).toContain("create")
        expect(events).not.toContain("commit-id")
        expect(events).not.toContain("start")
        expect(events).not.toContain("subject-cleanup")
        expect(events).not.toContain("lease-remove")
        expect(cleanups).toBe(0)
        expect(ledger.current()).toBeDefined()
      }),
    ),
  )

  it.effect("rejects a materializer that does not return the exact lease-owned destination", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events)
        const snapshots = snapshotService(directory, events, () => cleanups++)
        const service = containment(
          docker.runtime,
          fs,
          Snapshot.Service.of({
            ...snapshots,
            materializeAt: (requested, destination) =>
              snapshots.materializeAt(requested, destination).pipe(
                Effect.map((materialized) => ({
                  ...materialized,
                  directory: AbsolutePath.make("/project/verifier-subject"),
                })),
              ),
          }),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("subject-mismatch")
        expect(events).not.toContain("create")
        expect(cleanups).toBe(1)
        expect(events.at(-1)).toBe("lease-remove")
      }),
    ),
  )

  it.effect("uses post-run container state as exit authority, including exit 125", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, { verifierExitCode: 125 })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => undefined),
          ledger,
        )

        const result = yield* service.execute({ selection: selection(), subject })

        expect(result.status).toBe("failed")
        expect(result.exitCode).toBe(125)
        expect(result.summary).toBe("OCI verifier completed")
      }),
    ),
  )

  it.effect("treats Docker attach and inspected exit-code disagreement as infrastructure error", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        for (const mismatch of [
          { startExitCode: 1, verifierExitCode: 0 },
          { startExitCode: 0, verifierExitCode: 125 },
        ]) {
          const events: string[] = []
          const ledger = leaseStore(directory, events)
          const docker = daemon(ledger, events, mismatch)
          const service = containment(
            docker.runtime,
            fs,
            snapshotService(directory, events, () => undefined),
            ledger,
          )

          const result = yield* service.execute({ selection: selection(), subject })
          expect(result.status).toBe("error")
          expect(result.exitCode).toBe(mismatch.verifierExitCode)
          expect(result.summary).toBe("OCI verifier runtime reported a terminal error")
        }
      }),
    ),
  )

  it.effect("rejects output overflow and still completes ordered cleanup", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, { startOutput: Buffer.from("12345") })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(120_000, 4), subject }))

        expect(error.reason).toBe("output-limit")
        expect(cleanups).toBe(1)
        expect(events.indexOf("rm")).toBeLessThan(events.indexOf("subject-cleanup"))
        expect(events.at(-1)).toBe("lease-remove")
      }),
    ),
  )

  it.effect("keeps the subject and lease when exact container cleanup cannot be proven", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, { removeKeepsContainer: true })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++),
          ledger,
        )

        const error = yield* Effect.flip(service.execute({ selection: selection(), subject }))

        expect(error.reason).toBe("cleanup")
        expect(docker.exists()).toBe(true)
        expect(cleanups).toBe(0)
        expect(events).not.toContain("subject-cleanup")
        expect(events).not.toContain("lease-remove")
      }),
    ),
  )

  it.effect("kills by durable ID and removes the subject before reporting timeout", () =>
    withTemporary((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileAccess.Service
        const events: string[] = []
        let cleanups = 0
        const started = yield* Deferred.make<void>()
        const ledger = leaseStore(directory, events)
        const docker = daemon(ledger, events, {
          hangStart: true,
          onStart: () => Deferred.succeed(started, undefined),
        })
        const service = containment(
          docker.runtime,
          fs,
          snapshotService(directory, events, () => cleanups++),
          ledger,
        )
        const fiber = yield* service.execute({ selection: selection(10), subject }).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        yield* TestClock.adjust("11 millis")
        const error = yield* Effect.flip(Fiber.join(fiber))

        expect(error.reason).toBe("timeout")
        expect(docker.exists()).toBe(false)
        expect(cleanups).toBe(1)
        expect(events.indexOf("commit-id")).toBeLessThan(events.indexOf("start"))
        expect(events.indexOf("rm")).toBeLessThan(events.indexOf("subject-cleanup"))
        expect(events.at(-1)).toBe("lease-remove")
      }),
    ),
  )
})
