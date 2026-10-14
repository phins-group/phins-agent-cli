export * as VerifierOciRuntime from "./runtime"

import path from "node:path"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ProcessRunner } from "../../execution/process/runner"
import { AbsolutePath } from "../../shared/schema"
import { TrustedFile } from "../trusted-file"

const PROBE_OUTPUT_BYTES = 64 * 1_024
const DEFAULT_DOCKER_ENDPOINT = "unix:///var/run/docker.sock"
const EMPTY_DOCKER_HOME = "/var/empty"
const EMPTY_DOCKER_CONFIG = `${EMPTY_DOCKER_HOME}/phins-verifier-docker`
const RUNTIME_PATH = "/usr/bin:/bin"
const MAX_RUNTIME_BINARY_BYTES = 256 * 1024 * 1024

export const ENV = Object.freeze({
  kind: "PHINS_VERIFIER_OCI_RUNTIME_KIND",
  binary: "PHINS_VERIFIER_OCI_RUNTIME",
  required: "PHINS_VERIFIER_OCI_REQUIRED",
})

export const ErrorReason = Schema.Literals([
  "configuration",
  "probe",
  "process",
  "identity",
])
export type ErrorReason = typeof ErrorReason.Type

export class Error extends Schema.TaggedErrorClass<Error>()(
  "VerifierOciRuntime.Error",
  {
    reason: ErrorReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface RunOptions {
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly timeout?: Duration.Input
}

export interface Backend {
  readonly kind: "docker"
  readonly binary: AbsolutePath
  /** Boot-observed digest and metadata identity; test backends may omit it. */
  readonly binaryIdentity?: BinaryIdentity
  /** Pinned local Unix endpoint for production backends; test backends may omit it. */
  readonly endpoint?: string
  readonly run: (
    args: readonly string[],
    options?: RunOptions,
  ) => Effect.Effect<ProcessRunner.RunResult, Error>
}

export interface BinaryIdentity extends TrustedFile.Identity {
  readonly digest: `sha256:${string}`
}

export interface Interface {
  readonly backend?: Backend
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/VerifierOciRuntime",
) {}

export interface EnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly probe?: (backend: Backend) => Effect.Effect<void, Error>
}

const runtimeEnvironment = (
  endpoint: string,
): Readonly<Record<string, string>> =>
  Object.freeze({
    LANG: "C",
    LC_ALL: "C",
    DOCKER_HOST: endpoint,
    DOCKER_CONFIG: EMPTY_DOCKER_CONFIG,
    HOME: EMPTY_DOCKER_HOME,
    PATH: RUNTIME_PATH,
  })

export interface BackendOptions {
  readonly endpoint?: string
  readonly binaryIdentity?: BinaryIdentity
}

/** Construct a backend; production callers pin identity through loadFromEnvironment. */
export const makeBackend = (
  binary: AbsolutePath,
  proc: ProcessRunner.Interface,
  backendOptions: BackendOptions = {},
): Backend => {
  const endpoint = backendOptions.endpoint ?? DEFAULT_DOCKER_ENDPOINT
  const binaryIdentity = backendOptions.binaryIdentity
  const environment = runtimeEnvironment(endpoint)
  return Object.freeze({
    kind: "docker" as const,
    binary,
    binaryIdentity,
    endpoint,
    run: (args: readonly string[], runOptions?: RunOptions) =>
      (binaryIdentity
        ? Effect.tryPromise({
            try: async () => {
              await TrustedFile.assertOutsideProcessUserControl(binary)
              await TrustedFile.assertUnchanged(binary, binaryIdentity)
            },
            catch: (cause) =>
              new Error({
                reason: "identity",
                message:
                  "OCI runtime path control or identity changed after boot",
                cause,
              }),
          })
        : Effect.void
      ).pipe(
        Effect.flatMap(() =>
          proc
            .run(
              ChildProcess.make(binary, [...args], {
                detached: process.platform !== "win32",
                env: environment,
                extendEnv: false,
                forceKillAfter: Duration.seconds(2),
                stdin: "ignore",
              }),
              {
                maxOutputBytes: runOptions?.maxOutputBytes,
                maxErrorBytes: runOptions?.maxErrorBytes,
                timeout: runOptions?.timeout,
              },
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new Error({
                    reason: "process",
                    message: "OCI runtime process failed",
                    cause,
                  }),
              ),
            ),
        ),
      ),
  })
}

