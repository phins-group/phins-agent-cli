import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { VerificationReceipt } from "../src/contracts/execution/verification-receipt"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
} from "effect"
import { FileAccess } from "../src/workspace/files/access"
import { ProcessRunner } from "../src/execution/process/runner"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { Hash } from "../src/shared/hash"
import { VerifierOciContainment } from "../src/verification/oci/containment"
import { VerifierOciLease } from "../src/verification/oci/lease"
import { VerifierOciRuntime } from "../src/verification/oci/runtime"
import { VerifierOciSupervisor } from "../src/verification/oci/supervisor"
import { VerifierRegistry } from "../src/verification/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const enabled = process.env.PHINS_TEST_DOCKER_OCI === "1"
const it = testEffect(
  Layer.mergeAll(FileAccess.defaultLayer, ProcessRunner.defaultLayer),
)

const imageReference = () => {
  const value = process.env.PHINS_TEST_DOCKER_IMAGE
  if (
    !value ||
    value !== value.toLowerCase() ||
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error(
      "PHINS_TEST_DOCKER_IMAGE must be a lowercase immutable image reference",
    )
  }
  return value
}

const dockerBinary = async () => {
  const configured = process.env.PHINS_TEST_DOCKER_BINARY
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("PHINS_TEST_DOCKER_BINARY must be an absolute path")
  }
  const real = await fs.realpath(configured)
  if (real !== configured) {
    throw new Error("PHINS_TEST_DOCKER_BINARY must be canonical")
  }
  return AbsolutePath.make(real)
}

const executionIdentifier = (scenario: "success" | "cancellation") => {
  const value = process.env.PHINS_TEST_DOCKER_EXECUTION_ID
  const identifier = `${value}:${scenario}`
  if (
    !value ||
    value.length === 0 ||
    identifier.length > 256 ||
    /[^A-Za-z0-9_.:-]/.test(identifier)
  ) {
    throw new Error(
      "PHINS_TEST_DOCKER_EXECUTION_ID must be unique and canonical",
    )
  }
  return VerificationReceipt.ID.make(identifier)
}

const withTemporary = <A, E, R>(
  use: (directory: AbsolutePath) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (temporary) => use(AbsolutePath.make(temporary.path)),
    (temporary) => Effect.promise(() => temporary[Symbol.asyncDispose]()),
  )

const snapshotService = (
  projectRoot: AbsolutePath,
  expected: Snapshot.ID,
  onCleanup: () => void,
) =>
  Snapshot.Service.of({
    capture: () => Effect.succeed(expected),
    captureVerification: () => Effect.succeed(expected),
    captureObservation: () => Effect.succeed(expected),
    retain: (requested) =>
      requested === expected
        ? Effect.void
        : Effect.die("Unexpected snapshot retention target"),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    materialize: () => Effect.die("Docker integration requires materializeAt"),
    materializeAt: (requested, destination) =>
      Effect.promise(async () => {
        if (requested !== expected) throw new Error("Unexpected snapshot")
        await fs.mkdir(destination, { mode: 0o700 })
        await fs.writeFile(
          path.join(destination, "input.txt"),
          "immutable-subject\n",
          { mode: 0o600 },
        )
        return {
          directory: destination,
          projectRoot,
          snapshot: requested,
          cleanup: Effect.promise(async () => {
            await fs.rm(destination, { recursive: true })
            onCleanup()
          }),
        }
      }),
  })

const testContainerIDs = (
  runtime: VerifierOciRuntime.Backend,
  executionHash: string,
) =>
  Effect.gen(function* () {
    const listed = yield* runtime.run(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--quiet",
        "--filter",
        `label=${VerifierOciSupervisor.LABEL.managed}=${VerifierOciSupervisor.PROFILE}`,
        "--filter",
        `label=${VerifierOciSupervisor.LABEL.execution}=${executionHash}`,
      ],
      {
        maxOutputBytes: 64 * 1_024,
        maxErrorBytes: 64 * 1_024,
        timeout: Duration.seconds(10),
      },
    )
    if (
      listed.exitCode !== 0 ||
      listed.stdoutTruncated ||
      listed.stderrTruncated
    ) {
      return yield* Effect.die("Failed to list Docker integration containers")
    }
    if (listed.stdout.length === 0) return [] as string[]
    const text = listed.stdout.toString("utf8")
    if (!text.endsWith("\n") || /[\0\r]/.test(text)) {
      return yield* Effect.die("Docker returned a non-canonical container list")
    }
    const ids = text.slice(0, -1).split("\n")
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
    ) {
      return yield* Effect.die("Docker returned an unsafe container ID")
    }
    return ids
  })

