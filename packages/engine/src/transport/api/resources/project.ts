/** Native project presentation reads; no execution or credential mutation. */
import { Permission } from "../../../contracts/security/permission"
import { Location } from "../../../contracts/workspace/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(HttpApiEndpoint.get("project.tools", "/api/project/tools", {
    query: LocationQuery,
    success: Location.response(Schema.Struct({ ids: Schema.Array(Schema.String), permissions: Permission.Ruleset })),
    error: ServiceUnavailableError,
  }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.project.tools", summary: "Read project tools and configured permissions" })))
  .add(HttpApiEndpoint.get("project.diff", "/api/project/diff", {
    query: LocationQuery,
    success: Location.response(Schema.Struct({ text: Schema.String })),
    error: ServiceUnavailableError,
  }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.project.diff", summary: "Read bounded working-tree diff without external filters" })))
