/** Hiện thực thao tác list/remove/reply permission đã lưu hoặc theo session. @module */
import { Location } from "../../../workspace/location"
import { PermissionPolicy } from "../../../security/permissions/service"
import { PermissionSaved } from "../../../security/permissions/saved"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ForbiddenError, PermissionNotFoundError } from "../../api/errors"
import { response } from "../location"

function missingRequest(id: PermissionPolicy.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          return yield* response((yield* PermissionPolicy.Service).list())
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionPolicy.Service
          return { data: yield* permission.forSession(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionPolicy.Service
          const request = yield* permission.get(ctx.params.requestID)
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          yield* permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(
              Effect.catchTag("PermissionV2.NotFoundError", () => missingRequest(ctx.params.requestID)),
              Effect.catchTag(
                "PermissionV2.ReplyForbiddenError",
                (error) => new ForbiddenError({ message: error.message }),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return {
            data: yield* (yield* PermissionSaved.Service).list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          yield* (yield* PermissionSaved.Service).remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