const cleanupTestContainers = (
  runtime: VerifierOciRuntime.Backend,
  executionHash: string,
) =>
  Effect.gen(function* () {
    for (const containerID of yield* testContainerIDs(runtime, executionHash)) {
      const removed = yield* runtime.run(
        ["container", "rm", "--force", containerID],
        {
          maxOutputBytes: 64 * 1_024,
          maxErrorBytes: 64 * 1_024,
          timeout: Duration.seconds(10),
        },
      )
      if (
        removed.exitCode !== 0 ||
        removed.stdoutTruncated ||
        removed.stderrTruncated
      ) {
        return yield* Effect.die(
          "Failed to clean a Docker integration container",
        )
      }
    }
  })

interface DockerFixture {
  readonly runtime: VerifierOciRuntime.Backend
  readonly leases: VerifierOciLease.Interface
  readonly supervisor: VerifierOciSupervisor.Interface
  readonly snapshots: Snapshot.Interface
  readonly fs: FileAccess.Interface
  readonly temporary: AbsolutePath
  readonly projectRoot: AbsolutePath
  readonly projectRootIdentity: VerifierRegistry.ProjectRootIdentity
  readonly snapshot: Snapshot.ID
  readonly projectID: ProjectRegistry.ID
  readonly executionID: VerificationReceipt.ID
  readonly executionHash: string
  readonly image: string
  readonly bundleDigest: string
  readonly cleanups: () => number
}

const withDockerFixture = <A, E, R>(
  scenario: "success" | "cancellation",
  use: (fixture: DockerFixture) => Effect.Effect<A, E, R>,
) =>
  withTemporary((root) =>
    Effect.gen(function* () {
      const image = imageReference()
      const marker = image.lastIndexOf("@sha256:")
      const bundleDigest = image.slice(marker + 1)
      const state = AbsolutePath.make(path.join(root, "state"))
      const temporary = AbsolutePath.make(path.join(root, "tmp"))
      const projectRoot = AbsolutePath.make(path.join(root, "project"))
      yield* Effect.promise(() =>
        Promise.all(
          [state, temporary, projectRoot].map((directory) =>
            fs.mkdir(directory, { mode: 0o700 }),
          ),
        ),
      )

      const binary = yield* Effect.promise(dockerBinary)
      const runtimeService = yield* VerifierOciRuntime.loadFromEnvironment({
        env: {
          [VerifierOciRuntime.ENV.kind]: "docker",
          [VerifierOciRuntime.ENV.binary]: binary,
          [VerifierOciRuntime.ENV.required]: "1",
        },
      })
      const runtime = runtimeService.backend
      if (!runtime?.binaryIdentity)
        return yield* Effect.die(
          "Docker integration did not pin the production runtime identity",
        )
      const leases = VerifierOciLease.make({ state, tmp: temporary })
      const supervisor = VerifierOciSupervisor.make({ runtime, leases })
      const snapshot = Snapshot.ID.make("a".repeat(40))
      const projectID = ProjectRegistry.ID.make("project_oci_docker_integration")
      const projectRootIdentity = yield* VerifierRegistry.inspectProjectRoot(
        projectRoot,
      )
      const executionID = executionIdentifier(scenario)
      const executionHash = `sha256:${Hash.sha256(executionID)}`
      let cleanups = 0
      const fileSystem = yield* FileAccess.Service
      const snapshots = snapshotService(projectRoot, snapshot, () => cleanups++)

      return yield* use({
        runtime,
        leases,
        supervisor,
        snapshots,
        fs: fileSystem,
        temporary,
        projectRoot,
        projectRootIdentity,
        snapshot,
        projectID,
        executionID,
        executionHash,
        image,
        bundleDigest,
        cleanups: () => cleanups,
      }).pipe(
        Effect.ensuring(
          cleanupTestContainers(runtime, executionHash).pipe(Effect.orDie),
        ),
      )
    }),
  )

