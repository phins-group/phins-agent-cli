import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer, PlatformError } from "effect"
import { Config } from "../src/settings/config"
import { ConfigAttachments } from "../src/settings/attachments"
import { FileSystem } from "../src/workspace/files/service"
import { FileAccess } from "../src/workspace/files/access"
import { Location } from "../src/workspace/location"
import { Image } from "../src/workspace/media/image"
import { PermissionPolicy } from "../src/security/permissions/service"
import { SessionManager } from "../src/sessions/service"
import { AbsolutePath } from "../src/shared/schema"
import { AppPaths } from "../src/runtime/paths"
import { location } from "./fixture/location"
import { ToolRegistry } from "../src/tools/registry"
import { ReadTool } from "../src/tools/files/read"
import { ReadToolFileSystem } from "../src/tools/files/reader"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const assertions: PermissionPolicy.AssertInput[] = []
const missingPath = "__missing_read_target__.txt"
const missingAbsolutePath = path.join(process.cwd(), missingPath)
const readCalls: {
  input: AbsolutePath
  page: ReadToolFileSystem.PageInput
}[] = []
const listCalls: ReadToolFileSystem.PageInput[] = []
let resolvedType: "file" | "directory" = "file"
let resolveFailure: unknown
let readResult: FileSystem.Content | ReadToolFileSystem.TextPage = {
  uri: "file:///README.md",
  name: "README.md",
  content: "hello",
  encoding: "utf8",
  mime: "text/plain",
}
let readFailure: ReadToolFileSystem.ReadError | undefined
let configEntries: Config.Entry[] = []
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    inspect: () => (resolveFailure === undefined ? Effect.succeed(resolvedType) : Effect.die(resolveFailure)),
    read: (input, _resource, page = {}) => {
      readCalls.push({ input, page })
      if (readFailure !== undefined) return Effect.fail(readFailure)
      return Effect.succeed(readResult)
    },
    list: (_path, input = {}) =>
      Effect.sync(() => {
        listCalls.push(input)
        return new ReadToolFileSystem.ListPage({ entries: [], truncated: false })
      }),
  }),
)
let allow = true
const permission = Layer.succeed(
  PermissionPolicy.Service,
  PermissionPolicy.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionPolicy.DeniedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const image = Image.layer.pipe(Layer.provide(config))
const testFileSystem = Layer.effect(
  FileAccess.Service,
  FileAccess.Service.use((fs) =>
    Effect.succeed(
      FileAccess.Service.of({
        ...fs,
        realPath: (path) =>
          path === missingAbsolutePath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(path),
      }),
    ),
  ),
).pipe(Layer.provide(FileAccess.defaultLayer))
const infrastructure = Layer.mergeAll(
  testFileSystem,
  Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) }))),
  AppPaths.layerWith({ data: AppPaths.directories.data }),
)
const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const read = ReadTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(reader),
  Layer.provide(permission),
  Layer.provide(config),
  Layer.provide(image),
  Layer.provide(infrastructure),
)
const it = testEffect(Layer.mergeAll(registry, reader, permission, config, image, infrastructure, read))
const unavailableRead = ReadTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(reader),
  Layer.provide(permission),
  Layer.provide(config),
  Layer.provide(unavailableImage),
  Layer.provide(infrastructure),
)
const itWithoutResizer = testEffect(
  Layer.mergeAll(registry, reader, permission, config, unavailableImage, infrastructure, unavailableRead),
)
const sessionID = SessionManager.ID.make("ses_read_tool_test")

