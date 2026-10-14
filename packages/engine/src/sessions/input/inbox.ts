export * as SessionInput from "./inbox"

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Admitted, Delivery } from "../../contracts/session/input"
import type { Database } from "../../storage/database"
import type { EventBus } from "../../runtime/events/bus"
import { SessionEvent } from "../../contracts/events/session"
import { SessionMessage } from "../messages/service"
import { Prompt } from "../../contracts/session/prompt"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionInputTable, SessionInputOriginTable, SessionMessageTable, SessionTable } from "../../storage/tables/sessions"
import { SessionInputOrigin } from "./origin"
import { isDefaultTitle, titleFromPrompt } from "../title"

type DatabaseService = Database.Interface["db"]

export { Admitted, Delivery }

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodeOrigin = Schema.decodeUnknownSync(SessionInputOrigin.Origin, {
  onExcessProperty: "error",
})
const validateOrigin = Schema.decodeUnknownSync(Schema.toType(SessionInputOrigin.Origin), {
  onExcessProperty: "error",
})
const encodeOrigin = Schema.encodeSync(SessionInputOrigin.Origin)

const fromRow = (
  row: typeof SessionInputTable.$inferSelect,
  origin?: typeof SessionInputOriginTable.$inferSelect,
): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
    ...(origin === undefined ? {} : { origin: decodeOrigin(origin.origin) }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db
    .select({ input: SessionInputTable, origin: SessionInputOriginTable })
    .from(SessionInputTable)
    .leftJoin(SessionInputOriginTable, eq(SessionInputOriginTable.id, SessionInputTable.id))
    .where(eq(SessionInputTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (
    row?.origin &&
    (row.origin.session_id !== row.input.session_id ||
      row.origin.admitted_seq !== row.input.admitted_seq ||
      row.origin.node_id !== row.origin.origin.nodeID ||
      row.origin.command_id !== row.origin.origin.commandID)
  )
    return yield* Effect.die(new InputLifecycleConflict({ id }))
  return row === undefined ? undefined : fromRow(row.input, row.origin ?? undefined)
})

export class InputLifecycleConflict extends Schema.TaggedErrorClass<InputLifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    /** Host-only provenance. This field is never accepted by the public prompt API. */
    readonly origin?: SessionInputOrigin.Origin
  },
) {
  const origin = input.origin === undefined ? undefined : decodeOrigin(encodeOrigin(validateOrigin(input.origin)))
  const prompt =
    origin === undefined ? input.prompt : decodePrompt(JSON.parse(JSON.stringify(encodePrompt(input.prompt))))
  const captured = {
    id: input.id,
    sessionID: input.sessionID,
    delivery: input.delivery,
    prompt,
    origin,
  }
  if (origin === undefined) yield* SessionInputOrigin.requireLocalCaller(db, captured.sessionID)
  const existing = yield* find(db, captured.id)
  if (existing !== undefined) {
    if (existing.origin && origin === undefined)
      return yield* new SessionInputOrigin.UnavailableError({ sessionID: captured.sessionID })
    if (!equivalent(existing, captured)) return yield* Effect.die(new InputLifecycleConflict({ id: captured.id }))
    return existing
  }
  const timestamp = yield* DateTime.now
  const data = {
    messageID: captured.id,
    sessionID: captured.sessionID,
    timestamp,
    prompt,
    delivery: captured.delivery,
  }
  return yield* events
    .publish(
      origin === undefined ? SessionEvent.PromptAdmitted : SessionEvent.OriginPromptAdmitted,
      origin === undefined ? data : { ...data, origin },
    )
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: captured.id,
                sessionID: captured.sessionID,
                prompt,
                delivery: captured.delivery,
                timeCreated: timestamp,
                ...(origin === undefined ? {} : { origin }),
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, captured.id).pipe(
          Effect.flatMap((stored) =>
            stored && equivalent(stored, captured) ? Effect.succeed(stored) : Effect.die(defect),
          ),
        ),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly origin?: SessionInputOrigin.Origin
  },
) {
  if (input.origin !== undefined) {
    const session = yield* db
      .select({
        projectID: SessionTable.project_id,
        directory: SessionTable.directory,
        workspaceID: SessionTable.workspace_id,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !session ||
      session.projectID !== input.origin.projectID ||
      session.directory !== input.origin.location.directory ||
      (session.workspaceID ?? undefined) !== input.origin.location.workspaceID
    )
      return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
    yield* db
      .insert(SessionInputOriginTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        node_id: input.origin.nodeID,
        command_id: input.origin.commandID,
        admitted_seq: input.admittedSeq,
        origin: encodeOrigin(input.origin),
      })
      .onConflictDoNothing()
      .returning({ id: SessionInputOriginTable.id })
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((stored) => (stored ? Effect.void : Effect.die(new InputLifecycleConflict({ id: input.id })))),
      )
  } else {
    const receipt = yield* db
      .select()
      .from(SessionInputOriginTable)
      .where(eq(SessionInputOriginTable.id, input.id))
      .get()
      .pipe(Effect.orDie)
    if (receipt) return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  }
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  const session = yield* db.select({ title: SessionTable.title }).from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  if (session && isDefaultTitle(session.title)) {
    // Recover a still-unnamed older session from its first admitted request.
    // This projection shares the prompt transaction and cannot overwrite a
    // manual title or emit a second prompt on an exact retry.
    const first = yield* db.select({ prompt: SessionInputTable.prompt }).from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, input.sessionID))
      .orderBy(asc(SessionInputTable.admitted_seq)).get().pipe(Effect.orDie)
    const title = titleFromPrompt(first?.prompt.text ?? "") ?? titleFromPrompt(input.prompt.text)
    if (title) yield* db.update(SessionTable).set({ title })
      .where(and(eq(SessionTable.id, input.sessionID), eq(SessionTable.title, session.title)))
      .run().pipe(Effect.orDie)
  }
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  // The local event must not promote or erase a command's durable provenance.
  const receipt = yield* db
    .select()
    .from(SessionInputOriginTable)
    .where(eq(SessionInputOriginTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (receipt) return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

/** Project a native promotion only against an identical, existing admission. */
export const projectOriginPrompted = Effect.fn("SessionInput.projectOriginPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
    readonly origin: SessionInputOrigin.Origin
  },
) {
  const stored = yield* find(db, input.id)
  if (
    !stored?.origin ||
    input.delivery !== "queue" ||
    input.id !== `msg_node_${input.origin.commandID}` ||
    !matchesProjection(stored, input) ||
    stored.promotedSeq !== undefined
  )
    return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  const session = yield* db
    .select({
      projectID: SessionTable.project_id,
      directory: SessionTable.directory,
      workspaceID: SessionTable.workspace_id,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (
    !session ||
    session.projectID !== input.origin.projectID ||
    session.directory !== input.origin.location.directory ||
    (session.workspaceID ?? undefined) !== input.origin.location.workspaceID
  )
    return yield* Effect.die(new InputLifecycleConflict({ id: input.id }))
  yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(and(eq(SessionInputTable.id, input.id), isNull(SessionInputTable.promoted_seq)))
    .run()
    .pipe(Effect.orDie)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly origin?: SessionInputOrigin.Origin
  },
) =>
  input.delivery === expected.delivery &&
  matchesPrompt(input, expected) &&
  isDeepStrictEqual(
    input.origin === undefined ? undefined : encodeOrigin(input.origin),
    expected.origin === undefined ? undefined : encodeOrigin(expected.origin),
  )

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly origin?: SessionInputOrigin.Origin
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  yield* SessionInputOrigin.requireLocalRun(db, sessionID)
  // Validate the whole captured batch before publishing its first event.
  for (const row of rows) {
    const stored = yield* find(db, row.id)
    if (stored?.origin) return yield* new SessionInputOrigin.UnavailableError({ sessionID })
  }
  for (const row of rows) {
    // A listener or another fiber may admit a remote command between events.
    yield* SessionInputOrigin.requireLocalRun(db, sessionID)
    const id = SessionMessage.ID.make(row.id)
    yield* events
      .publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(row.time_created),
        messageID: id,
        prompt: decodePrompt(row.prompt),
        delivery: row.delivery,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof InputLifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.length
})

/** Promote only the captured local IDs; a stale selection never picks replacements. */
export const promoteSelected = Effect.fn("SessionInput.promoteSelected")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  sessionID: SessionSchema.ID,
  selection: {
    readonly delivery: Delivery
    readonly messageIDs: ReadonlyArray<SessionMessage.ID>
  },
) {
  const delivery = selection.delivery
  const ids = [...selection.messageIDs]
  yield* SessionInputOrigin.requireLocalRun(db, sessionID)
  if (ids.length === 0) return 0
  if (
    (delivery !== "steer" && delivery !== "queue") ||
    (delivery === "queue" && ids.length !== 1) ||
    new Set(ids).size !== ids.length
  )
    return yield* Effect.die(new InputLifecycleConflict({ id: ids[0]! }))
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(inArray(SessionInputTable.id, ids))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  const byID = new Map(rows.map((row) => [row.id, row]))
  for (const id of ids) {
    const row = byID.get(id)
    if (!row || row.session_id !== sessionID || row.delivery !== delivery)
      return yield* Effect.die(new InputLifecycleConflict({ id }))
  }
  return yield* publish(
    db,
    events,
    sessionID,
    rows.filter((row) => row.promoted_seq === null),
  )
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventBus.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})