const selectionFor = (
  fixture: DockerFixture,
  input: {
    readonly id: string
    readonly checkID: string
    readonly argv: readonly [string, ...string[]]
    readonly timeoutMs: number
  },
) =>
  VerifierRegistry.pin(
    {
      id: input.id,
      version: "1",
      source: "policy",
      check: {
        id: input.checkID,
        argv: input.argv,
        cwd: ".",
        timeoutMs: input.timeoutMs,
        maxOutputBytes: 16_384,
      },
      executor: {
        id: VerifierOciContainment.EXECUTOR_ID,
        version: VerifierOciContainment.EXECUTOR_VERSION,
        bundleDigest: fixture.bundleDigest,
        oci: {
          reference: fixture.image,
          platform: "linux/amd64",
        },
      },
      containment: {
        subject: "snapshot-copy",
        filesystem: "read-only",
        network: "network-deny",
        environment: "sanitized-env",
        profile: VerifierOciContainment.PROFILE,
      },
    },
    {
      projectID: fixture.projectID,
      projectRoot: fixture.projectRoot,
      projectRootIdentity: fixture.projectRootIdentity,
    },
    {
      kind: "signed-policy",
      authorityID: "oci-docker-integration",
      keyID: `sha256:${"b".repeat(64)}`,
      revision: 1,
      policyDigest: `sha256:${"c".repeat(64)}`,
    },
  )

const executeInput = (
  fixture: DockerFixture,
  selection: VerifierRegistry.Selection,
  location: string,
) => ({
  selection,
  subject: {
    executionID: fixture.executionID,
    snapshot: fixture.snapshot,
    projectID: fixture.projectID,
    locationKey: VerificationReceipt.LocationKey.make(location),
  },
})

const integration = () =>
  withDockerFixture("success", (fixture) =>
    Effect.gen(function* () {
      const selection = selectionFor(fixture, {
        id: "oci-docker-integration",
        checkID: "read-only-subject",
        argv: [
          "/bin/sh",
          "-ceu",
          [
            'test "$(cat input.txt)" = immutable-subject',
            "if touch write-probe 2>/dev/null; then exit 40; fi",
            "printf '%s\\n' core-docker-ok",
          ].join("\n"),
        ],
        timeoutMs: 30_000,
      })
      const service = VerifierOciContainment.make({
        runtime: fixture.runtime,
        fs: fixture.fs,
        snapshots: fixture.snapshots,
        supervisor: fixture.supervisor,
        inspectProjectRoot: VerifierRegistry.inspectProjectRoot,
      })
      const result = yield* service.execute(
        executeInput(fixture, selection, "location_oci_docker_integration"),
      )

      expect(result.status).toBe("passed")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("core-docker-ok\n")
      expect(result.stderr).toBe("")
      expect(fixture.runtime.binaryIdentity?.digest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      )
      expect(fixture.cleanups()).toBe(1)
      expect(yield* fixture.leases.readAll()).toEqual([])
      expect(
        yield* Effect.promise(() =>
          fs.readdir(
            path.join(fixture.temporary, "verifier-oci", "v1", "subjects"),
          ),
        ),
      ).toEqual([])
      expect(
        yield* testContainerIDs(fixture.runtime, fixture.executionHash),
      ).toEqual([])
    }),
  )

class ContainerNotReady {
  readonly _tag = "ContainerNotReady"
}

