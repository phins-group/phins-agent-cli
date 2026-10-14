/**
 * Điểm ghép gốc của hợp đồng HTTP V2.
 * Ghép mọi operation group và đặt location/session middleware đúng scope.
 * @module
 */
import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error"
import { MessageGroup } from "./resources/message"
import { ModelGroup } from "./resources/model"
import { ProviderGroup } from "./resources/provider"
import { makeSessionGroup, SessionLive } from "./resources/session"
import { makePermissionGroup } from "./resources/permission"
import { FileSystemGroup } from "./resources/fs"
import { CommandGroup } from "./resources/command"
import { SkillGroup } from "./resources/skill"
import { EventGroup, makeEventGroup } from "./resources/event"
import type { Definition } from "../../contracts/events/event"
import { AgentGroup } from "./resources/agent"
import { HealthGroup } from "./resources/health"
import { ServiceGroup } from "./resources/service"
import { ServiceAdmission } from "./middleware/service-admission"
import { PtyGroup } from "./resources/pty"
import { makeQuestionGroup } from "./resources/question"
import { ReferenceGroup } from "./resources/reference"
import { Authorization } from "./middleware/authorization"
import { LocationGroup } from "./resources/location"
import { IntegrationGroup } from "./resources/integration"
import { CredentialGroup } from "./resources/credential"
import { ProjectCopyGroup } from "./resources/project-copy"
import { ProjectGroup } from "./resources/project"

import { makeTuiGroup } from "./resources/tui"

// Protocol sở hữu vị trí middleware; Server inject concrete keys để identity
// của Core service không rò ngược vào package hợp đồng.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Any,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApi.make("server")
    .annotate(HttpApi.AdditionalSchemas, [SessionLive.Frame])
    .add(HealthGroup)
    .add(ServiceGroup)
    .add(LocationGroup.middleware(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    .add(makeSessionGroup(sessionLocationMiddleware))
    .add(MessageGroup.middleware(sessionLocationMiddleware))
    .add(ModelGroup.middleware(locationMiddleware))
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(PtyGroup.middleware(locationMiddleware))
    .add(makeQuestionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(ReferenceGroup.middleware(locationMiddleware))
    .add(ProjectCopyGroup.middleware(locationMiddleware))
    .add(ProjectGroup.middleware(locationMiddleware))
    .add(makeTuiGroup(sessionLocationMiddleware).middleware(locationMiddleware))
    .annotateMerge(
      OpenApi.annotations({
        title: "phins HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(ServiceAdmission)
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

/** Dựng API với event definitions động và middleware keys do server cung cấp. */
export const makeApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly definitions: ReadonlyArray<Definition>
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}) =>
  makeApiFromGroup(makeEventGroup(options.definitions), options.locationMiddleware, options.sessionLocationMiddleware)

export const makeDefaultApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}) => makeApiFromGroup(EventGroup, options.locationMiddleware, options.sessionLocationMiddleware)
