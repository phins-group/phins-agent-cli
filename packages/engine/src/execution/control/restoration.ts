import { and, desc, eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { EventTable } from "../../storage/tables/events"
import { Location } from "../../workspace/location"
import { PermissionOrigin } from "../../security/permissions/origin"
import { SessionInput } from "../../sessions/input/inbox"
import { SessionMessage } from "../../sessions/messages/service"
import { SessionEvent } from "../../contracts/events/session"
import { SessionRunState } from "../../sessions/run/state"
import { Prompt } from "../../contracts/session/prompt"
import { Session as SessionSchema } from "../../contracts/session/info"
import {
  SessionInputOriginTable,
  SessionInputTable,
  SessionMessageTable,
} from "../../storage/tables/sessions"
import * as ControlCommand from "./command"
import { promptOrigin, verifyPrompt, type Node } from "./receiver"

const Target = Schema.Struct({
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
})
const ContinuationTarget = Schema.Struct({
  ...Target.fields,
  runID: SessionRunState.ID,
})
const encodeInput = Schema.encodeSync(SessionInput.Admitted)

export class RestorationError extends Schema.TaggedErrorClass<RestorationError>()(
  "NodeControl.RestorationError",
  { message: Schema.String },
) {}

const unavailable = () =>
  new RestorationError({
    message: "Stored Node prompt is unavailable or no longer authorized",
  })
const denyCause = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause) ? Effect.interrupt : unavailable()

