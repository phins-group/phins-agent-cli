import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { Location } from "../../workspace/location"
import { SessionInput } from "../../sessions/input/inbox"
import { SessionInputOrigin } from "../../sessions/input/origin"
import { SessionMessage } from "../../sessions/messages/service"
import { Prompt } from "../../contracts/session/prompt"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionTable } from "../../storage/tables/sessions"
import * as ControlCommand from "./command"
import type { authenticate } from "../identity"

export type Node = Pick<
  Awaited<ReturnType<typeof authenticate>>,
  "identity" | "verifyCommand"
>

export class ReceiverError extends Schema.TaggedErrorClass<ReceiverError>()(
  "NodeControl.ReceiverError",
  { message: Schema.String },
) {}

/** Fresh native proof bound to the actual local target, never cached authority. */
export const verifyPrompt = Effect.fn("NodeControl.verifyPrompt")(function* (
  node: Node,
  input: ControlCommand.Expected,
) {
  const parsed = ControlCommand.Expected.safeParse(input)
  if (!parsed.success)
    return yield* new ReceiverError({
      message: "Invalid expected Node prompt command",
    })
  const expected = parsed.data
  const session = Schema.decodeUnknownExit(SessionSchema.ID)(
    expected.scope.targetSessionId,
  )
  if (session._tag === "Failure")
    return yield* new ReceiverError({ message: "Invalid target Node session" })
  const sessionID = session.value
  const location = yield* Location.Service
  const { db } = yield* Database.Service
  const checkSession = Effect.gen(function* () {
    const row = yield* db
      .select({
        projectID: SessionTable.project_id,
        directory: SessionTable.directory,
        workspaceID: SessionTable.workspace_id,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !row ||
      row.projectID !== expected.scope.projectId ||
      row.directory !== expected.scope.directory ||
      row.workspaceID !== expected.scope.syncWorkspaceId ||
      row.projectID !== location.project.id ||
      row.directory !== location.directory ||
      (row.workspaceID ?? undefined) !== location.workspaceID
    )
      return yield* new ReceiverError({
        message:
          "Node command does not match this project, session or Location",
      })
    return row
  })
  yield* checkSession
  const verified = yield* Effect.tryPromise({
    try: (signal) => node.verifyCommand(expected, signal),
    catch: () =>
      new ReceiverError({
        message: "Node prompt command is unavailable or no longer authorized",
      }),
  })
  const decoded = ControlCommand.Proof.safeParse(verified)
  if (!decoded.success)
    return yield* new ReceiverError({
      message: "Invalid authenticated Node command response",
    })
  const proof = decoded.data
  if (
    proof.id !== expected.id ||
    proof.revision !== expected.revision ||
    !proof.actions.includes("prompt") ||
    !isDeepStrictEqual(proof.scope, expected.scope) ||
    proof.nodeId !== node.identity.nodeId ||
    proof.ownerUserId !== node.identity.userId ||
    proof.workspaceId !== node.identity.workspaceId ||
    proof.loginSessionId !== node.identity.sessionId ||
    !ControlCommand.matches(proof, expected) ||
    Date.parse(proof.expiresAt) <= Date.now()
  )
    return yield* new ReceiverError({
      message: "Authenticated Node command binding is invalid or expired",
    })
  // HTTP may have waited. Check the actual local target again before admission.
  yield* checkSession
  if (Date.parse(proof.expiresAt) <= Date.now())
    return yield* new ReceiverError({
      message: "Node prompt command expired before admission",
    })
  return proof
})

export function promptOrigin(
  proof: ControlCommand.Proof,
  location: Location.Interface,
) {
  return SessionInputOrigin.Origin.make({
    source: proof.scope.source,
    commandID: proof.command.id,
    nodeID: proof.nodeId,
    userID: proof.scope.granteeUserId,
    platformWorkspaceID: proof.workspaceId,
    loginID: proof.loginSessionId,
    projectID: location.project.id,
    location: {
      directory: location.directory,
      ...(location.workspaceID === undefined
        ? {}
        : { workspaceID: location.workspaceID }),
    },
    grantID: proof.id,
    grantRevision: proof.revision,
    attemptID: proof.attempt.leaseId,
    ...(proof.attempt.kind === "tasks"
      ? { attemptKind: "tasks" as const }
      : {}),
    expiresAt: DateTime.makeUnsafe(Date.parse(proof.command.expiresAt)),
  })
}

/** Host-only, record-only receiver. No plain proof/origin/prompt is accepted. */
export const receivePrompt = Effect.fn("NodeControl.receivePrompt")(function* (
  node: Node,
  input: ControlCommand.Expected,
) {
  const proof = yield* verifyPrompt(node, input)
  const location = yield* Location.Service
  const { db } = yield* Database.Service
  const events = yield* EventBus.Service
  return yield* SessionInput.admit(db, events, {
    id: SessionMessage.ID.make(`msg_node_${proof.command.id}`),
    sessionID: SessionSchema.ID.make(proof.scope.targetSessionId),
    prompt: Prompt.make({ text: proof.command.payload.text }),
    delivery: proof.command.delivery,
    origin: promptOrigin(proof, location),
  })
})
