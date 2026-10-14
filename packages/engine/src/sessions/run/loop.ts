/** Hợp đồng công khai cho một lần drain session V2 bền vững. @module */
export * as SessionRunner from "./loop"

import type { LLMError } from "../../inference/api"
import { Context, Effect } from "effect"
import { Session as SessionSchema } from "../../contracts/session/info"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../errors"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../agents/context/system"
import type { ToolOutputStore } from "../../tools/output-store"
import type { SessionInputOrigin } from "../input/origin"
import type { SessionRunLifecycle } from "./lifecycle"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error
  | SessionInputOrigin.UnavailableError
  | SessionRunLifecycle.RunBusy

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/SessionRunner") {}
