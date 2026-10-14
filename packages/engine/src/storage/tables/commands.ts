import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sessions"

/** An uncertain local slash command is spent, never automatically replayed. */
export const SessionCommandTable = sqliteTable(
  "session_command_receipt",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    signature: text().notNull(),
    status: text()
      .$type<"invoked" | "completed" | "failed" | "unknown">()
      .notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("session_command_receipt_session").on(table.session_id)],
)
