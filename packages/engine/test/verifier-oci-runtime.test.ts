import { describe, expect } from "bun:test"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProcessRunner } from "../src/execution/process/runner"
import { AbsolutePath } from "../src/shared/schema"
import { VerifierOciRuntime } from "../src/verification/oci/runtime"
import { TrustedFile } from "../src/verification/trusted-file"
import { testEffect } from "./lib/effect"

const it = testEffect(ProcessRunner.defaultLayer)

describe("VerifierOciRuntime", () => {
  it.effect(
    "is explicitly unavailable when OCI containment is not configured",
    () =>
      Effect.gen(function* () {
        const runtime = yield* VerifierOciRuntime.loadFromEnvironment({
          env: {},
        })
        expect(runtime.backend).toBeUndefined()
      }),
  )

  it.effect("loads one canonical runtime outside process-user control", () =>
    Effect.gen(function* () {
      const binary = yield* Effect.promise(() => realpath("/usr/bin/true"))
      let probes = 0
      const runtime = yield* VerifierOciRuntime.loadFromEnvironment({
        env: {
          [VerifierOciRuntime.ENV.kind]: "docker",
          [VerifierOciRuntime.ENV.binary]: binary,
          [VerifierOciRuntime.ENV.required]: "1",
        },
        probe: (backend) =>
          Effect.sync(() => {
            probes++
            expect(backend.kind).toBe("docker")
            expect(backend.binary).toBe(AbsolutePath.make(binary))
            expect(backend.endpoint).toBe("unix:///var/run/docker.sock")
            expect(backend.binaryIdentity?.digest).toMatch(
              /^sha256:[a-f0-9]{64}$/,
            )
          }),
      })

      expect(probes).toBe(1)
      expect(runtime.backend?.kind).toBe("docker")
      expect(Object.isFrozen(runtime.backend)).toBe(true)
      const result = yield* runtime.backend!.run(["--version"])
      expect(result.exitCode).toBe(0)
    }),
  )

  it.effect(
    "does not inherit arbitrary host secrets into runtime subprocesses",
    () =>
      Effect.gen(function* () {
        const secretName = "PHINS_VERIFIER_RUNTIME_SECRET_CANARY"
        const previous = process.env[secretName]
        process.env[secretName] = "must-not-cross-runtime-boundary"
        const proc = yield* ProcessRunner.Service
        const backend = VerifierOciRuntime.makeBackend(
          AbsolutePath.make(process.execPath),
          proc,
        )
        const result = yield* backend
          .run(["--eval", "process.stdout.write(JSON.stringify(process.env))"])
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) delete process.env[secretName]
                else process.env[secretName] = previous
              }),
            ),
          )
        const childEnvironment = JSON.parse(
          result.stdout.toString("utf8"),
        ) as Record<string, string>

        expect(result.exitCode).toBe(0)
        expect(childEnvironment[secretName]).toBeUndefined()
        expect(childEnvironment.LANG).toBe("C")
        expect(childEnvironment.LC_ALL).toBe("C")
        expect(childEnvironment.DOCKER_HOST).toBe("unix:///var/run/docker.sock")
        expect(childEnvironment.DOCKER_CONFIG).toBe(
          "/var/empty/phins-verifier-docker",
        )
        expect(childEnvironment.HOME).toBe("/var/empty")
        expect(childEnvironment.PATH).toBe("/usr/bin:/bin")
        expect(childEnvironment.DOCKER_CONTEXT).toBeUndefined()
        expect(childEnvironment.DOCKER_TLS_VERIFY).toBeUndefined()
      }),
  )

  it.effect(
    "rejects required, partial, relative, and unsupported runtime configuration",
    () =>
      Effect.gen(function* () {
        const invalid = [
          { [VerifierOciRuntime.ENV.required]: "0" },
          { [VerifierOciRuntime.ENV.required]: "1" },
          { [VerifierOciRuntime.ENV.kind]: "docker" },
          {
            [VerifierOciRuntime.ENV.kind]: "docker",
            [VerifierOciRuntime.ENV.binary]: "docker",
          },
          {
            [VerifierOciRuntime.ENV.kind]: "podman",
            [VerifierOciRuntime.ENV.binary]: process.execPath,
          },
          {
            [VerifierOciRuntime.ENV.kind]: "docker",
            [VerifierOciRuntime.ENV.binary]: process.execPath,
            DOCKER_HOST: "tcp://remote.example:2376",
          },
          {
            [VerifierOciRuntime.ENV.kind]: "docker",
            [VerifierOciRuntime.ENV.binary]: process.execPath,
            DOCKER_HOST: "unix:///var/run/../run/docker.sock",
          },
          {
            [VerifierOciRuntime.ENV.kind]: "docker",
            [VerifierOciRuntime.ENV.binary]:
              `${process.execPath}${path.sep}..${path.sep}${path.basename(process.execPath)}`,
          },
        ]

        for (const env of invalid) {
          const error = yield* Effect.flip(
            VerifierOciRuntime.loadFromEnvironment({
              env,
              probe: () => Effect.void,
            }),
          )
          expect(error).toBeInstanceOf(VerifierOciRuntime.Error)
          expect(error.reason).toBe("configuration")
        }
      }),
  )

  it.effect(
    "rejects symlinked, process-owned, and non-executable runtime files",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(async () =>
          realpath(
            await mkdtemp(path.join(os.tmpdir(), "phins-oci-runtime-secure-")),
          ),
        ),
        (directory) =>
          Effect.gen(function* () {
            const canonicalBinary = yield* Effect.promise(() =>
              realpath(process.execPath),
            )
            const alias = path.join(directory, "docker-link")
            const inert = path.join(directory, "docker-inert")
            const nonExecutable = yield* Effect.promise(() =>
              realpath("/etc/hosts"),
            )
            yield* Effect.promise(() => symlink(canonicalBinary, alias))
            yield* Effect.promise(() => writeFile(inert, "not executable"))

            for (const binary of [alias, inert, nonExecutable]) {
              const error = yield* Effect.flip(
                VerifierOciRuntime.loadFromEnvironment({
                  env: {
                    [VerifierOciRuntime.ENV.kind]: "docker",
                    [VerifierOciRuntime.ENV.binary]: binary,
                  },
                  probe: () => Effect.void,
                }),
              )
              expect(error.reason).toBe("configuration")
            }
          }),
        (directory) =>
          Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
  )

  it.effect(
    "refuses process-controlled paths and mismatched boot identity",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(async () =>
          realpath(
            await mkdtemp(
              path.join(os.tmpdir(), "phins-oci-runtime-identity-"),
            ),
          ),
        ),
        (directory) =>
          Effect.gen(function* () {
            const controlledBinary = path.join(directory, "docker")
            yield* Effect.promise(() =>
              writeFile(controlledBinary, "runtime-placeholder", {
                mode: 0o700,
              }),
            )
            const controlledObserved = yield* Effect.promise(() =>
              TrustedFile.digest(controlledBinary, 1_024),
            )
            const proc = yield* ProcessRunner.Service
            const controlled = VerifierOciRuntime.makeBackend(
              AbsolutePath.make(controlledBinary),
              proc,
              {
                binaryIdentity: Object.freeze({
                  ...controlledObserved.identity,
                  digest: controlledObserved.digest,
                }),
              },
            )
            const controlledFailure = yield* Effect.flip(
              controlled.run(["version"]),
            )
            expect(controlledFailure.reason).toBe("identity")

            const systemBinary = yield* Effect.promise(() =>
              realpath("/usr/bin/true"),
            )
            const systemObserved = yield* Effect.promise(() =>
              TrustedFile.digest(systemBinary, 1_024 * 1_024),
            )
            const mismatched = VerifierOciRuntime.makeBackend(
              AbsolutePath.make(systemBinary),
              proc,
              {
                binaryIdentity: Object.freeze({
                  ...systemObserved.identity,
                  size: (BigInt(systemObserved.identity.size) + 1n).toString(
                    10,
                  ),
                  digest: systemObserved.digest,
                }),
              },
            )
            const mismatchFailure = yield* Effect.flip(
              mismatched.run(["version"]),
            )
            expect(mismatchFailure.reason).toBe("identity")
          }),
        (directory) =>
          Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
  )
})