const restore = Effect.fn("NodeControl.restore")(function* (
  node: Node,
  value: typeof Target.Type,
  runID?: SessionRunState.ID,
) {
  const parsed = Schema.decodeUnknownExit(Target, {
    onExcessProperty: "error",
  })(value)
  if (parsed._tag === "Failure") return yield* unavailable()
  const target = Object.freeze({ ...parsed.value })
  const database = yield* Database.Service
  const { db } = database
  const location = yield* Location.Service
  const read = Effect.gen(function* () {
    const input = yield* SessionInput.find(db, target.messageID)
    const origin = input?.origin
    if (
      !input ||
      !origin ||
      input.sessionID !== target.sessionID ||
      (runID === undefined
        ? input.promotedSeq !== undefined
        : input.promotedSeq === undefined) ||
      input.delivery !== "queue" ||
      input.id !== `msg_node_${origin.commandID}` ||
      origin.nodeID !== node.identity.nodeId ||
      origin.platformWorkspaceID !== node.identity.workspaceId ||
      origin.loginID !== node.identity.sessionId ||
      DateTime.toEpochMillis(origin.expiresAt) <= Date.now()
    )
      return yield* unavailable()
    const receipt = yield* db
      .select({
        origin: SessionInputOriginTable,
        prompt: SessionInputTable.prompt,
      })
      .from(SessionInputOriginTable)
      .innerJoin(
        SessionInputTable,
        eq(SessionInputTable.id, SessionInputOriginTable.id),
      )
      .where(eq(SessionInputOriginTable.id, input.id))
      .get()
      .pipe(Effect.orDie)
    if (
      !receipt ||
      receipt.origin.node_id !== origin.nodeID ||
      receipt.origin.command_id !== origin.commandID ||
      receipt.origin.session_id !== input.sessionID ||
      receipt.origin.admitted_seq !== input.admittedSeq ||
      !isDeepStrictEqual(receipt.prompt, { text: input.prompt.text })
    )
      return yield* unavailable()
    if (runID !== undefined) {
      const owner = yield* SessionRunState.load(db, target.sessionID)
      const started = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, target.sessionID),
            eq(
              EventTable.type,
              EventBus.versionedType(SessionEvent.Run.Started.type, 1),
            ),
          ),
        )
        .orderBy(desc(EventTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const promotion = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, target.sessionID),
            eq(EventTable.seq, input.promotedSeq!),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const latest = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, target.sessionID),
            eq(SessionMessageTable.type, "user"),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const data = promotion
        ? Schema.decodeUnknownExit(SessionEvent.OriginPrompted.data, {
            onExcessProperty: "error",
          })(promotion.data)
        : undefined
      const message = latest
        ? Schema.decodeUnknownExit(SessionMessage.User, {
            onExcessProperty: "error",
          })({ ...latest.data, id: latest.id, type: latest.type })
        : undefined
      const binding = started
        ? Schema.decodeUnknownExit(SessionEvent.Run.Started.data, {
            onExcessProperty: "error",
          })(started.data)
        : undefined
      if (
        owner?.runID !== runID ||
        owner.inputID !== target.messageID ||
        (owner.status !== "busy" && owner.status !== "retrying") ||
        binding?._tag !== "Success" ||
        binding.value.sessionID !== target.sessionID ||
        binding.value.runID !== runID ||
        binding.value.inputID !== target.messageID ||
        DateTime.toEpochMillis(binding.value.timestamp) !==
          DateTime.toEpochMillis(owner.time.started) ||
        promotion?.type !==
          EventBus.versionedType(SessionEvent.OriginPrompted.type, 1) ||
        data?._tag !== "Success" ||
        data.value.sessionID !== target.sessionID ||
        data.value.messageID !== target.messageID ||
        DateTime.toEpochMillis(data.value.timestamp) !==
          DateTime.toEpochMillis(input.timeCreated) ||
        !SessionInput.equivalent(input, {
          sessionID: data.value.sessionID,
          prompt: data.value.prompt,
          delivery: data.value.delivery,
          origin: data.value.origin,
        }) ||
        latest?.id !== target.messageID ||
        latest.seq !== input.promotedSeq ||
        message?._tag !== "Success" ||
        message.value.text !== input.prompt.text ||
        message.value.files !== undefined ||
        message.value.agents !== undefined ||
        DateTime.toEpochMillis(message.value.time.created) !==
          DateTime.toEpochMillis(input.timeCreated)
      )
        return yield* unavailable()
    }
    return input
  }).pipe(Effect.catchCause(denyCause))
  const input = yield* read
  const origin = input.origin!
  const expected = ControlCommand.Expected.safeParse({
    id: origin.grantID,
    revision: origin.grantRevision,
    action: "prompt",
    scope: {
      source: origin.source,
      granteeUserId: origin.userID,
      projectId: origin.projectID,
      targetSessionId: target.sessionID,
      directory: origin.location.directory,
      syncWorkspaceId: origin.location.workspaceID ?? null,
    },
    attempt: {
      kind: origin.attemptKind ?? "jobs",
      id: origin.commandID,
      leaseId: origin.attemptID,
    },
  })
  if (!expected.success) return yield* unavailable()
  const snapshot = JSON.stringify(encodeInput(input))
  const verify = Effect.gen(function* () {
    if (JSON.stringify(encodeInput(yield* read)) !== snapshot)
      return yield* unavailable()
    const proof = yield* verifyPrompt(node, expected.data)
    const current = yield* read
    if (
      JSON.stringify(encodeInput(current)) !== snapshot ||
      !SessionInput.equivalent(current, {
        sessionID: target.sessionID,
        prompt: Prompt.make({ text: proof.command.payload.text }),
        delivery: proof.command.delivery,
        origin: promptOrigin(proof, location),
      }) ||
      Date.parse(proof.expiresAt) <= Date.now()
    )
      return yield* unavailable()
    return proof
  }).pipe(
    Effect.provideService(Database.Service, database),
    Effect.provideService(Location.Service, location),
    Effect.catchCause(denyCause),
  )
  const proof = yield* verify
  const constraint: PermissionOrigin.Constraint = Object.freeze({
    sessionID: target.sessionID,
    rules: proof.rules,
    valid: verify.pipe(
      Effect.map((current) => isDeepStrictEqual(current.rules, proof.rules)),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false),
      ),
    ),
  })
  return constraint
})

/** Pending admission only; does not install a scope or dispatch execution. */
export const restorePrompt = Effect.fn("NodeControl.restorePrompt")(
  (node: Node, target: typeof Target.Type) => restore(node, target),
)

/** Restore only the exact active command owner, never the session's local rights. */
export const restoreContinuation = Effect.fn("NodeControl.restoreContinuation")(
  function* (node: Node, value: typeof ContinuationTarget.Type) {
    const parsed = Schema.decodeUnknownExit(ContinuationTarget, {
      onExcessProperty: "error",
    })(value)
    if (parsed._tag === "Failure") return yield* unavailable()
    const { runID, ...target } = parsed.value
    return yield* restore(node, target, runID)
  },
)
