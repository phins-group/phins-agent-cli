import { desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { VerificationReceipt } from "../../contracts/execution/verification-receipt"
import type { Database } from "../../storage/database"
import type { Session as SessionSchema } from "../../contracts/session/info"
import { VerificationReceiptTable } from "../../storage/tables/sessions"

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("VerificationHistory.DecodeError", {
  sessionID: Schema.String,
}) {}

/** Caller owns session authorization. This read never captures files or runs checks. */
export const list = Effect.fn("VerificationHistory.list")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select({
      id: VerificationReceiptTable.id,
      sessionID: VerificationReceiptTable.session_id,
      locationKey: VerificationReceiptTable.location_key,
      mode: VerificationReceiptTable.mode,
      mutationEpoch: VerificationReceiptTable.mutation_epoch,
      snapshot: VerificationReceiptTable.subject_snapshot,
      verifier: VerificationReceiptTable.verifier,
      verdict: VerificationReceiptTable.verdict,
      checks: VerificationReceiptTable.checks,
      requested: VerificationReceiptTable.time_requested,
      started: VerificationReceiptTable.time_started,
      completed: VerificationReceiptTable.time_completed,
    })
    .from(VerificationReceiptTable)
    .where(eq(VerificationReceiptTable.session_id, sessionID))
    .orderBy(desc(VerificationReceiptTable.time_requested), desc(VerificationReceiptTable.id))
    .limit(VerificationReceipt.HISTORY_LIMIT)
    .all()
    .pipe(Effect.orDie)

  return yield* Effect.try({
    try: () =>
      rows.map((row) => {
        if (row.verdict === null) {
          if (row.completed !== null || row.checks.length !== 0) throw new Error("invalid pending receipt")
        } else {
          // Validate stored terminal evidence before presenting even a historical pass.
          Schema.decodeUnknownSync(VerificationReceipt.Receipt)({
            id: row.id,
            sessionID: row.sessionID,
            locationKey: row.locationKey,
            mode: row.mode,
            subject: {
              mutationEpoch: row.mutationEpoch,
              snapshot: row.snapshot ?? undefined,
            },
            verifier: row.verifier ?? undefined,
            verdict: row.verdict,
            checks: row.checks,
            time: {
              requested: row.requested,
              started: row.started ?? undefined,
              completed: row.completed,
            },
          })
        }
        return Schema.decodeUnknownSync(VerificationReceipt.HistoryItem)({
          id: row.id,
          sessionID: row.sessionID,
          mode: row.mode,
          verdict: row.verdict ?? "pending",
          freshness: "unverified",
          time: {
            requested: row.requested,
            ...(row.completed === null ? {} : { completed: row.completed }),
          },
        })
      }),
    catch: () => new DecodeError({ sessionID }),
  })
})
