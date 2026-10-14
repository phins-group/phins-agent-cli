import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Config } from "../src/settings/config"
import { FileAccess } from "../src/workspace/files/access"
import { Git } from "../src/workspace/repository/git"
import { AppPaths } from "../src/runtime/paths"
import { Location } from "../src/workspace/location"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath, RelativePath } from "../src/shared/schema"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { Hash } from "../src/shared/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            expect(snapshot.captureSubject).toBeDefined()
            const descriptor = yield* snapshot.captureSubject!()
            expect(descriptor).toMatchObject({
              version: 1,
              snapshot: before,
              algorithm: before.length === 40 ? "git-sha1-tree" : "git-sha256-tree",
              completeness: "location-filtered-v1",
              scope: RelativePath.make("scope"),
            })
            expect(descriptor?.storeNamespace).toStartWith("snapshot/")

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({
              files: plan,
              context: 1,
            })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("protects a new snapshot store with the canonical retention policy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => initializeProject(project))
          const storage = yield* snapshotDirectory(tmp.path, project)

          const captured = yield* Effect.gen(function* () {
            return yield* (yield* Snapshot.Service).capture()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))

          expect(captured).toBeDefined()
          expect(yield* readSnapshotRetention(storage)).toEqual(Array.from(Git.SNAPSHOT_RETENTION_CONFIG))
          if (captured)
            expect(
              yield* Effect.promise(() =>
                $`git --git-dir ${storage} show-ref --verify --hash ${Git.snapshotRef(captured)}`
                  .quiet()
                  .text()
                  .then((value) => value.trim()),
              ),
            ).toBe(captured)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("does not return a snapshot when its durable ref cannot be locked", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => initializeProject(project))
          const storage = yield* snapshotDirectory(tmp.path, project)

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            const captured = yield* service.capture()
            expect(captured).toBeDefined()
            if (!captured) return
            const ref = Git.snapshotRef(captured)
            const lock = path.join(storage, ...ref.split("/")) + ".lock"
            yield* Effect.promise(async () => {
              await $`git --git-dir ${storage} update-ref -d ${ref}`.quiet()
              await fs.mkdir(path.dirname(lock), { recursive: true })
              await fs.writeFile(lock, "held\n")
            })

            expect(yield* service.capture()).toBeUndefined()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("migrates an existing snapshot store before capture", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => initializeProject(project))
          const storage = yield* snapshotDirectory(tmp.path, project)
          yield* Effect.promise(async () => {
            await fs.mkdir(storage, { recursive: true })
            await $`git --git-dir ${storage} --work-tree ${project} init`.cwd(project).quiet()
            await $`git --git-dir ${storage} config gc.auto 1`.quiet()
            await $`git --git-dir ${storage} config gc.autoPackLimit 1`.quiet()
            await $`git --git-dir ${storage} config maintenance.auto true`.quiet()
            await $`git --git-dir ${storage} config gc.pruneExpire now`.quiet()
          })

          const captured = yield* Effect.gen(function* () {
            return yield* (yield* Snapshot.Service).capture()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))

          expect(captured).toBeDefined()
          expect(yield* readSnapshotRetention(storage)).toEqual(Array.from(Git.SNAPSHOT_RETENTION_CONFIG))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("shares one protected repository across concurrent captures", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => initializeProject(project))
          let ensureCalls = 0
          const countedGit = Layer.effect(
            Git.Service,
            Effect.gen(function* () {
              const service = yield* Git.Service
              return Git.Service.of({
                ...service,
                repo: {
                  ...service.repo,
                  ensureSnapshotRetention: (repository) =>
                    Effect.sync(() => {
                      ensureCalls += 1
                    }).pipe(
                      Effect.andThen(Effect.sleep("25 millis")),
                      Effect.andThen(service.repo.ensureSnapshotRetention(repository)),
                    ),
                },
              })
            }),
          ).pipe(Layer.provide(Git.defaultLayer))

          const captures = yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            return yield* Effect.all(Array.from({ length: 8 }, () => service.capture()), {
              concurrency: "unbounded",
            })
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project, countedGit)))

          expect(captures.every((snapshot) => snapshot !== undefined)).toBe(true)
          expect(ensureCalls).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("fails closed and invalidates a failed retention setup", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => initializeProject(project))
          let ensureCalls = 0
          let treeCalls = 0
          const rejectingGit = Layer.effect(
            Git.Service,
            Effect.gen(function* () {
              const service = yield* Git.Service
              return Git.Service.of({
                ...service,
                repo: {
                  ...service.repo,
                  ensureSnapshotRetention: (repository) =>
                    Effect.sync(() => {
                      ensureCalls += 1
                    }).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new Git.OperationError({
                            operation: "configure",
                            directory: repository.gitDirectory,
                            message: "retention rejected by test",
                          }),
                        ),
                      ),
                    ),
                },
                tree: {
                  ...service.tree,
                  capture: (input) =>
                    Effect.sync(() => {
                      treeCalls += 1
                    }).pipe(Effect.andThen(service.tree.capture(input))),
                  captureExact: (input) =>
                    Effect.sync(() => {
                      treeCalls += 1
                    }).pipe(Effect.andThen(service.tree.captureExact(input))),
                },
              })
            }),
          ).pipe(Layer.provide(Git.defaultLayer))

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            expect(yield* service.capture()).toBeUndefined()
            expect(yield* service.captureVerification()).toBeUndefined()
            const error = yield* Effect.flip(
              service.files({
                from: Snapshot.ID.make("missing-from"),
                to: Snapshot.ID.make("missing-to"),
              }),
            )
            expect(error).toBeInstanceOf(Snapshot.Error)
            expect(error.operation).toBe("files")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project, rejectingGit)))

          expect(ensureCalls).toBe(3)
          expect(treeCalls).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              Location.layer(Location.Ref.make({ directory: AbsolutePath.make(project) })).pipe(
                Layer.provide(ProjectRegistry.defaultLayer),
              ),
            ),
          )
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live(
    "captures a strict full-project verifier tree and cleans its isolated materialization",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const location = path.join(project, "scope")
            yield* Effect.promise(async () => {
              await fs.mkdir(location, { recursive: true })
              await fs.writeFile(path.join(location, "inside.txt"), "inside one\n")
              await fs.writeFile(path.join(project, "outside.txt"), "outside one\n")
              await fs.writeFile(path.join(project, "phins.json"), JSON.stringify({ snapshots: false }))
              await $`git init`.cwd(project).quiet()
              await $`git config core.fsmonitor false`.cwd(project).quiet()
              await $`git config commit.gpgsign false`.cwd(project).quiet()
              await $`git config user.email test@phins.test`.cwd(project).quiet()
              await $`git config user.name Test`.cwd(project).quiet()
              await $`git add .`.cwd(project).quiet()
              await $`git commit -m initial`.cwd(project).quiet()
              await fs.writeFile(path.join(project, ".gitignore"), "scope/inside.txt\noutside.txt\n")
              await fs.writeFile(path.join(location, "inside.txt"), "inside two\n")
              await fs.writeFile(path.join(project, "outside.txt"), "outside two\n")
            })

            const layer = snapshotLayer(tmp.path, location)
            yield* Effect.gen(function* () {
              const service = yield* Snapshot.Service
              expect(yield* service.capture()).toBeUndefined()
              const snapshot = yield* service.captureVerification()
              expect(snapshot).toBeDefined()
              if (!snapshot) return

              yield* Effect.promise(async () => {
                await fs.writeFile(path.join(location, "inside.txt"), "inside three\n")
                await fs.writeFile(path.join(project, "outside.txt"), "outside three\n")
              })
              const materialized = yield* service.materialize(snapshot)
              const canonicalProject = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(project)))
              expect(materialized.snapshot).toBe(snapshot)
              expect(materialized.projectRoot).toBe(canonicalProject)
              expect(materialized.directory).not.toBe(canonicalProject)
              expect(FileAccess.overlaps(materialized.directory, canonicalProject)).toBe(false)
              expect(yield* read(path.join(materialized.directory, "scope", "inside.txt"))).toBe("inside two\n")
              expect(yield* read(path.join(materialized.directory, "outside.txt"))).toBe("outside two\n")
              expect(yield* read(path.join(location, "inside.txt"))).toBe("inside three\n")
              expect(yield* read(path.join(project, "outside.txt"))).toBe("outside three\n")

              yield* materialized.cleanup
              yield* materialized.cleanup
              expect(
                yield* Effect.promise(() =>
                  fs.access(materialized.directory).then(
                    () => true,
                    () => false,
                  ),
                ),
              ).toBe(false)

              yield* Effect.promise(() =>
                fs.writeFile(path.join(project, "oversized-untracked.bin"), Buffer.alloc(2 * 1024 * 1024 + 1)),
              )
              expect(yield* service.captureVerification()).toBeUndefined()
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )

  testEffect(Layer.empty).live("materializes into one exclusive lease-owned destination", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const lease = path.join(tmp.path, "leases", "lease-1")
          const destination = AbsolutePath.make(path.join(lease, "subject"))
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "captured\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.mkdir(lease, { recursive: true, mode: 0o700 })
            await fs.writeFile(path.join(lease, "intent.json"), "keep\n")
          })

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            const snapshot = yield* service.captureVerification()
            expect(snapshot).toBeDefined()
            if (!snapshot) return

            const materialized = yield* service.materializeAt(snapshot, destination)
            expect(materialized.directory).toBe(destination)
            expect(yield* read(path.join(destination, "tracked.txt"))).toBe("captured\n")
            yield* materialized.cleanup
            yield* materialized.cleanup
            expect(yield* read(path.join(lease, "intent.json"))).toBe("keep\n")
            expect(yield* Effect.promise(() => fs.readdir(lease))).toEqual(["intent.json"])

            const replaced = AbsolutePath.make(path.join(lease, "replaced-subject"))
            const moved = path.join(lease, "moved-owned-subject")
            const victim = path.join(lease, "replacement-target")
            const replacement = yield* service.materializeAt(snapshot, replaced)
            yield* Effect.promise(async () => {
              await fs.rename(replaced, moved)
              await fs.mkdir(victim)
              await fs.writeFile(path.join(victim, "sentinel.txt"), "keep victim\n")
              await fs.symlink(victim, replaced)
            })
            expect(yield* Effect.exit(replacement.cleanup)).toMatchObject({
              _tag: "Failure",
            })
            expect(yield* read(path.join(victim, "sentinel.txt"))).toBe("keep victim\n")
            expect((yield* Effect.promise(() => fs.lstat(replaced))).isSymbolicLink()).toBe(true)
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("rejects overlap and symlink aliases without touching their targets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const leaseRoot = path.join(tmp.path, "leases")
          const realParent = path.join(leaseRoot, "real-parent")
          const parentAlias = path.join(leaseRoot, "parent-alias")
          const victim = path.join(tmp.path, "victim")
          const destinationLink = path.join(leaseRoot, "destination-link")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "captured\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.mkdir(realParent, { recursive: true, mode: 0o700 })
            await fs.mkdir(victim)
            await fs.writeFile(path.join(victim, "sentinel.txt"), "keep\n")
            await fs.symlink(realParent, parentAlias)
            await fs.symlink(victim, destinationLink)
          })

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            const snapshot = yield* service.captureVerification()
            expect(snapshot).toBeDefined()
            if (!snapshot) return

            const throughAlias = AbsolutePath.make(path.join(parentAlias, "subject"))
            expect(yield* Effect.exit(service.materializeAt(snapshot, throughAlias))).toMatchObject({
              _tag: "Failure",
            })
            expect(yield* Effect.promise(() => fs.readdir(realParent))).toEqual([])

            expect(
              yield* Effect.exit(service.materializeAt(snapshot, AbsolutePath.make(destinationLink))),
            ).toMatchObject({ _tag: "Failure" })
            expect(yield* read(path.join(victim, "sentinel.txt"))).toBe("keep\n")
            expect((yield* Effect.promise(() => fs.lstat(destinationLink))).isSymbolicLink()).toBe(true)

            const insideProject = AbsolutePath.make(path.join(project, "subject"))
            expect(yield* Effect.exit(service.materializeAt(snapshot, insideProject))).toMatchObject({
              _tag: "Failure",
            })
            expect(yield* Effect.promise(() => fs.readdir(project))).not.toContain("subject")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("cleans the fixed destination on failure and interruption", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const lease = path.join(tmp.path, "lease")
          const failed = AbsolutePath.make(path.join(lease, "failed"))
          const interrupted = AbsolutePath.make(path.join(lease, "interrupted"))
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "captured\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.mkdir(lease, { mode: 0o700 })
          })

          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const delayedGit = Layer.effect(
            Git.Service,
            Effect.gen(function* () {
              const service = yield* Git.Service
              return Git.Service.of({
                ...service,
                tree: {
                  ...service.tree,
                  materialize: (input) =>
                    input.tree === "not-a-tree"
                      ? service.tree.materialize(input)
                      : Deferred.succeed(started, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(service.tree.materialize(input)),
                        ),
                },
              })
            }),
          ).pipe(Layer.provide(Git.defaultLayer))

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            const snapshot = yield* service.captureVerification()
            expect(snapshot).toBeDefined()
            if (!snapshot) return

            expect(yield* Effect.exit(service.materializeAt(Snapshot.ID.make("not-a-tree"), failed))).toMatchObject({
              _tag: "Failure",
            })
            expect(yield* exists(failed)).toBe(false)

            const fiber = yield* service.materializeAt(snapshot, interrupted).pipe(Effect.forkChild)
            yield* Deferred.await(started)
            expect(yield* exists(interrupted)).toBe(true)
            yield* Fiber.interrupt(fiber)
            expect(yield* exists(interrupted)).toBe(false)
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project, delayedGit)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures strict Location identity across ignored cross-boundary renames", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "inside.txt"), "inside\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@phins.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.writeFile(path.join(project, ".gitignore"), "scope/inside.txt\n")
          })

          yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            const before = yield* service.captureObservation()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.rename(path.join(location, "inside.txt"), path.join(project, "moved-outside.txt"))
              await fs.writeFile(path.join(project, "outside.txt"), "outside two\n")
            })
            const afterRename = yield* service.captureObservation()
            expect(afterRename).toBeDefined()
            expect(afterRename).not.toBe(before)
            if (!afterRename) return

            yield* Effect.promise(() => fs.writeFile(path.join(project, "outside.txt"), "outside three\n"))
            expect(yield* service.captureObservation()).toBe(afterRename)
          }).pipe(Effect.provide(snapshotLayer(tmp.path, location)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string, gitLayer: Layer.Layer<Git.Service> = Git.defaultLayer) {
  const location = Location.layer(Location.Ref.make({ directory: AbsolutePath.make(directory) })).pipe(
    Layer.provide(ProjectRegistry.defaultLayer),
  )
  return Snapshot.layer.pipe(
    Layer.provide(location),
    Layer.provide(Config.locationLayer.pipe(Layer.provide(location))),
    Layer.provide(FileAccess.defaultLayer),
    Layer.provide(gitLayer),
    Layer.provide(AppPaths.layerWith({ data, config: path.join(data, "config") })),
  )
}

async function initializeProject(project: string) {
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, "tracked.txt"), "captured\n")
  await $`git init`.cwd(project).quiet()
  await $`git config core.fsmonitor false`.cwd(project).quiet()
  await $`git config commit.gpgsign false`.cwd(project).quiet()
  await $`git config user.email test@phins.test`.cwd(project).quiet()
  await $`git config user.name Test`.cwd(project).quiet()
  await $`git add .`.cwd(project).quiet()
  await $`git commit -m initial`.cwd(project).quiet()
}

const snapshotDirectory = (data: string, project: string) =>
  Effect.gen(function* () {
    const projectID = yield* Effect.gen(function* () {
      return (yield* Location.Service).project.id
    }).pipe(
      Effect.provide(
        Location.layer(Location.Ref.make({ directory: AbsolutePath.make(project) })).pipe(
          Layer.provide(ProjectRegistry.defaultLayer),
        ),
      ),
    )
    const worktree = yield* Effect.promise(() => fs.realpath(project))
    return AbsolutePath.make(path.join(data, "snapshot", projectID, Hash.fast(worktree)))
  })

const readSnapshotRetention = (gitDirectory: string) =>
  Effect.promise(async () =>
    Promise.all(
      Git.SNAPSHOT_RETENTION_CONFIG.map(async ([key]) => [
        key,
        (await $`git --git-dir ${gitDirectory} config --local --get ${key}`.quiet().text()).trim(),
      ] as const),
    ),
  )

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}

function exists(file: string) {
  return Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )
}