describe("ReadTool", () => {
  beforeEach(() => {
    assertions.length = 0
    readCalls.length = 0
    listCalls.length = 0
    allow = true
    resolvedType = "file"
    resolveFailure = undefined
    readResult = {
      uri: "file:///README.md",
      name: "README.md",
      content: "hello",
      encoding: "utf8",
      mime: "text/plain",
    }
    readFailure = undefined
    configEntries = []
  })

  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "read" }])
      expect(yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "text", value: "hello" })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["README.md"], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("preserves literal regex and newlines in model text and structured history", () =>
    Effect.gen(function* () {
      const source = String.raw`const pattern = /^-?\d+(\.\d+)?$/;` + "\n"
      readResult = { ...readResult, content: source }
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "call-regex", name: "read", input: { path: "regex.js" } },
      })
      expect(settled.result).toEqual({ type: "text", value: source })
      expect(settled.output?.structured).toMatchObject({ content: source, encoding: "utf8" })
    }),
  )

  it.effect("keeps nested absolute paths under project-relative read permissions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "call-absolute", name: "read",
          input: { path: path.join(process.cwd(), "nested/private.txt") } },
      })
      expect(result.type).not.toBe("error")
      expect(assertions).toMatchObject([{ action: "read", resources: ["nested/private.txt"] }])
      expect(assertions).toHaveLength(1)
    }),
  )

  it.effect("denies an absolute external read before accessing content", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "call-external-denied", name: "read",
          input: { path: path.resolve(process.cwd(), "../private.txt") } },
      })
      expect(result.type).toBe("error")
      expect(assertions).toMatchObject([{ action: "external_directory" }])
      expect(assertions).toHaveLength(1)
      expect(readCalls).toEqual([])
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("requires external approval followed by canonical read approval", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const target = path.resolve(process.cwd(), "../private.txt")
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "call-external-allowed", name: "read", input: { path: target } },
      })
      expect(result.type).not.toBe("error")
      expect(assertions).toMatchObject([
        { action: "external_directory", resources: [path.join(path.dirname(target), "*").replaceAll("\\", "/")] },
        { action: "read", resources: [target.replaceAll("\\", "/")] },
      ])
      expect(assertions).toHaveLength(2)
      expect(readCalls).toHaveLength(1)
    }),
  )

  it.effect("returns a small PNG as native media instead of durable base64 text", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-image", name: "read", input: { path: "pixel.png" } },
        }),
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "pixel.png" },
        ],
      })
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "pixel.png")),
          page: { offset: undefined, limit: undefined },
        },
      ])

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image-settle", name: "read", input: { path: "pixel.png" } },
      })
      expect(settled.output?.structured).toMatchObject({
        uri: "file:///pixel.png",
        name: "pixel.png",
        mime: "image/png",
        encoding: "base64",
      })
      expect(settled.output?.content).toMatchObject([
        { type: "text", text: "Image read successfully" },
        { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}` },
      ])
    }),
  )

  it.effect("preserves a PNG above the generic text limit as native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const pixels = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index * 73 + (index >> 3)) % 256)
      const source = new photon.PhotonImage(pixels, 256, 256)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      expect(Buffer.byteLength(png)).toBeGreaterThan(50 * 1024)
      readResult = {
        uri: "file:///large.png",
        name: "large.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-image", name: "read", input: { path: "large.png" } },
      })

      expect(settled.outputPaths).toBeUndefined()
      expect(settled.output?.structured).toMatchObject({
        uri: "file:///large.png",
        name: "large.png",
        mime: "image/png",
        encoding: "base64",
      })
      expect(settled.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "large.png" },
        ],
      })
    }),
  )

  itWithoutResizer.effect("returns the original image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-image-fallback", name: "read", input: { path: "pixel.png" } },
        }),
      ).toMatchObject({
        type: "content",
        value: [{ type: "text" }, { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png" }],
      })
    }),
  )

  it.effect("rejects invalid image data returned by the filesystem", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///truncated.png",
        name: "truncated.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-truncated-image", name: "read", input: { path: "truncated.png" } },
        }),
      ).toEqual({ type: "error", value: "Image could not be decoded: truncated.png" })
    }),
  )

  it.effect("rejects oversized images when resizing is disabled", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ auto_resize: false, max_width: 4 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-wide-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.type).toBe("error")
      if (result.type === "error") expect(result.value).toContain("exceeding configured limits 4x2000")
    }),
  )

  it.effect("resizes images to configured dimensions before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({ image: new ConfigAttachments.Image({ max_width: 4 }) }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-resize-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.type).toBe("content")
      if (result.type !== "content") return
      const media = result.value[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.uri.split(",")[1] ?? "", "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("enforces max base64 bytes after resize attempts", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ max_base64_bytes: 1 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-max-bytes", name: "read", input: { path: "pixel.png" } },
      })

      expect(result.type).toBe("error")
      if (result.type === "error") expect(result.value).toContain("/1 bytes")
    }),
  )

  it.effect("returns supported image contents despite a misleading binary extension", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.bin",
        name: "pixel.bin",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disguised-image", name: "read", input: { path: "pixel.bin" } },
        }),
      ).toMatchObject({
        type: "content",
        value: [{ type: "text" }, { type: "file", mime: "image/png", name: "pixel.bin" }],
      })
    }),
  )

  it.effect("returns expected filesystem failures to the model", () =>
    Effect.gen(function* () {
      readFailure = new ReadToolFileSystem.BinaryFileError({ resource: "archive.dat" })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-binary",
            name: "read",
            input: { path: "archive.dat", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: archive.dat" })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "archive.dat")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("preserves unexpected filesystem defects", () =>
    Effect.gen(function* () {
      resolveFailure = new Error("unexpected")
      const registry = yield* ToolRegistry.Service

      expect(
        Exit.isFailure(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-defect", name: "read", input: { path: "README.md" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read README.md" })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("returns missing paths as model-visible tool failures", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-missing-path", name: "read", input: { path: missingPath } },
        }),
      ).toEqual({ type: "error", value: `Unable to read ${missingPath}` })
      expect(assertions).toEqual([])
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-read-directory",
            name: "read",
            input: { path: "src", offset: 2, limit: 10 },
          },
        }),
      ).toEqual({ type: "json", value: { entries: [], truncated: false } })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["src"], save: ["*"] }])
      expect(listCalls).toEqual([{ offset: 2, limit: 10 }])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read src" })
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("preserves unexpected resolution defects", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      resolveFailure = new Error("missing")
      expect(
        Exit.isFailure(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-missing", name: "read", input: { path: "missing.txt" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)

      expect(readCalls).toEqual([])
    }),
  )

  it.effect("forwards pagination and returns bounded text pages with continuation", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: "hello",
        mime: "text/plain",
        offset: 2,
        truncated: true,
        next: 3,
      })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-large",
            name: "read",
            input: { path: "large.txt", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({
        type: "text",
        value: "hello\n[Read truncated; continue at line 3.]",
      })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "large.txt")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("rejects unsupported binary discovered by a direct read", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///late-binary",
        name: "late-binary",
        content: "AAECAw==",
        encoding: "base64",
        mime: "application/octet-stream",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-direct-binary", name: "read", input: { path: "late-binary" } },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: late-binary" })
    }),
  )
})
