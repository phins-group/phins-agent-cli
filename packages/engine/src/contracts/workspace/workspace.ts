export * as Workspace from "./workspace"

import { WorkspaceEvent } from "../events/workspace"
import { WorkspaceID } from "./workspace-id"

export const ID = WorkspaceID
export type ID = WorkspaceID

export const Event = WorkspaceEvent
