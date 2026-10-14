export * as NodeCommandRunner from "./runner"

import { Context, Effect, Schema } from "effect"
import { SessionMessage } from "../../sessions/messages/service"
import { SessionRunState } from "../../sessions/run/state"
import { Session as SessionSchema } from "../../contracts/session/info"
import type { SessionRunner } from "../../sessions/run/loop"
import type { Node } from "../control/receiver"
import type { RestorationError } from "../control/restoration"

export const Target = Schema.Struct({
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
  runID: SessionRunState.ID,
})
export type Target = typeof Target.Type
export type Error = SessionRunner.RunError | RestorationError

/** Internal native-host seam. Never a body-controlled Session API method. */
export interface Interface {
  readonly run: (node: Node, target: Target) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/NodeCommandRunner",
) {}
