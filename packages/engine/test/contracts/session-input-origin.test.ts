import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionInputOrigin } from "../../src/contracts/session/input-origin"

const origin = {
  source: "web" as const,
  commandID: "command",
  nodeID: "node",
  userID: "actor",
  platformWorkspaceID: "platform-workspace",
  loginID: "login",
  projectID: "global",
  grantID: "grant",
  grantRevision: 1,
  attemptID: "lease",
  expiresAt: 1_900_000_000_000,
}
const decode = Schema.decodeUnknownSync(SessionInputOrigin.Origin)
const encode = Schema.encodeSync(SessionInputOrigin.Origin)

test("origin encoding preserves JSON equivalence with and without a sync workspace", () => {
  for (const location of [
    { directory: "/qa/receiver" },
    { directory: "/qa/receiver", workspaceID: "wrk_shared" },
  ]) {
    const serialized = { ...origin, location }
    const encoded = encode(decode(serialized))
    expect(encoded).toEqual(serialized)
    expect(encode(decode(JSON.parse(JSON.stringify(encoded))))).toEqual(
      serialized,
    )
    expect(Object.keys(encoded.location)).toEqual(Object.keys(location))
  }
})
