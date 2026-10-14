export * as SessionInputOrigin from "./origin"

import { and, desc, eq, isNull, isNotNull } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionInputOrigin } from "../../contracts/session/input-origin"
import { SessionID } from "../../contracts/session/id"
import type { Database } from "../../storage/database"
import { PermissionOrigin } from "../../security/permissions/origin"
import {
  SessionInputOriginTable,
  SessionInputTable,
  SessionRunStateTable,
} from "../../storage/tables/sessions"

export const Origin = SessionInputOrigin.Origin
export type Origin = SessionInputOrigin.Origin

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "SessionInputOrigin.UnavailableError",
  { sessionID: SessionID },
) {
  override get message() {
    return "Remote-origin input is record-only; authenticated execution is not available in this runtime"
  }
}

/** Never replace missing durable execution authority with the caller's local rights. */
export const requireLocal = Effect.fn("SessionInputOrigin.requireLocal")(
  function* (db: Database.Interface["db"], sessionID: SessionID) {
    if ((yield* PermissionOrigin.capture).length > 0)
      return yield* new UnavailableError({ sessionID })
    const receipt = yield* db
      .select({ id: SessionInputOriginTable.id })
      .from(SessionInputOriginTable)
      .where(eq(SessionInputOriginTable.session_id, sessionID))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (receipt) return yield* new UnavailableError({ sessionID })
  },
)

/** New local input is allowed after remote work settles, not during its run. */
export const requireLocalCaller = Effect.fn(
  "SessionInputOrigin.requireLocalCaller",
)(function* (db: Database.Interface["db"], sessionID: SessionID) {
  if ((yield* PermissionOrigin.capture).length > 0)
    return yield* new UnavailableError({ sessionID })
  // A newly admitted remote command blocks the next local effect boundary,
  // even while an earlier local stream is allowed to finish. Old, promoted
  // remote history does not confer authority or prevent a new local input.
  const remote = yield* db
    .select({ id: SessionInputOriginTable.id })
    .from(SessionInputOriginTable)
    .leftJoin(
      SessionInputTable,
      eq(SessionInputTable.id, SessionInputOriginTable.id),
    )
    .where(
      and(
        eq(SessionInputOriginTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (remote) return yield* new UnavailableError({ sessionID })
  const current = yield* db
    .select()
    .from(SessionRunStateTable)
    .where(eq(SessionRunStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (
    current?.input_id &&
    (current.status === "busy" || current.status === "retrying")
  ) return yield* new UnavailableError({ sessionID })
  return current
})

/** Resume only local work. A completed remote command requires a new local input. */
export const requireLocalRun = Effect.fn("SessionInputOrigin.requireLocalRun")(
  function* (db: Database.Interface["db"], sessionID: SessionID) {
    const current = yield* requireLocalCaller(db, sessionID)
    if (current?.status === "busy" || current?.status === "retrying") {
      return
    }
    const pending = yield* db
      .select({ origin: SessionInputOriginTable.id })
      .from(SessionInputTable)
      .leftJoin(
        SessionInputOriginTable,
        eq(SessionInputOriginTable.id, SessionInputTable.id),
      )
      .where(
        and(
          eq(SessionInputTable.session_id, sessionID),
          isNull(SessionInputTable.promoted_seq),
        ),
      )
      .orderBy(SessionInputTable.admitted_seq)
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (pending) {
      if (pending.origin) return yield* new UnavailableError({ sessionID })
      return
    }
    const latest = yield* db
      .select({ origin: SessionInputOriginTable.id })
      .from(SessionInputTable)
      .leftJoin(
        SessionInputOriginTable,
        eq(SessionInputOriginTable.id, SessionInputTable.id),
      )
      .where(
        and(
          eq(SessionInputTable.session_id, sessionID),
          isNotNull(SessionInputTable.promoted_seq),
        ),
      )
      .orderBy(desc(SessionInputTable.promoted_seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (latest?.origin) return yield* new UnavailableError({ sessionID })
    // A missing projection cannot make a durable remote receipt local.
    if (!latest) yield* requireLocal(db, sessionID)
  },
)
