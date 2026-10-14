export * as SessionExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import type { SessionRunner } from "./loop"
import type { Session as SessionSchema } from "../../contracts/session/info"
import type { SessionOperations } from "../actions/operations"
import { OperationUnavailableError } from "../actions/errors"
import type { SessionRunLifecycle } from "./lifecycle"
import type * as SessionCommands from "../actions/commands"

export type Error = SessionRunner.RunError | SessionOperations.Error
export type OperationError = Error | SessionRunLifecycle.RunBusy

export interface Interface {
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, Error>
  /** Schedules a resume in the service scope, without awaiting execution. */
  readonly scheduleResume: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly shell: (input: SessionOperations.ShellInput) => Effect.Effect<void, OperationError>
  readonly skill: (input: SessionOperations.SkillInput) => Effect.Effect<void, OperationError>
  readonly command: (input: SessionCommands.Input) => Effect.Effect<void, OperationError>
  readonly compact: (input: SessionOperations.CompactInput) => Effect.Effect<void, OperationError>
  readonly wait: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: { readonly requested: true },
  ) => Effect.Effect<void>
  /** Exact local owner only; never cancel a remote admission or a successor. */
  readonly captureLocalInterrupt?: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Effect.Effect<boolean> | undefined>
  /** Call only after closing admission; this observes owners, not durable queued input. */
  readonly awaitIdle: Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@phins/v2/SessionExecution") {}

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    resume: () => Effect.void,
    scheduleResume: () => Effect.void,
    wake: () => Effect.void,
    shell: () => Effect.fail(new OperationUnavailableError({ operation: "shell" })),
    skill: () => Effect.fail(new OperationUnavailableError({ operation: "skill" })),
    command: () => Effect.fail(new OperationUnavailableError({ operation: "command" })),
    compact: () => Effect.fail(new OperationUnavailableError({ operation: "compact" })),
    wait: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: Effect.void,
  }),
)
