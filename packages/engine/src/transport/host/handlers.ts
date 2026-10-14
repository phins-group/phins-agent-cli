/**
 * Registry implementation cho toàn bộ V2 operation groups.
 * Merge handler layers rồi cung cấp location/session/core lifecycle một lần.
 * @module
 */
import { PermissionSaved } from "../../security/permissions/saved"
import { PtyTicket } from "../../execution/terminal/ticket"
import { Layer } from "effect"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { ServiceHandler } from "./handlers/service"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { Credential } from "../../security/credentials"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { ProjectHandler } from "./handlers/project"

import { TuiHandler } from "./handlers/tui"
import { AppPaths } from "../../runtime/paths"
import { ProjectDirectories } from "../../workspace/projects/directories"

/** Layer duy nhất mà điểm ghép HTTP gốc dùng để gắn mọi lệnh V2. */
export const handlers = Layer.mergeAll(
  HealthHandler,
  ServiceHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ReferenceHandler,
  ProjectCopyHandler,
  ProjectHandler,
  TuiHandler,
).pipe(
  Layer.provide(sessionLocationLayer),
  Layer.provide(locationLayer),
  Layer.provide(PermissionSaved.defaultLayer),
  Layer.provide(PtyTicket.defaultLayer),
  Layer.provide(Credential.defaultLayer),
  Layer.provide(AppPaths.defaultLayer),
  Layer.provide(ProjectDirectories.defaultLayer),
)
