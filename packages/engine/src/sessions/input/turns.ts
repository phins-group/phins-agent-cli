import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../../storage/database"
import { SessionInputOrigin } from "./origin"
import { SessionMessage } from "../messages/service"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionInputOriginTable, SessionInputTable } from "../../storage/tables/sessions"

export interface Turn {
  readonly source: "local" | SessionInputOrigin.Origin["source"]
  readonly delivery: "steer" | "queue"
  readonly messageIDs: ReadonlyArray<SessionMessage.ID>
}

export class PlanError extends Schema.TaggedErrorClass<PlanError>()(
  "SessionInputTurns.PlanError",
  { sessionID: SessionSchema.ID },
) {}

const decodeOrigin = Schema.decodeUnknownExit(SessionInputOrigin.Origin, {
  onExcessProperty: "error",
})

/**
 * Read-only admission-order plan, not permission to promote or execute.
 * Every queue input/remote command is its own turn. Only adjacent local steers
 * may share a turn; never cross a remote command, source or delivery boundary.
 */
export const pending = Effect.fn("SessionInputTurns.pending")(function* (
  sessionID: SessionSchema.ID,
  cutoff?: number,
) {
  if (cutoff !== undefined && (!Number.isSafeInteger(cutoff) || cutoff < -1))
    return yield* new PlanError({ sessionID })
  const { db } = yield* Database.Service
  const orphan = yield* db
    .select({ id: SessionInputOriginTable.id })
    .from(SessionInputOriginTable)
    .leftJoin(
      SessionInputTable,
      eq(SessionInputTable.id, SessionInputOriginTable.id),
    )
    .where(
      and(
        eq(SessionInputOriginTable.session_id, sessionID),
        or(
          isNull(SessionInputTable.id),
          ne(SessionInputTable.session_id, sessionID),
          ne(
            SessionInputTable.admitted_seq,
            SessionInputOriginTable.admitted_seq,
          ),
        ),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (orphan) return yield* new PlanError({ sessionID })
  const rows = yield* db
    .select({
      id: SessionInputTable.id,
      admittedSeq: SessionInputTable.admitted_seq,
      delivery: SessionInputTable.delivery,
      origin: SessionInputOriginTable,
    })
    .from(SessionInputTable)
    .leftJoin(
      SessionInputOriginTable,
      eq(SessionInputOriginTable.id, SessionInputTable.id),
    )
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        cutoff === undefined
          ? undefined
          : lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  const turns: Array<{
    source: Turn["source"]
    delivery: Turn["delivery"]
    messageIDs: SessionMessage.ID[]
  }> = []
  for (const row of rows) {
    if (row.delivery !== "steer" && row.delivery !== "queue")
      return yield* new PlanError({ sessionID })
    let source: Turn["source"] = "local"
    if (row.origin) {
      const decoded = decodeOrigin(row.origin.origin)
      if (
        decoded._tag === "Failure" ||
        row.delivery !== "queue" ||
        row.origin.session_id !== sessionID ||
        row.origin.admitted_seq !== row.admittedSeq ||
        row.origin.node_id !== decoded.value.nodeID ||
        row.origin.command_id !== decoded.value.commandID
      )
        return yield* new PlanError({ sessionID })
      source = decoded.value.source
    }
    const previous = turns.at(-1)
    if (
      source === "local" &&
      row.delivery === "steer" &&
      previous?.source === "local" &&
      previous.delivery === "steer"
    )
      previous.messageIDs.push(row.id)
    else turns.push({ source, delivery: row.delivery, messageIDs: [row.id] })
  }
  return Object.freeze(
    turns.map(
      (turn): Turn =>
        Object.freeze({
          ...turn,
          messageIDs: Object.freeze(turn.messageIDs),
        }),
    ),
  )
})
