import { SessionInputOrigin } from "../../src/sessions/input/origin"
import { ProjectRegistry } from "../../src/workspace/projects/service"
import { AbsolutePath } from "../../src/shared/schema"
import { DateTime } from "effect"

export const inputOrigin = (
  overrides: Partial<SessionInputOrigin.Origin> = {},
): SessionInputOrigin.Origin =>
  SessionInputOrigin.Origin.make({
    source: "web",
    commandID: "command_fixture",
    nodeID: "node_fixture",
    userID: "user_fixture",
    platformWorkspaceID: "platform_workspace_fixture",
    loginID: "login_fixture",
    projectID: ProjectRegistry.ID.global,
    location: { directory: AbsolutePath.make("/project") },
    grantID: "grant_fixture",
    grantRevision: 7,
    attemptID: "attempt_fixture",
    expiresAt: DateTime.makeUnsafe(2_000_000_000_000),
    ...overrides,
  })