const dockerEndpoint = (env: Readonly<Record<string, string | undefined>>) => {
  const endpoint = env.DOCKER_HOST ?? DEFAULT_DOCKER_ENDPOINT
  if (!endpoint.startsWith("unix://")) return undefined
  const socket = endpoint.slice("unix://".length)
  if (
    /[\0\r\n]/.test(socket) ||
    !path.isAbsolute(socket) ||
    path.resolve(socket) !== socket ||
    path.normalize(socket) !== socket
  )
    return undefined
  return endpoint
}

const defaultProbe = (backend: Backend) =>
  backend
    .run(["version"], {
      maxOutputBytes: PROBE_OUTPUT_BYTES,
      maxErrorBytes: PROBE_OUTPUT_BYTES,
      timeout: Duration.seconds(10),
    })
    .pipe(
      Effect.flatMap((result) => {
        if (
          result.exitCode === 0 &&
          !result.stdoutTruncated &&
          !result.stderrTruncated
        )
          return Effect.void
        return Effect.fail(
          new Error({
            reason: "probe",
            message:
              "Configured OCI runtime is unavailable or returned excessive probe output",
          }),
        )
      }),
      Effect.mapError((cause) =>
        cause.reason === "probe"
          ? cause
          : new Error({
              reason: "probe",
              message: "Configured OCI runtime probe failed",
              cause,
            }),
      ),
    )

export const loadFromEnvironment = Effect.fn(
  "VerifierOciRuntime.loadFromEnvironment",
)(function* (options: EnvironmentOptions = {}) {
  const env = options.env ?? process.env
  const kind = env[ENV.kind]
  const binaryText = env[ENV.binary]
  const required = env[ENV.required]
  if (required !== undefined && required !== "1")
    return yield* new Error({
      reason: "configuration",
      message: `${ENV.required} must be unset or exactly 1`,
    })

  const configured = [kind, binaryText].filter(
    (value) => value !== undefined,
  ).length
  if (configured === 0) {
    if (required === "1")
      return yield* new Error({
        reason: "configuration",
        message: "OCI verifier containment is required but is not configured",
      })
    return Service.of({})
  }
  if (configured !== 2 || !kind || !binaryText)
    return yield* new Error({
      reason: "configuration",
      message:
        "OCI verifier containment requires both runtime kind and runtime path",
    })
  if (kind !== "docker")
    return yield* new Error({
      reason: "configuration",
      message: "Only the supported docker OCI runtime is accepted",
    })
  const endpoint = dockerEndpoint(env)
  if (!endpoint)
    return yield* new Error({
      reason: "configuration",
      message:
        "Docker containment requires a local absolute unix:// DOCKER_HOST",
    })
  if (
    !path.isAbsolute(binaryText) ||
    /[\0\r\n]/.test(binaryText) ||
    path.resolve(binaryText) !== binaryText ||
    path.normalize(binaryText) !== binaryText
  )
    return yield* new Error({
      reason: "configuration",
      message: "OCI runtime path must be absolute and normalized",
    })

  yield* Effect.tryPromise({
    try: () => TrustedFile.assertOutsideProcessUserControl(binaryText),
    catch: (cause) =>
      new Error({
        reason: "configuration",
        message:
          "OCI runtime path must not be owned or writable by the process user",
        cause,
      }),
  })
  const observed = yield* Effect.tryPromise({
    try: () => TrustedFile.digest(binaryText, MAX_RUNTIME_BINARY_BYTES),
    catch: (cause) =>
      new Error({
        reason: "configuration",
        message: "Failed to securely inspect OCI runtime path",
        cause,
      }),
  })
  if ((BigInt(observed.identity.mode) & 0o111n) === 0n)
    return yield* new Error({
      reason: "configuration",
      message: "OCI runtime path must be executable",
    })
  if (observed.prefix[0] === 0x23 && observed.prefix[1] === 0x21)
    return yield* new Error({
      reason: "configuration",
      message: "OCI runtime path must not be a shebang script",
    })

  const binaryIdentity: BinaryIdentity = Object.freeze({
    ...observed.identity,
    digest: observed.digest,
  })

  const backend = makeBackend(
    AbsolutePath.make(binaryText),
    yield* ProcessRunner.Service,
    {
      endpoint,
      binaryIdentity,
    },
  )
  yield* (options.probe ?? defaultProbe)(backend)
  return Service.of({ backend })
})

export const layer = (options: EnvironmentOptions = {}) =>
  Layer.effect(Service, loadFromEnvironment(options))

export const defaultLayer = Layer.effect(
  Service,
  loadFromEnvironment().pipe(Effect.orDie),
).pipe(Layer.provide(ProcessRunner.defaultLayer))
