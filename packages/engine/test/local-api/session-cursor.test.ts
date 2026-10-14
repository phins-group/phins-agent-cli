import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionsCursor } from "../../src/transport/api/resources/session"
import { Session } from "../../src/contracts/session/info"

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = {
      workspace: undefined,
      search: "protocol",
      order: "desc" as const,
      anchor: { id: Session.ID.make("00000000-0000-4000-8000-000000000001"), time: 1, direction: "next" as const },
    }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
  })
})
