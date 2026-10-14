export * as Snapshot from "./snapshot"

import path from "path"
import type { BigIntStats } from "node:fs"
import { lstat } from "node:fs/promises"
import { Context, Duration, Effect, Exit, Layer, Schema } from "effect"
import { Config } from "../../settings/config"
import { File } from "../files/diff"
import { FileAccess } from "../files/access"
import { Git } from "./git"
import { AppPaths } from "../../runtime/paths"
import { Location } from "../location"
import { AbsolutePath, RelativePath } from "../../shared/schema"
import { Hash } from "../../shared/hash"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export const Completeness = Schema.Literals([
  "location-filtered-v1",
  "project-strict-v1",
  "location-strict-v1",
])
export type Completeness = typeof Completeness.Type

/**
 * Versioned, portable identity for new consumers. Persisted session/event
 * fields remain bare IDs until their schemas can migrate without ambiguity.
 */
export const SubjectDescriptorV1 = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: ID,
  algorithm: Schema.Literals(["git-sha1-tree", "git-sha256-tree"]),
  storeNamespace: Schema.String,
  completeness: Completeness,
  scope: RelativePath,
})
export type SubjectDescriptorV1 = typeof SubjectDescriptorV1.Type
export const SubjectDescriptor = SubjectDescriptorV1
export type SubjectDescriptor = typeof SubjectDescriptor.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "retain", "files", "diff", "preview", "restore", "materialize", "cleanup"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Materialization {
  /** Fresh owned directory containing the exact raw snapshot tree. */
  readonly directory: AbsolutePath
  /** Canonical source project root whose snapshot store supplied the tree. */
  readonly projectRoot: AbsolutePath
  readonly snapshot: ID
  /** Idempotent, retryable cleanup capability owned by the caller. */
  readonly cleanup: Effect.Effect<void, Error>
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /** Capture plus a versioned identity for descriptor-aware consumers. */
  readonly captureSubject?: () => Effect.Effect<SubjectDescriptor | undefined>

  /** Capture all tracked and non-ignored untracked files, failing closed on unsupported candidates. */
  readonly captureVerification: () => Effect.Effect<ID | undefined>

  /** Strict full-project capture plus its exact completeness descriptor. */
  readonly captureVerificationSubject?: () => Effect.Effect<SubjectDescriptor | undefined>

  /**
   * Capture the active Location with the strict raw profile used for shadow
   * mutation observation when no trusted verifier has been selected.
   */
  readonly captureObservation: () => Effect.Effect<ID | undefined>

  /** Strict Location capture plus its exact completeness descriptor. */
  readonly captureObservationSubject?: () => Effect.Effect<SubjectDescriptor | undefined>

  /** Verify, localize and pin a tree before another durable owner references it. */
  readonly retain: (snapshot: ID) => Effect.Effect<void, Error>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>

  /** Materialize a snapshot into a fresh directory without modifying the project worktree. */
  readonly materialize: (snapshot: ID) => Effect.Effect<Materialization, Error>

  /**
   * Exclusively create and materialize into one fixed caller-owned destination.
   * The parent must already exist and both parent and destination must be
   * canonical absolute paths outside every repository storage root.
   */
  readonly materializeAt: (snapshot: ID, destination: AbsolutePath) => Effect.Effect<Materialization, Error>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/Snapshot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FileAccess.Service
    const git = yield* Git.Service
    const global = yield* AppPaths.Service
    const location = yield* Location.Service
    const source = yield* git.repo.discover(location.project.directory)
    const worktree = source
      ? AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
      : location.project.directory
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)))
    const storeNamespace = `snapshot/${location.project.id}/${Hash.fast(worktree)}`

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({
          operation: "capture",
          message: "Location is outside the project",
        })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repositoryCache = source
      ? yield* Effect.cachedInvalidateWithTTL(
          Effect.gen(function* () {
            const repository = (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
              ? new Git.Repository({
                  worktree,
                  gitDirectory,
                  commonDirectory: gitDirectory,
                })
              : yield* git.repo.create({
                  worktree,
                  gitDirectory,
                  seed: source,
                })
            yield* git.repo.ensureSnapshotRetention(repository)
            return repository
          }),
          Duration.infinity,
        )
      : undefined

    const repository = Effect.fnUntraced(function* (operation: Error["operation"] = "capture") {
      if (!repositoryCache)
        return yield* new Error({
          operation,
          message: "Project is not a Git repository",
        })
      const [cached, invalidate] = repositoryCache
      return yield* cached.pipe(
        Effect.tapError(() => invalidate),
        Effect.mapError((cause) => failure(operation, cause)),
      )
    })

    const enabled = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return false
      return Config.latest(yield* config.entries(), "snapshots") !== false
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const captureVerification = Effect.fn("Snapshot.captureVerification")(function* () {
      // Project-controlled snapshot/undo preferences must not disable a trusted
      // verifier boundary. Git capability is the only admission precondition.
      if (location.vcs?.type !== "git") return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.captureExact({
            repository: repo,
            scopes: [RelativePath.make(".")],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to capture strict verification snapshot", {
            cause,
            reason: "strict-full-project-capture-failed",
          }).pipe(Effect.as(undefined)),
        ),
      )
    })

    const captureObservation = Effect.fn("Snapshot.captureObservation")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.captureExact({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to capture strict location observation", {
            cause,
            reason: "strict-location-capture-failed",
          }).pipe(Effect.as(undefined)),
        ),
      )
    })

    const subject = (
      snapshot: ID,
      completeness: Completeness,
      subjectScope: RelativePath,
    ): SubjectDescriptor => ({
      version: 1,
      snapshot,
      algorithm: snapshot.length === 40 ? "git-sha1-tree" : "git-sha256-tree",
      storeNamespace,
      completeness,
      scope: subjectScope,
    })

    const captureSubject = Effect.fn("Snapshot.captureSubject")(function* () {
      const snapshot = yield* capture()
      if (!snapshot) return undefined
      return yield* scope().pipe(
        Effect.map((subjectScope) => subject(snapshot, "location-filtered-v1", subjectScope)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const captureVerificationSubject = Effect.fn("Snapshot.captureVerificationSubject")(function* () {
      const snapshot = yield* captureVerification()
      return snapshot ? subject(snapshot, "project-strict-v1", RelativePath.make(".")) : undefined
    })

    const captureObservationSubject = Effect.fn("Snapshot.captureObservationSubject")(function* () {
      const snapshot = yield* captureObservation()
      if (!snapshot) return undefined
      return yield* scope().pipe(
        Effect.map((subjectScope) => subject(snapshot, "location-strict-v1", subjectScope)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const retain = Effect.fn("Snapshot.retain")(function* (snapshot: ID) {
      const repo = yield* repository("retain")
      yield* git.tree
        .retain({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("retain", cause)))
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return {
        repository: repo,
        from: Git.TreeID.make(input.from),
        to: Git.TreeID.make(input.to),
      }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))
      if (!source) return files
      const ignored = yield* git.index
        .ignored({ repository: source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const ignored = source
        ? yield* git.index
            .ignored({ repository: source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FileAccess.contains(worktree, absolute))
          return yield* new Error({
            operation,
            message: `Path escapes the project: ${file}`,
          })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if (!(yield* enabled()))
        return yield* new Error({
          operation: "preview",
          message: "Snapshots are disabled",
        })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const current = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!(yield* enabled()))
        return yield* new Error({
          operation: "restore",
          message: "Snapshots are disabled",
        })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .checkout({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    type DirectoryIdentity = {
      readonly device: bigint
      readonly inode: bigint
    }

    type OwnedDirectory = {
      readonly directory: AbsolutePath
      readonly identity: DirectoryIdentity
      readonly cleanup: Materialization["cleanup"]
    }

    const inspectDirectory = Effect.fnUntraced(function* (operation: "materialize" | "cleanup", directory: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            return await lstat(directory, { bigint: true })
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw cause
          }
        },
        catch: (cause) =>
          new Error({
            operation,
            message: `Failed to inspect snapshot directory: ${directory}`,
            cause,
          }),
      })
    })

    const identityOf = (info: BigIntStats) => ({
      device: info.dev,
      inode: info.ino,
    })

    const sameIdentity = (info: BigIntStats, identity: DirectoryIdentity) =>
      info.dev === identity.device && info.ino === identity.inode

    const ownDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      const initial = yield* inspectDirectory("materialize", directory)
      if (!initial?.isDirectory() || initial.isSymbolicLink())
        return yield* new Error({
          operation: "materialize",
          message: "Snapshot destination is not an owned directory",
        })
      const identity = identityOf(initial)
      let cleaned = false
      const cleanup: Materialization["cleanup"] = Effect.uninterruptible(
        Effect.suspend(() => {
          if (cleaned) return Effect.void
          return inspectDirectory("cleanup", directory).pipe(
            Effect.flatMap((current) => {
              if (!current) {
                cleaned = true
                return Effect.void
              }
              if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity))
                return Effect.fail(
                  new Error({
                    operation: "cleanup",
                    message: "Refusing to remove a replaced snapshot destination",
                  }),
                )
              return fs.remove(directory, { recursive: true, force: true }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    cleaned = true
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new Error({
                      operation: "cleanup",
                      message: "Failed to remove snapshot destination",
                      cause,
                    }),
                ),
              )
            }),
          )
        }),
      )
      return { directory, identity, cleanup } satisfies OwnedDirectory
    })

    const assertOwnedDirectory = Effect.fnUntraced(function* (
      owned: OwnedDirectory,
      operation: "materialize" | "cleanup" = "materialize",
    ) {
      const current = yield* inspectDirectory(operation, owned.directory)
      if (
        !current?.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(current, owned.identity) ||
        (yield* fs.realPath(owned.directory).pipe(
          Effect.mapError(
            (cause) =>
              new Error({
                operation,
                message: "Failed to resolve snapshot destination",
                cause,
              }),
          ),
        )) !== owned.directory
      )
        return yield* new Error({
          operation,
          message: "Snapshot destination identity or canonical path changed",
        })
    })

    const finishMaterialization = Effect.fnUntraced(function* (
      repo: Git.Repository,
      snapshot: ID,
      owned: OwnedDirectory,
    ) {
      return yield* Effect.gen(function* () {
        yield* assertOwnedDirectory(owned)
        yield* git.tree
          .materialize({
            repository: repo,
            tree: Git.TreeID.make(snapshot),
            directory: owned.directory,
          })
          .pipe(Effect.mapError((cause) => failure("materialize", cause)))
        yield* assertOwnedDirectory(owned)
        return {
          directory: owned.directory,
          projectRoot: worktree,
          snapshot,
          cleanup: owned.cleanup,
        } satisfies Materialization
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? owned.cleanup : Effect.void)))
    })

    const protectedRoots = [worktree, gitDirectory, ...(source ? [source.gitDirectory, source.commonDirectory] : [])]

    const assertDestination = Effect.fnUntraced(function* (destination: AbsolutePath) {
      const canonicalProtectedRoots = yield* Effect.forEach(protectedRoots, (root) =>
        fs.realPath(root).pipe(
          Effect.mapError(
            (cause) =>
              new Error({
                operation: "materialize",
                message: "Failed to resolve protected repository storage",
                cause,
              }),
          ),
        ),
      )
      if (
        !path.isAbsolute(destination) ||
        path.normalize(destination) !== destination ||
        path.resolve(destination) !== destination ||
        canonicalProtectedRoots.some((root) => FileAccess.overlaps(root, destination))
      )
        return yield* new Error({
          operation: "materialize",
          message: "Snapshot destination must be canonical and outside repository storage",
        })

      const parent = path.dirname(destination)
      const info = yield* inspectDirectory("materialize", parent)
      const canonical = yield* fs.realPath(parent).pipe(
        Effect.mapError(
          (cause) =>
            new Error({
              operation: "materialize",
              message: "Failed to resolve snapshot destination parent",
              cause,
            }),
        ),
      )
      if (!info?.isDirectory() || info.isSymbolicLink() || canonical !== parent)
        return yield* new Error({
          operation: "materialize",
          message: "Snapshot destination parent must be a canonical directory",
        })
      return identityOf(info)
    })

    const assertParent = Effect.fnUntraced(function* (destination: AbsolutePath, identity: DirectoryIdentity) {
      const parent = path.dirname(destination)
      const info = yield* inspectDirectory("materialize", parent)
      const canonical = yield* fs.realPath(parent).pipe(
        Effect.mapError(
          (cause) =>
            new Error({
              operation: "materialize",
              message: "Failed to re-resolve snapshot destination parent",
              cause,
            }),
        ),
      )
      if (!info?.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, identity) || canonical !== parent)
        return yield* new Error({
          operation: "materialize",
          message: "Snapshot destination parent identity changed",
        })
    })

    const materialize = Effect.fn("Snapshot.materialize")(function* (snapshot: ID) {
      const repo = yield* repository("materialize")
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectory({ prefix: "phins-verifier-snapshot-" }).pipe(
            Effect.mapError(
              (cause) =>
                new Error({
                  operation: "materialize",
                  message: "Failed to create verifier snapshot directory",
                  cause,
                }),
            ),
          )
          const directory = yield* fs.realPath(temporary).pipe(
            Effect.map(AbsolutePath.make),
            Effect.catch((cause) =>
              fs.remove(temporary, { recursive: true, force: true }).pipe(
                Effect.mapError(
                  (cleanupCause) =>
                    new Error({
                      operation: "cleanup",
                      message: "Failed to clean unresolved verifier snapshot directory",
                      cause: cleanupCause,
                    }),
                ),
                Effect.andThen(
                  Effect.fail(
                    new Error({
                      operation: "materialize",
                      message: "Failed to resolve verifier snapshot directory",
                      cause,
                    }),
                  ),
                ),
              ),
            ),
          )
          const acquired = yield* ownDirectory(directory).pipe(Effect.exit)
          if (acquired._tag === "Failure") {
            yield* fs.remove(directory, { recursive: true, force: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new Error({
                    operation: "cleanup",
                    message: "Failed to clean unresolved verifier snapshot directory",
                    cause,
                  }),
              ),
            )
            return yield* Effect.failCause(acquired.cause)
          }
          const owned = acquired.value
          return yield* restore(finishMaterialization(repo, snapshot, owned))
        }),
      )
    })

    const materializeAt = Effect.fn("Snapshot.materializeAt")(function* (snapshot: ID, destination: AbsolutePath) {
      const repo = yield* repository("materialize")
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parentIdentity = yield* assertDestination(destination)
          yield* fs.makeDirectory(destination, { mode: 0o700 }).pipe(
            Effect.mapError(
              (cause) =>
                new Error({
                  operation: "materialize",
                  message: "Failed to exclusively create snapshot destination",
                  cause,
                }),
            ),
          )
          const acquired = yield* ownDirectory(destination).pipe(Effect.exit)
          if (acquired._tag === "Failure") {
            yield* fs.remove(destination, { recursive: true, force: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new Error({
                    operation: "cleanup",
                    message: "Failed to clean unresolved snapshot destination",
                    cause,
                  }),
              ),
            )
            return yield* Effect.failCause(acquired.cause)
          }
          const owned = acquired.value
          yield* assertParent(destination, parentIdentity).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? owned.cleanup : Effect.void)),
          )
          yield* assertOwnedDirectory(owned).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? owned.cleanup : Effect.void)),
          )
          return yield* restore(finishMaterialization(repo, snapshot, owned))
        }),
      )
    })

    return Service.of({
      capture,
      captureSubject,
      captureVerification,
      captureVerificationSubject,
      captureObservation,
      captureObservationSubject,
      retain,
      files,
      diff,
      preview,
      restore,
      checkout,
      materialize,
      materializeAt,
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    captureSubject: () => Effect.succeed(undefined),
    captureVerification: () => Effect.succeed(undefined),
    captureVerificationSubject: () => Effect.succeed(undefined),
    captureObservation: () => Effect.succeed(undefined),
    captureObservationSubject: () => Effect.succeed(undefined),
    retain: () =>
      Effect.fail(
        new Error({
          operation: "retain",
          message: "Snapshot retention is unavailable",
        }),
      ),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    materialize: () =>
      Effect.fail(
        new Error({
          operation: "materialize",
          message: "Snapshot materialization is unavailable",
        }),
      ),
    materializeAt: () =>
      Effect.fail(
        new Error({
          operation: "materialize",
          message: "Snapshot materialization is unavailable",
        }),
      ),
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