const cancellationIntegration = () =>
  withDockerFixture("cancellation", (fixture) =>
    Effect.gen(function* () {
      const startIssued = yield* Deferred.make<void>()
      const calls: string[][] = []
      const runtime: VerifierOciRuntime.Backend = Object.freeze({
        ...fixture.runtime,
        run: (
          args: readonly string[],
          options?: VerifierOciRuntime.RunOptions,
        ) =>
          Effect.gen(function* () {
            calls.push([...args])
            if (
              args[0] === "container" &&
              args[1] === "start" &&
              args[2] === "--attach"
            ) {
              yield* Deferred.succeed(startIssued, undefined)
            }
            return yield* fixture.runtime.run(args, options)
          }),
      })
      const supervisor = VerifierOciSupervisor.make({
        runtime,
        leases: fixture.leases,
      })
      const service = VerifierOciContainment.make({
        runtime,
        fs: fixture.fs,
        snapshots: fixture.snapshots,
        supervisor,
        inspectProjectRoot: VerifierRegistry.inspectProjectRoot,
      })
      const selection = selectionFor(fixture, {
        id: "oci-docker-cancellation-integration",
        checkID: "interrupt-long-running-container",
        argv: [
          "/bin/sh",
          "-ceu",
          [
            'test "$(cat input.txt)" = immutable-subject',
            "exec sleep 300",
          ].join("\n"),
        ],
        timeoutMs: 90_000,
      })

      yield* Effect.acquireUseRelease(
        service
          .execute(
            executeInput(
              fixture,
              selection,
              "location_oci_docker_cancellation",
            ),
          )
          .pipe(Effect.forkChild),
        (fiber) =>
          Effect.gen(function* () {
            yield* Effect.race(
              Deferred.await(startIssued),
              Fiber.await(fiber).pipe(
                Effect.flatMap(() =>
                  Effect.die("Docker containment exited before issuing start"),
                ),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(15),
                orElse: () =>
                  Effect.die("Docker containment did not issue start"),
              }),
            )

            const running = yield* Effect.gen(function* () {
              const leases = yield* fixture.leases.readAll()
              if (leases.length === 0 || !leases[0]?.containerID) {
                return yield* Effect.fail(new ContainerNotReady())
              }
              if (leases.length !== 1) {
                return yield* Effect.die(
                  "Docker cancellation observed multiple leases",
                )
              }
              const container = yield* supervisor.inspect(leases[0].containerID)
              if (!container) {
                return yield* Effect.die(
                  "Docker cancellation container disappeared",
                )
              }
              if (
                container.state.status === "created" &&
                !container.state.running
              ) {
                return yield* Effect.fail(new ContainerNotReady())
              }
              if (
                container.state.status !== "running" ||
                !container.state.running
              ) {
                return yield* Effect.die(
                  "Docker cancellation container never reached running",
                )
              }
              return container
            }).pipe(
              Effect.retry({
                while: (error) => error instanceof ContainerNotReady,
                schedule: Schedule.spaced(Duration.millis(50)),
              }),
              Effect.timeoutOrElse({
                duration: Duration.seconds(15),
                orElse: () =>
                  Effect.die("Docker container never became running"),
              }),
            )

            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            ).toBe(true)
            expect(
              calls.filter(
                (args) => args[0] === "container" && args[1] === "rm",
              ),
            ).toEqual([["container", "rm", "--force", running.id]])
            expect(yield* supervisor.inspect(running.id)).toBeUndefined()
            expect(fixture.cleanups()).toBe(1)
            expect(yield* fixture.leases.readAll()).toEqual([])
            expect(
              yield* Effect.promise(() =>
                fs.readdir(
                  path.join(
                    fixture.temporary,
                    "verifier-oci",
                    "v1",
                    "subjects",
                  ),
                ),
              ),
            ).toEqual([])
            expect(
              yield* testContainerIDs(fixture.runtime, fixture.executionHash),
            ).toEqual([])
          }),
        (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      )
    }),
  )

if (enabled) {
  it.live(
    "runs the Core containment, durable lease, and cleanup against Docker",
    integration,
    120_000,
  )
  it.live(
    "interrupts a running Docker verifier and completes exact cleanup",
    cancellationIntegration,
    120_000,
  )
} else {
  it.live.skip(
    "runs the Core containment, durable lease, and cleanup against Docker",
    Effect.void,
  )
  it.live.skip(
    "interrupts a running Docker verifier and completes exact cleanup",
    Effect.void,
  )
}
