export * as ReadTool from "./read"

import { ToolFailure } from "../../inference/api"
import path from "path"
import * as LocalPolicy from "../../security/launcher-policy"
import { Effect, Layer, Schema } from "effect"
import { FileSystem } from "../../workspace/files/service"
import { FileAccess } from "../../workspace/files/access"
import { Image } from "../../workspace/media/image"
import { Location } from "../../workspace/location"
import { PermissionPolicy } from "../../security/permissions/service"
import { PermissionOrigin } from "../../security/permissions/origin"
import { AbsolutePath } from "../../shared/schema"
import { ReadToolFileSystem } from "./reader"
import { Tool } from "../definition"
import { Tools } from "../registration"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const LocationInput = Schema.Struct({
  path: Schema.String,
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
})
const Input = LocationInput
const Output = Schema.Union([FileSystem.Content, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FileAccess.Service
    const reader = yield* ReadToolFileSystem.Service
    const location = yield* Location.Service
    const image = yield* Image.Service
    const permission = yield* PermissionPolicy.Service

    yield* tools
      .register({
        [name]: Tool.withOriginPermission(
          Tool.make({
            parallel: true,
            description:
              "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Paths inside the project use project-relative permissions; absolute external paths require external_directory approval before read approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => {
              // Keep source text literal for exact edits. JSON fallback doubles
              // backslashes/newlines and makes regex-heavy code easy to miscopy.
              if ("encoding" in output && output.encoding === "utf8")
                return [{ type: "text", text: output.content }]
              if ("type" in output && output.type === "text-page") {
                const continuation = output.truncated
                  ? `\n[Read truncated; continue at line ${output.next ?? output.offset}.]`
                  : ""
                return [{ type: "text", text: output.content + continuation }]
              }
              if (!("encoding" in output) || output.encoding !== "base64" || !SUPPORTED_IMAGE_MIMES.has(output.mime))
                return []
              return [
                { type: "text", text: "Image read successfully" },
                { type: "file", data: output.content, mime: output.mime, name: input.path },
              ]
            },
            execute: (input, context) => {
              return Effect.gen(function* () {
                const absolute = path.resolve(location.directory, input.path)
                const restricted = (yield* PermissionOrigin.capture).length > 0
                const external = !FileAccess.contains(location.directory, absolute)
                if (!path.isAbsolute(input.path) && !FileAccess.contains(location.directory, absolute)) {
                  if (restricted)
                    return yield* new ToolFailure({ message: "Read path is outside the command's project" })
                  return yield* Effect.die(new Error("Path escapes the allowed read root"))
                }
                const real = yield* fs.realPath(absolute)
                const root = yield* fs.realPath(location.directory)
                yield* LocalPolicy.assertPath(root, real)
                const inside = FileAccess.contains(root, real)
                if (!inside && (!external || restricted)) {
                  if (restricted)
                    return yield* new ToolFailure({ message: "Read path is outside the command's project" })
                  return yield* Effect.die(new Error("Path escapes the allowed read root"))
                }
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!inside) {
                  const directory = path.join(path.dirname(real), "*").replaceAll("\\", "/")
                  yield* permission.assert({
                    action: "external_directory",
                    resources: [directory],
                    save: [directory],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                const resource = (inside ? path.relative(root, real) : real).replaceAll("\\", "/") || "."
                const target = AbsolutePath.make(real)
                const type = yield* reader.inspect(target)
                yield* permission.assert({
                  action: name,
                  resources: [resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                if (type === "directory")
                  return yield* reader.list(target, { offset: input.offset, limit: input.limit })
                const content = yield* reader.read(target, resource, {
                  offset: input.offset,
                  limit: input.limit,
                })
                if ("encoding" in content && content.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                  return yield* image
                    .normalize(resource, { ...content, encoding: "base64" })
                    .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
                }
                if ("encoding" in content && content.encoding === "base64")
                  return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource }))
                return content
              }).pipe(
                Effect.mapError((error) => {
                  const message =
                    error instanceof ReadToolFileSystem.BinaryFileError ||
                    error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                    error instanceof Image.DecodeError ||
                    error instanceof Image.SizeError
                      ? error.message
                      : `Unable to read ${input.path}`
                  return new ToolFailure({ message })
                }),
              )
            },
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
