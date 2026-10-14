export * as EventManifest from "./manifest"

import { Catalog } from "../inference/catalog"
import { Durable } from "./durable-manifest"
import { Event } from "./event"
import { FileSystem } from "../workspace/filesystem"
import { FileSystemWatcher } from "./filesystem"
import { InstallationEvent } from "./installation"
import { Integration } from "../extensions/integration"
import { LegacyEvent } from "./legacy"
import { McpEvent } from "./mcp"
import { ModelsDev } from "../inference/models-dev"
import { Permission } from "../security/permission"
import { PermissionV1 } from "../security/permission-compat"
import { Plugin } from "../extensions/plugin"
import { Project } from "../workspace/project"
import { ProjectDirectories } from "../workspace/project-directories"
import { Pty } from "../execution/terminal"
import { Question } from "../agents/question"
import { QuestionV1 } from "../agents/question-compat"
import { Reference } from "../agents/reference"
import { ServerEvent } from "./server"
import { SessionCompactionEvent } from "./session-compaction"
import { SessionEvent } from "./session"
import { SessionStatusEvent } from "./session-status"
import { SessionTodo } from "../session/todo"
import { SessionV1 } from "../session/compat"
import { TuiEvent } from "./tui"
import { VcsEvent } from "./vcs"
import { WorkspaceEvent } from "./workspace"
import { WorktreeEvent } from "./worktree"

const sessionV1DurableDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined)
const sessionV1LiveDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable === undefined)

const coreDefinitions = Event.inventory(...sessionV1DurableDefinitions, ...SessionEvent.Definitions)

const foundationDefinitions = Event.inventory(
  ...ModelsDev.Event.Definitions,
  ...Integration.Event.Definitions,
  ...Catalog.Event.Definitions,
  ...coreDefinitions,
)

const featureDefinitions = Event.inventory(
  ...FileSystem.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Permission.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...ProjectDirectories.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
)

export const ServerDefinitions = Event.inventory(
  ...foundationDefinitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
)

export const Definitions = Event.inventory(
  ...foundationDefinitions,
  ...sessionV1LiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...PermissionV1.Event.Definitions,
  ...TuiEvent.Definitions,
  ...McpEvent.Definitions,
  ...LegacyEvent.Definitions,
  ...Project.Event.Definitions,
  ...SessionStatusEvent.Definitions,
  ...QuestionV1.Event.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...WorktreeEvent.Definitions,
  ...ServerEvent.Definitions,
)
export const Latest = Event.latest(Definitions)
export { Durable }
