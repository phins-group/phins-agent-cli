export * as SessionInputOrigin from "./input-origin"

import { Schema } from "effect"
import {
  DateTimeUtcFromMillis,
  NonNegativeInt,
  optionalOmitUndefined,
} from "../schema"
import { Location } from "../workspace/location"
import { ProjectID } from "../workspace/project-id"
import { WorkspaceID } from "../workspace/workspace-id"

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
)

// JSON omits undefined. Keep the stored/replayed provenance byte-equivalent
// instead of inheriting Location.Ref's decoding default for workspaceID.
const OriginLocation = Schema.Struct({
  directory: Location.Ref.fields.directory,
  workspaceID: optionalOmitUndefined(WorkspaceID),
})

/** Durable provenance, not credentials or authority to execute a command. */
export const Origin = Schema.Struct({
  source: Schema.Literals(["web", "channel"]),
  commandID: Identifier,
  nodeID: Identifier,
  userID: Identifier,
  platformWorkspaceID: Identifier,
  loginID: Identifier,
  projectID: ProjectID,
  location: OriginLocation,
  grantID: Identifier,
  grantRevision: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  attemptID: Identifier,
  attemptKind: optionalOmitUndefined(Schema.Literal("tasks")),
  expiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionInputOrigin.Origin" })
export type Origin = typeof Origin.Type
