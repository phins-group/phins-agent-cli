export * as SessionRunState from "./state"
export * from "../../contracts/session/run-state"

import { SessionRunState as RunStateSchema } from "../../contracts/session/run-state"
import { and, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../../storage/database"
import { RunStateDecodeError } from "../errors"
import { SessionEvent } from "../../contracts/events/session"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionInput } from "../input/inbox"
import { SessionInputOrigin } from "../input/origin"
import { SessionMessageTable, SessionRunStateTable } from "../../storage/tables/sessions"

type DatabaseService = Database.Interface["db"]

export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("SessionRunState.ProjectionError", {
  sessionID: SessionSchema.ID,
  runID: RunStateSchema.ID,
  operation: Schema.Literals(["retry", "settle"]),
  reason: Schema.Literals(["missing", "stale-run", "not-active", "stale-attempt", "invalid-time"]),
}) {
  override get message() {
    return `Rejected ${this.operation} projection for run ${this.runID} in session ${this.sessionID}: ${this.reason}`
  }
}

const activeStatuses: readonly ["busy", "retrying"] = ["busy", "retrying"]

/**
 * A durable Started event is authoritative and may supersede any current row.
 * Callers handing off an active run should atomically publish the previous
 * run's interrupted settlement followed by this event.
 */
export const projectStarted = Effect.fn("SessionRunState.projectStarted")(function* (
  db: DatabaseService,
  event: SessionEvent.Run.Started,
) {
  const started = DateTime.toEpochMillis(event.data.timestamp)
  const inputID = event.data.inputID
  if (inputID === undefined) {
    yield* SessionInputOrigin.requireLocalRun(db, event.data.sessionID).pipe(Effect.orDie)
  } else {
    const input = yield* SessionInput.find(db, inputID)
    const latest = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const current = yield* db
      .select()
      .from(SessionRunStateTable)
      .where(eq(SessionRunStateTable.session_id, event.data.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !input?.origin ||
      input.sessionID !== event.data.sessionID ||
      input.delivery !== "queue" ||
      input.id !== `msg_node_${input.origin.commandID}` ||
      input.promotedSeq === undefined ||
      latest?.id !== inputID ||
      latest.seq !== input.promotedSeq ||
      (current &&
        (activeStatuses.includes(current.status as (typeof activeStatuses)[number]) || current.input_id === inputID))
    )
      return yield* Effect.die(new SessionInput.InputLifecycleConflict({ id: inputID }))
  }
  yield* db
    .insert(SessionRunStateTable)
    .values({
      session_id: event.data.sessionID,
      run_id: event.data.runID,
      input_id: inputID ?? null,
      status: "busy",
      attempt: null,
      next_retry_at: null,
      error: null,
      time_started: started,
      time_settled: null,
    })
    .onConflictDoUpdate({
      target: SessionRunStateTable.session_id,
      set: {
        run_id: event.data.runID,
        input_id: inputID ?? null,
        status: "busy",
        attempt: null,
        next_retry_at: null,
        error: null,
        time_started: started,
        time_settled: null,
      },
    })
    .run()
    .pipe(Effect.orDie)
})

export const projectRetried = Effect.fn("SessionRunState.projectRetried")(function* (
  db: DatabaseService,
  event: SessionEvent.Run.Retried,
) {
  const nextRetryAt = DateTime.toEpochMillis(event.data.nextRetryAt)
  const updated = yield* db
    .update(SessionRunStateTable)
    .set({
      status: "retrying",
      attempt: event.data.attempt,
      next_retry_at: nextRetryAt,
      error: event.data.error,
      time_settled: null,
    })
    .where(
      and(
        eq(SessionRunStateTable.session_id, event.data.sessionID),
        eq(SessionRunStateTable.run_id, event.data.runID),
        inArray(SessionRunStateTable.status, activeStatuses),
        lte(SessionRunStateTable.time_started, nextRetryAt),
        or(isNull(SessionRunStateTable.attempt), lt(SessionRunStateTable.attempt, event.data.attempt)),
      ),
    )
    .returning({ sessionID: SessionRunStateTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (updated) return

  const current = yield* db
    .select({
      runID: SessionRunStateTable.run_id,
      status: SessionRunStateTable.status,
      attempt: SessionRunStateTable.attempt,
      timeStarted: SessionRunStateTable.time_started,
    })
    .from(SessionRunStateTable)
    .where(eq(SessionRunStateTable.session_id, event.data.sessionID))
    .get()
    .pipe(Effect.orDie)
  const reason = !current
    ? "missing"
    : current.runID !== event.data.runID
      ? "stale-run"
      : !activeStatuses.includes(current.status as (typeof activeStatuses)[number])
        ? "not-active"
        : current.timeStarted > nextRetryAt
          ? "invalid-time"
          : "stale-attempt"
  return yield* Effect.die(
    new ProjectionError({
      sessionID: event.data.sessionID,
      runID: event.data.runID,
      operation: "retry",
      reason,
    }),
  )
})

export const projectSettled = Effect.fn("SessionRunState.projectSettled")(function* (
  db: DatabaseService,
  event: SessionEvent.Run.Settled,
) {
  const settled = DateTime.toEpochMillis(event.data.timestamp)
  const updated = yield* db
    .update(SessionRunStateTable)
    .set({
      status: event.data.outcome.type,
      attempt: null,
      next_retry_at: null,
      error: event.data.outcome.type === "terminal-failure" ? event.data.outcome.error : null,
      time_settled: settled,
    })
    .where(
      and(
        eq(SessionRunStateTable.session_id, event.data.sessionID),
        eq(SessionRunStateTable.run_id, event.data.runID),
        inArray(SessionRunStateTable.status, activeStatuses),
        lte(SessionRunStateTable.time_started, settled),
      ),
    )
    .returning({ sessionID: SessionRunStateTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (updated) return

  const current = yield* db
    .select({
      runID: SessionRunStateTable.run_id,
      status: SessionRunStateTable.status,
      timeStarted: SessionRunStateTable.time_started,
    })
    .from(SessionRunStateTable)
    .where(eq(SessionRunStateTable.session_id, event.data.sessionID))
    .get()
    .pipe(Effect.orDie)
  const reason = !current
    ? "missing"
    : current.runID !== event.data.runID
      ? "stale-run"
      : !activeStatuses.includes(current.status as (typeof activeStatuses)[number])
        ? "not-active"
        : current.timeStarted > settled
          ? "invalid-time"
          : "not-active"
  return yield* Effect.die(
    new ProjectionError({
      sessionID: event.data.sessionID,
      runID: event.data.runID,
      operation: "settle",
      reason,
    }),
  )
})

const decodeState = Schema.decodeUnknownEffect(RunStateSchema.State)

export const load = Effect.fn("SessionRunState.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select()
    .from(SessionRunStateTable)
    .where(eq(SessionRunStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined

  const invalid = (details: string) => new RunStateDecodeError({ sessionID, runID: row.run_id, details })
  const base = {
    sessionID: row.session_id,
    runID: row.run_id,
    ...(row.input_id === null ? {} : { inputID: row.input_id }),
    time: { started: row.time_started },
  }
  let encoded: unknown
  switch (row.status) {
    case "busy":
      if (row.attempt !== null || row.next_retry_at !== null || row.error !== null || row.time_settled !== null)
        return yield* Effect.fail(invalid("busy state contains retry or settlement fields"))
      encoded = { ...base, status: "busy" }
      break
    case "retrying":
      if (row.attempt === null || row.next_retry_at === null || row.error === null || row.time_settled !== null)
        return yield* Effect.fail(invalid("retrying state is missing retry fields or is already settled"))
      encoded = {
        ...base,
        status: "retrying",
        attempt: row.attempt,
        nextRetryAt: row.next_retry_at,
        error: row.error,
      }
      break
    case "idle":
    case "interrupted":
      if (row.attempt !== null || row.next_retry_at !== null || row.error !== null || row.time_settled === null)
        return yield* Effect.fail(invalid(`${row.status} state contains retry fields or is missing settlement time`))
      encoded = { ...base, status: row.status, time: { ...base.time, settled: row.time_settled } }
      break
    case "terminal-failure":
      if (row.attempt !== null || row.next_retry_at !== null || row.error === null || row.time_settled === null)
        return yield* Effect.fail(invalid("terminal failure has retry fields or is missing its error/time"))
      encoded = {
        ...base,
        status: "terminal-failure",
        error: row.error,
        time: { ...base.time, settled: row.time_settled },
      }
      break
    default:
      return yield* Effect.fail(invalid(`unknown status: ${String(row.status)}`))
  }
  return yield* decodeState(encoded).pipe(
    Effect.mapError((error) => invalid(String(error))),
    Effect.flatMap((state) => {
      if (
        state.status === "retrying" &&
        DateTime.toEpochMillis(state.nextRetryAt) < DateTime.toEpochMillis(state.time.started)
      )
        return Effect.fail(invalid("next retry precedes start"))
      if (
        state.status !== "busy" &&
        state.status !== "retrying" &&
        DateTime.toEpochMillis(state.time.settled) < DateTime.toEpochMillis(state.time.started)
      )
        return Effect.fail(invalid("settlement precedes start"))
      return Effect.succeed(state)
    }),
  )
})
