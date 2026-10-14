export * as NodeCommandExecution from "./executor"

import { Context, Effect } from "effect"
import type { SessionExecution } from "../../sessions/run/execution"
import type { NodeCommandRunner } from "./runner"
import type { Node } from "../control/receiver"

export interface Interface {
  /** Negative-only control of an explicitly shared local run. Never a Resume grant. */
  readonly captureLocalInterrupt?: (target: { sessionID: NodeCommandRunner.Target["sessionID"]; runID: NodeCommandRunner.Target["runID"] }) =>
    Effect.Effect<Effect.Effect<boolean> | undefined>
  /** Local host cleanup only. Captures an exact native owner; never a remote Stop grant. */
  readonly captureInterrupt: (
    target: NodeCommandRunner.Target,
  ) => Effect.Effect<
    Effect.Effect<boolean> | undefined,
    SessionExecution.OperationError
  >
  readonly captureOwner: (
    target: NodeCommandRunner.Target,
  ) => Effect.Effect<
    Effect.Effect<boolean> | undefined,
    SessionExecution.OperationError
  >
  /** Prepares and runs only this admitted input in the shared service scope. */
  readonly start: (
    node: Node,
    target: Omit<NodeCommandRunner.Target, "runID">,
    onOwner?: (interrupt: Effect.Effect<boolean>) => void,
    onUserStop?: () => void,
  ) => Effect.Effect<void, SessionExecution.OperationError>
  /** Explicit continuation of the same durable owner, grant and attempt. */
  readonly resume: (
    node: Node,
    target: NodeCommandRunner.Target,
    onOwner?: (interrupt: Effect.Effect<boolean>) => void,
    onUserStop?: () => void,
  ) => Effect.Effect<void, SessionExecution.OperationError>
}

/** Host-only. This service is absent from record-only compatibility layers. */
export class Service extends Context.Service<Service, Interface>()(
  "@phins/NodeCommandExecution",
) {}
