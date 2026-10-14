import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage/database"
import { EventBus } from "../../src/runtime/events/bus"
import { EventTable } from "../../src/storage/tables/events"
import { Location } from "../../src/workspace/location"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { ProjectTable } from "../../src/storage/tables/projects"
import { AbsolutePath } from "../../src/shared/schema"
import * as ControlCommand from "../../src/execution/control/command"
import { SessionProjector } from "../../src/sessions/projector"
import { Session as SessionSchema } from "../../src/contracts/session/info"
import {
  SessionInputTable,
  SessionInputOriginTable,
  SessionTable,
} from "../../src/storage/tables/sessions"

export const identity = {
  version: 1 as const,
  nodeId: "80000000-0000-4000-8000-000000000001",
  userId: "80000000-0000-4000-8000-000000000002",
  workspaceId: "80000000-0000-4000-8000-000000000003",
  sessionId: "80000000-0000-4000-8000-000000000004",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
}
export const sessionID = SessionSchema.ID.make("ses_authenticated_receiver")
export const expected: ControlCommand.Expected = {
  id: "80000000-0000-4000-8000-000000000005",
  revision: 1,
  action: "prompt",
  scope: {
    source: "web",
    granteeUserId: "80000000-0000-4000-8000-000000000006",
    projectId: ProjectRegistry.ID.global,
    targetSessionId: sessionID,
    directory: "/qa/receiver",
    syncWorkspaceId: null,
  },
  attempt: {
    kind: "jobs",
    id: "80000000-0000-4000-8000-000000000007",
    leaseId: "80000000-0000-4000-8000-000000000008",
  },
}
export const location: Location.Interface = {
  directory: AbsolutePath.make(expected.scope.directory),
  project: { id: ProjectRegistry.ID.global, directory: AbsolutePath.make("/qa") },
}
export const deadline = new Date(Date.now() + 600_000).toISOString()
export const proof = (
  text = "PRIVATE_FIXTURE_PROMPT",
): ControlCommand.Proof => ({
  ...expected,
  version: 1,
  nodeId: identity.nodeId,
  ownerUserId: identity.userId,
  workspaceId: identity.workspaceId,
  loginSessionId: identity.sessionId,
  actions: ["prompt"],
  rules: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  command: {
    version: "phins.node-control.v1",
    id: expected.attempt.id,
    action: "prompt",
    delivery: "queue",
    payload: { text },
    payloadHash: createHash("sha256")
      .update(JSON.stringify({ text }))
      .digest("hex"),
    expiresAt: deadline,
  },
})
export const node = (
  verify = async (_: ControlCommand.Expected, __: AbortSignal) => proof(),
) => ({ identity, verifyCommand: verify })
export const layer = Layer.mergeAll(
  Database.defaultLayer,
  EventBus.defaultLayer,
  SessionProjector.defaultLayer,
  Layer.succeed(Location.Service, location),
)
export const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectRegistry.ID.global,
      worktree: location.directory,
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectRegistry.ID.global,
      directory: location.directory,
      slug: "receiver",
      title: "QA",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})
export const counts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    inputs: (yield* db
      .select()
      .from(SessionInputTable)
      .all()
      .pipe(Effect.orDie)).length,
    origins: (yield* db
      .select()
      .from(SessionInputOriginTable)
      .all()
      .pipe(Effect.orDie)).length,
    events: (yield* db.select().from(EventTable).all().pipe(Effect.orDie))
      .length,
  }
})
