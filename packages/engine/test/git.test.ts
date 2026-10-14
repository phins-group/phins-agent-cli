import { describe, expect } from "bun:test"
import { $ } from "bun"
import { spawn } from "node:child_process"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Git } from "../src/workspace/repository/git"
import { AbsolutePath, RelativePath } from "../src/shared/schema"
import { branch, commit, gitRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Git.defaultLayer)

describe("Git", () => {
  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({
          remote: fixture.remote,
          directory: target,
        })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({
          remote: fixture.remote,
          directory: target,
        })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, {
          branch: "feature/docs",
        })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

const readSnapshotRetention = (gitDirectory: string) =>
  Effect.promise(async () =>
    Promise.all(
      Git.SNAPSHOT_RETENTION_CONFIG.map(
        async ([key]) =>
          [key, (await $`git --git-dir ${gitDirectory} config --local --get ${key}`.quiet().text()).trim()] as const,
      ),
    ),
  )

const readSnapshotDescriptor = (gitDirectory: string) =>
  Effect.promise(() =>
    $`git --git-dir ${gitDirectory} config --local --get-all ${Git.SNAPSHOT_STORE_DESCRIPTOR_KEY}`
      .quiet()
      .text()
      .then((value) => value.trim()),
  )

const readSnapshotRef = (gitDirectory: string, tree: Git.TreeID) =>
  Effect.promise(() =>
    $`git --git-dir ${gitDirectory} show-ref --verify --hash ${Git.snapshotRef(tree)}`
      .quiet()
      .text()
      .then((value) => value.trim()),
  )

async function withAlternatesDisabled<A>(gitDirectory: string, fn: () => Promise<A>) {
  const alternates = path.join(gitDirectory, "objects", "info", "alternates")
  const parked = `${alternates}.test-disabled`
  await fs.rename(alternates, parked)
  try {
    return await fn()
  } finally {
    await fs.rename(parked, alternates)
  }
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@phins.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

function gitInput(directory: string, args: readonly string[], input: Uint8Array) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout))
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || `git exited ${code}`))
    })
    child.stdin.end(input)
  })
}

const rawTreeEntry = (mode: string, name: string | Uint8Array, object: string) =>
  Buffer.concat([
    Buffer.from(`${mode} `),
    typeof name === "string" ? Buffer.from(name) : Buffer.from(name),
    Buffer.of(0),
    Buffer.from(object, "hex"),
  ])

const writeRawTree = async (directory: string, entries: readonly Uint8Array[]) =>
  (
    await gitInput(
      directory,
      ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
      Buffer.concat(entries.map(Buffer.from)),
    )
  )
    .toString("utf8")
    .trim()

describe("Git snapshot retention", () => {
  it.live("persists and verifies the canonical retention policy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(root.path))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-retention"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })

          expect(Object.isFrozen(Git.SNAPSHOT_RETENTION_CONFIG)).toBe(true)
          expect(Git.SNAPSHOT_RETENTION_CONFIG.every(Object.isFrozen)).toBe(true)
          yield* git.repo.ensureSnapshotRetention(repository)
          expect(yield* readSnapshotRetention(storage)).toEqual(Array.from(Git.SNAPSHOT_RETENTION_CONFIG))
          expect(yield* readSnapshotDescriptor(storage)).toBe(Git.SNAPSHOT_STORE_DESCRIPTOR_JSON)
          expect(JSON.parse(yield* readSnapshotDescriptor(storage))).toEqual(Git.SNAPSHOT_STORE_DESCRIPTOR)

          yield* Effect.promise(() => $`git --git-dir ${storage} config gc.auto 99`.quiet())
          yield* git.repo.ensureSnapshotRetention(repository)
          expect(yield* readSnapshotRetention(storage)).toEqual(Array.from(Git.SNAPSHOT_RETENTION_CONFIG))
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("restores one crash-parked alternates file before using a snapshot store", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(root.path))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-parked-alternates"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const alternates = path.join(storage, "objects", "info", "alternates")
          const parked = `${alternates}.phins-reclamation-12345678-1234-4123-8123-123456789abc`
          const expected = yield* Effect.promise(() => fs.readFile(alternates, "utf8"))
          yield* Effect.promise(() => fs.rename(alternates, parked))

          yield* git.repo.ensureSnapshotRetention(repository)

          expect(yield* Effect.promise(() => fs.readFile(alternates, "utf8"))).toBe(expected)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(parked)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("resumes journaled garbage collection after candidate refs were deleted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "uncommitted.txt"), "journaled-gc\n")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-journaled-gc"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const tree = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })
          const marked = yield* git.tree.reconcileRetention({
            repository,
            live: [],
            nowMs: 10,
            minimumAgeMs: 0,
          })
          expect(marked.candidates).toBe(1)
          const stateText = yield* Effect.promise(() =>
            $`git --git-dir ${storage} config --local --get ${Git.SNAPSHOT_RECLAMATION_STATE_KEY}`.quiet().text(),
          )
          const state = JSON.parse(stateText.trim())
          yield* Effect.promise(async () => {
            await $`git --git-dir ${storage} config --local --replace-all ${Git.SNAPSHOT_RECLAMATION_STATE_KEY} ${JSON.stringify(
              { ...state, version: 3, phase: "gc-pending" },
            )}`.quiet()
            await $`git --git-dir ${storage} update-ref -d ${Git.snapshotRef(tree)} ${tree}`.quiet()
            await $`git --git-dir ${storage} update-ref -d ${Git.snapshotReclaimRef(tree)} ${tree}`.quiet()
          })

          const recovered = yield* git.tree.reconcileRetention({
            repository,
            live: [],
            nowMs: 20,
            minimumAgeMs: 0,
          })

          expect(recovered.reclaimed).toBe(0)
          expect(recovered.garbageCollected).toBe(true)
          expect(
            yield* Effect.promise(() =>
              withAlternatesDisabled(
                storage,
                async () => (await $`git --git-dir ${storage} cat-file -e ${tree}`.quiet().nothrow()).exitCode,
              ),
            ),
          ).not.toBe(0)
          const finalState = JSON.parse(
            (yield* Effect.promise(() =>
              $`git --git-dir ${storage} config --local --get ${Git.SNAPSHOT_RECLAMATION_STATE_KEY}`.quiet().text(),
            )).trim(),
          )
          expect(finalState).toMatchObject({ version: 3, phase: "prepared" })
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("restarts aging when candidate refs are newer than their journal", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "payload.txt"), "first\n")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-candidate-generation"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const first = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })
          yield* git.tree.reconcileRetention({
            repository,
            live: [],
            nowMs: 10,
            minimumAgeMs: 20,
          })

          yield* Effect.promise(() => fs.writeFile(path.join(project, "payload.txt"), "second\n"))
          const second = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })
          expect(second).not.toBe(first)
          // Model a kill after a newer candidate generation was published
          // but before its preparedAt journal could be replaced.
          yield* Effect.promise(() =>
            $`git --git-dir ${storage} update-ref ${Git.snapshotReclaimRef(second)} ${second}`.quiet(),
          )

          const recovered = yield* git.tree.reconcileRetention({
            repository,
            live: [],
            reclaim: true,
            nowMs: 1_000,
            minimumAgeMs: 20,
          })
          expect(recovered).toMatchObject({
            candidates: 2,
            reclaimed: 0,
            garbageCollected: false,
            preparedAt: 1_000,
            eligibleAt: 1_020,
          })
          expect(yield* readSnapshotRef(storage, first)).toBe(first)
          expect(yield* readSnapshotRef(storage, second)).toBe(second)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an incompatible versioned store descriptor before changing retention", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(root.path))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-descriptor-rejected"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const future = JSON.stringify({
            ...Git.SNAPSHOT_STORE_DESCRIPTOR,
            version: 2,
          })
          yield* Effect.promise(async () => {
            await $`git --git-dir ${storage} config --local ${Git.SNAPSHOT_STORE_DESCRIPTOR_KEY} ${future}`.quiet()
            await $`git --git-dir ${storage} config --local gc.auto 99`.quiet()
          })

          const error = yield* Effect.flip(git.repo.ensureSnapshotRetention(repository))
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("configure")
          expect(error.message).toContain("descriptor is incompatible")
          expect(yield* readSnapshotDescriptor(storage)).toBe(future)
          expect(
            yield* Effect.promise(() =>
              $`git --git-dir ${storage} config --local --get gc.auto`
                .quiet()
                .text()
                .then((value) => value.trim()),
            ),
          ).toBe("99")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("localizes standard and exact capture closures before returning their IDs", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "source-only\n")
            await $`git add tracked.txt`.cwd(project).quiet()
            await $`git commit -m tracked`.cwd(project).quiet()
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-localized"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* git.repo.ensureSnapshotRetention(repository)
          const sourceBlob = yield* Effect.promise(() =>
            $`git rev-parse HEAD:tracked.txt`
              .cwd(project)
              .quiet()
              .text()
              .then((value) => value.trim()),
          )
          expect(
            yield* Effect.promise(() =>
              withAlternatesDisabled(
                storage,
                async () => (await $`git --git-dir ${storage} cat-file -e ${sourceBlob}`.quiet().nothrow()).exitCode,
              ),
            ),
          ).not.toBe(0)

          const standard = yield* git.tree.capture({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })
          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "exact\n"))
          const exact = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })

          yield* Effect.promise(() =>
            withAlternatesDisabled(storage, async () => {
              expect(
                (await $`git --git-dir ${storage} fsck --strict ${standard} ${exact}`.quiet().nothrow()).exitCode,
              ).toBe(0)
              expect(await $`git --git-dir ${storage} cat-file blob ${`${standard}:tracked.txt`}`.quiet().text()).toBe(
                "source-only\n",
              )
              expect(await $`git --git-dir ${storage} cat-file blob ${`${exact}:tracked.txt`}`.quiet().text()).toBe(
                "exact\n",
              )
            }),
          )
          expect(yield* readSnapshotRef(storage, standard)).toBe(standard)
          expect(yield* readSnapshotRef(storage, exact)).toBe(exact)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("localizes one caller-authorized historical tree through the retain API", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "historical.txt"), "historical\n")
            await $`git add historical.txt`.cwd(project).quiet()
            await $`git commit -m historical`.cwd(project).quiet()
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-explicit-retain"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const tree = Git.TreeID.make(
            yield* Effect.promise(() =>
              $`git rev-parse HEAD^{tree}`
                .cwd(project)
                .quiet()
                .text()
                .then((value) => value.trim()),
            ),
          )

          yield* git.tree.retain({ repository, tree })

          yield* Effect.promise(() =>
            withAlternatesDisabled(storage, async () => {
              expect(await $`git --git-dir ${storage} cat-file blob ${`${tree}:historical.txt`}`.quiet().text()).toBe(
                "historical\n",
              )
            }),
          )
          expect(yield* readSnapshotRef(storage, tree)).toBe(tree)
          expect(yield* readSnapshotDescriptor(storage)).toBe(Git.SNAPSHOT_STORE_DESCRIPTOR_JSON)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live(
    "exports and imports one exact cross-host snapshot closure before pinning",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const project = path.join(root.path, "source-project")
            const targetWorktree = path.join(root.path, "target-worktree")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await fs.mkdir(targetWorktree)
              await initRepo(project)
              await fs.writeFile(path.join(project, "portable.txt"), "cross-host closure\n")
            })
            const git = yield* Git.Service
            const source = yield* git.repo.discover(AbsolutePath.make(project))
            if (!source) throw new Error("Repository not found")
            const sourceStore = AbsolutePath.make(path.join(root.path, ".snapshot-export"))
            const sourceRepository = yield* git.repo.create({
              worktree: source.worktree,
              gitDirectory: sourceStore,
              seed: source,
            })
            const tree = yield* git.tree.captureExact({
              repository: sourceRepository,
              scopes: [RelativePath.make(".")],
              ignores: source,
            })

            const closure = yield* git.tree.exportClosure({
              repository: sourceRepository,
              tree,
            })

            expect(closure.version).toBe(1)
            expect(closure.tree).toBe(tree)
            expect(closure.objectFormat).toBe("sha1")
            expect(closure.encoding).toBe("git-pack-v1")
            expect(closure.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
            expect(closure.pack.byteLength).toBeGreaterThan(12)
            expect(Buffer.from(closure.pack.subarray(0, 4)).toString("ascii")).toBe("PACK")
            expect(closure.objects).toEqual(Array.from(closure.objects).sort())
            expect(closure.objects).toContain(tree)

            const targetStore = AbsolutePath.make(path.join(root.path, ".snapshot-import"))
            const targetRepository = yield* git.repo.create({
              worktree: AbsolutePath.make(targetWorktree),
              gitDirectory: targetStore,
            })
            yield* git.tree.importClosure({
              repository: targetRepository,
              expectedTree: tree,
              closure,
            })

            expect(
              yield* git.tree.contains({
                repository: targetRepository,
                tree,
              }),
            ).toBe(true)
            expect(yield* readSnapshotRef(targetStore, tree)).toBe(tree)
            expect(
              yield* Effect.promise(() =>
                $`git --git-dir ${targetStore} cat-file blob ${`${tree}:portable.txt`}`.quiet().text(),
              ),
            ).toBe("cross-host closure\n")
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    30_000,
  )

  it.live(
    "rejects non-exact or corrupted snapshot closure envelopes before pinning",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const project = path.join(root.path, "source-project")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await initRepo(project)
              await fs.writeFile(path.join(project, "bounded.txt"), "bounded\n")
            })
            const git = yield* Git.Service
            const source = yield* git.repo.discover(AbsolutePath.make(project))
            if (!source) throw new Error("Repository not found")
            const sourceStore = AbsolutePath.make(path.join(root.path, ".snapshot-export-invalid"))
            const sourceRepository = yield* git.repo.create({
              worktree: source.worktree,
              gitDirectory: sourceStore,
              seed: source,
            })
            const tree = yield* git.tree.captureExact({
              repository: sourceRepository,
              scopes: [RelativePath.make(".")],
              ignores: source,
            })
            const closure = yield* git.tree.exportClosure({
              repository: sourceRepository,
              tree,
            })
            const cases: readonly {
              readonly closure: Git.SnapshotClosureV1
              readonly expectedTree?: Git.TreeID
            }[] = [
              {
                closure: {
                  ...closure,
                  digest: `sha256:${"0".repeat(64)}`,
                },
              },
              {
                closure: {
                  ...closure,
                  objects: closure.objects.filter((object) => object === tree),
                },
              },
              {
                closure: {
                  ...closure,
                  unexpected: true,
                } as Git.SnapshotClosureV1,
              },
              {
                closure: Object.fromEntries(
                  Object.entries(closure).filter(([key]) => key !== "objects"),
                ) as unknown as Git.SnapshotClosureV1,
              },
              {
                closure: {
                  ...closure,
                  objectFormat: "sha256",
                },
              },
              {
                closure: {
                  ...closure,
                  pack: new Uint8Array(Git.MAX_SNAPSHOT_TRANSFER_PACK_BYTES + 1),
                },
              },
              {
                closure,
                expectedTree: Git.TreeID.make("f".repeat(40)),
              },
            ]

            for (const [index, candidate] of cases.entries()) {
              const targetWorktree = path.join(root.path, `target-${index}`)
              yield* Effect.promise(() => fs.mkdir(targetWorktree))
              const targetStore = AbsolutePath.make(path.join(root.path, `.snapshot-import-invalid-${index}`))
              const targetRepository = yield* git.repo.create({
                worktree: AbsolutePath.make(targetWorktree),
                gitDirectory: targetStore,
              })

              const error = yield* Effect.flip(
                git.tree.importClosure({
                  repository: targetRepository,
                  expectedTree: candidate.expectedTree ?? tree,
                  closure: candidate.closure,
                }),
              )

              expect(error).toBeInstanceOf(Git.OperationError)
              expect(error.operation).toBe("retain")
              expect(
                yield* Effect.promise(() =>
                  $`git --git-dir ${targetStore} show-ref --verify ${Git.snapshotRef(tree)}`.quiet().nothrow(),
                ).pipe(Effect.map((result) => result.exitCode)),
              ).not.toBe(0)
              expect(
                yield* git.tree.contains({
                  repository: targetRepository,
                  tree,
                }),
              ).toBe(false)
            }
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    30_000,
  )

  it.live("fails closed when a historical tree closure is missing an alternate object", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "missing.txt"), "remove object after commit\n")
            await $`git add missing.txt`.cwd(project).quiet()
            await $`git commit -m missing`.cwd(project).quiet()
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-missing-closure"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const [treeText, blob] = yield* Effect.promise(async () =>
            Promise.all([
              $`git rev-parse HEAD^{tree}`.cwd(project).quiet().text(),
              $`git rev-parse HEAD:missing.txt`.cwd(project).quiet().text(),
            ]),
          )
          const tree = Git.TreeID.make(treeText.trim())
          const object = blob.trim()
          yield* Effect.promise(() =>
            fs.rm(path.join(source.commonDirectory, "objects", object.slice(0, 2), object.slice(2))),
          )

          const error = yield* Effect.flip(git.tree.retain({ repository, tree }))
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("retain")
          expect(
            yield* Effect.promise(() =>
              $`git --git-dir ${storage} show-ref --verify ${Git.snapshotRef(tree)}`.quiet().nothrow(),
            ).pipe(Effect.map((result) => result.exitCode)),
          ).not.toBe(0)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("retries bounded config-lock contention and converges across Git services", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(root.path))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-retention"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })

          yield* Effect.promise(() => fs.writeFile(path.join(storage, "config.lock"), "contended\n"))
          yield* Effect.sleep("35 millis").pipe(
            Effect.andThen(Effect.promise(() => fs.rm(path.join(storage, "config.lock")))),
            Effect.forkScoped,
          )
          yield* git.repo.ensureSnapshotRetention(repository)

          yield* Effect.promise(() => $`git --git-dir ${storage} config gc.pruneExpire now`.quiet())
          yield* Effect.all(
            Array.from({ length: 12 }, () =>
              Effect.gen(function* () {
                const isolated = yield* Git.Service
                yield* isolated.repo.ensureSnapshotRetention(repository)
              }).pipe(Effect.provide(Layer.fresh(Git.defaultLayer))),
            ),
            { concurrency: "unbounded" },
          )
          expect(yield* readSnapshotRetention(storage)).toEqual(Array.from(Git.SNAPSHOT_RETENTION_CONFIG))
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails with the configure reason after bounded config-lock retries", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(root.path))
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(root.path))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-retention"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* Effect.promise(() => fs.writeFile(path.join(storage, "config.lock"), "held\n"))

          const error = yield* Effect.flip(git.repo.ensureSnapshotRetention(repository))
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("configure")
          expect(error.message.toLowerCase()).toContain("could not lock config file")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("retains standard and exact captures across explicit garbage collection", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "base\n")
            await $`git add tracked.txt`.cwd(project).quiet()
            await $`git commit -m tracked`.cwd(project).quiet()
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-retained"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* git.repo.ensureSnapshotRetention(repository)

          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "standard\n"))
          const standard = yield* git.tree.capture({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })
          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "exact\n"))
          const exact = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          })

          expect(standard).not.toBe(exact)
          expect(yield* readSnapshotRef(storage, standard)).toBe(standard)
          expect(yield* readSnapshotRef(storage, exact)).toBe(exact)

          yield* Effect.promise(() =>
            $`git --git-dir ${storage} -c gc.pruneExpire=now gc --prune=now`.cwd(project).quiet(),
          )
          expect(yield* readSnapshotRef(storage, standard)).toBe(standard)
          expect(yield* readSnapshotRef(storage, exact)).toBe(exact)
          expect(
            yield* Effect.promise(() =>
              $`git --git-dir ${storage} cat-file blob ${`${exact}:tracked.txt`}`.quiet().text(),
            ),
          ).toBe("exact\n")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("repairs wrong and symbolic snapshot refs without changing their targets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-ref-repair"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* git.repo.ensureSnapshotRetention(repository)
          const capture = () =>
            git.tree.capture({
              repository,
              scopes: [RelativePath.make(".")],
              ignores: source,
            })

          const first = yield* capture()
          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "two\n"))
          const second = yield* capture()
          expect(first).not.toBe(second)

          yield* Effect.promise(() =>
            $`git --git-dir ${storage} update-ref ${Git.snapshotRef(first)} ${second}`.quiet(),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "one\n"))
          expect(yield* capture()).toBe(first)
          expect(yield* readSnapshotRef(storage, first)).toBe(first)

          yield* Effect.promise(async () => {
            await $`git --git-dir ${storage} update-ref -d ${Git.snapshotRef(first)}`.quiet()
            await $`git --git-dir ${storage} symbolic-ref ${Git.snapshotRef(first)} ${Git.snapshotRef(second)}`.quiet()
          })
          expect(yield* capture()).toBe(first)
          expect(yield* readSnapshotRef(storage, first)).toBe(first)
          expect(yield* readSnapshotRef(storage, second)).toBe(second)
          const symbolic = yield* Effect.promise(() =>
            $`git --git-dir ${storage} symbolic-ref --quiet ${Git.snapshotRef(first)}`.quiet().nothrow(),
          )
          expect(symbolic.exitCode).toBe(1)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails closed after bounded snapshot-ref lock retries", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "locked\n")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-ref-lock"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* git.repo.ensureSnapshotRetention(repository)
          const input = {
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
          }
          const tree = yield* git.tree.capture(input)
          const ref = Git.snapshotRef(tree)
          const lock = path.join(storage, ...ref.split("/")) + ".lock"
          yield* Effect.promise(async () => {
            await $`git --git-dir ${storage} update-ref -d ${ref}`.quiet()
            await fs.mkdir(path.dirname(lock), { recursive: true })
            await fs.writeFile(lock, "held\n")
          })

          const error = yield* Effect.flip(git.tree.capture(input))
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("retain")
          expect(error.message.toLowerCase()).toContain("cannot lock ref")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("converges concurrent exact captures on one content-addressed ref", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "concurrent\n")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(root.path, ".snapshot-ref-concurrent"))
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          yield* git.repo.ensureSnapshotRetention(repository)
          const capture = () =>
            Effect.gen(function* () {
              const isolated = yield* Git.Service
              return yield* isolated.tree.captureExact({
                repository,
                scopes: [RelativePath.make(".")],
                ignores: source,
              })
            }).pipe(Effect.provide(Layer.fresh(Git.defaultLayer)))

          const trees = yield* Effect.all(Array.from({ length: 12 }, capture), {
            concurrency: "unbounded",
          })
          expect(new Set(trees).size).toBe(1)
          const tree = trees[0]!
          expect(yield* readSnapshotRef(storage, tree)).toBe(tree)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(directory)
      if (!repo) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: repo, directory: worktree })

      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(repo.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(repo.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({
        repository: linked,
        directory: worktree,
        force: false,
      })
      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})

describe("Git trees", () => {
  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "one\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "outside\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot"))
      const repository = yield* git.repo.create({
        worktree: source.worktree,
        gitDirectory: storage,
        seed: source,
      })
      yield* git.index.refresh({
        repository,
        scope: RelativePath.make("scope"),
      })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({
        repository,
        scope: RelativePath.make("scope"),
      })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({
        repository,
        from: before,
        to: after,
        context: 1,
      })
      expect(diffs.map((item) => [item.path, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      const preview = yield* git.tree.preview({
        repository,
        current: after,
        files,
        context: 1,
      })
      expect(preview).toHaveLength(1)
      expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )

  it.live("captures strictly and materializes raw blobs without touching the worktree or shared index", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          const storage = AbsolutePath.make(path.join(root.path, "snapshot.git"))
          const destinationPath = path.join(root.path, "materialized")
          const cleanCanary = path.join(root.path, "host-clean-filter-ran")
          const smudgeCanary = path.join(root.path, "host-smudge-filter-ran")
          const filterCanaries = () =>
            Effect.promise(() => fs.readdir(root.path)).pipe(
              Effect.map((files) => files.filter((file) => file.startsWith("host-"))),
            )
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(
              path.join(project, ".gitattributes"),
              "*.filtered filter=hostile ident working-tree-encoding=UTF-8\n",
            )
            await fs.writeFile(path.join(project, "tracked.filtered"), "snapshot bytes\n")
            await fs.writeFile(path.join(project, "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
            await fs.mkdir(path.join(project, "empty-parent"))
            await fs.writeFile(path.join(project, "empty-parent", "file.txt"), "nested\n")
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m snapshot`.cwd(project).quiet()
            await fs.mkdir(destinationPath)
          })

          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          if (process.platform !== "win32")
            yield* Effect.promise(async () => {
              await $`git --git-dir ${storage} config filter.hostile.clean ${`sh -c 'touch "${cleanCanary}"; cat'`}`.quiet()
              await $`git --git-dir ${storage} config filter.hostile.smudge ${`sh -c 'touch "${smudgeCanary}"; cat'`}`.quiet()
              await $`git --git-dir ${storage} config filter.hostile.required true`.quiet()
            })
          const indexBefore = yield* Effect.promise(() => fs.readFile(path.join(storage, "index")))
          const tree = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
            maximumUntrackedFileBytes: 1024,
          })
          expect(yield* filterCanaries()).toEqual([])
          expect(
            (yield* Effect.promise(() => fs.readdir(storage))).filter((file) => file.startsWith("capture-")),
          ).toEqual([])
          const replacementTree = yield* Effect.promise(async () => {
            await fs.writeFile(path.join(project, "replacement.txt"), "replacement\n")
            const replacementBlob = (await $`git hash-object -w replacement.txt`.cwd(project).quiet().text()).trim()
            return writeRawTree(project, [rawTreeEntry("100644", "tracked.filtered", replacementBlob)])
          })
          expect(yield* filterCanaries()).toEqual([])
          yield* Effect.promise(() =>
            $`git --git-dir ${storage} update-ref ${`refs/replace/${tree}`} ${replacementTree}`.quiet(),
          )
          expect(yield* filterCanaries()).toEqual([])
          yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.filtered"), "worktree changed\n"))
          expect(yield* filterCanaries()).toEqual([])

          const destination = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(destinationPath)))
          const previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY
          process.env.GIT_OBJECT_DIRECTORY = path.join(root.path, "hostile-object-directory")
          const result = yield* git.tree.materialize({ repository, tree, directory: destination }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previousObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY
                else process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory
              }),
            ),
          )
          expect(yield* filterCanaries()).toEqual([])

          expect(result.tree).toBe(tree)
          expect(result.files).toBe(4)
          expect(result.bytes).toBeGreaterThan(0)
          expect(yield* read(path.join(destination, "tracked.filtered"))).toBe("snapshot bytes\n")
          expect(yield* read(path.join(destination, "empty-parent", "file.txt"))).toBe("nested\n")
          expect((yield* Effect.promise(() => fs.stat(destination))).mode & 0o777).toBe(0o700)
          expect((yield* Effect.promise(() => fs.stat(path.join(destination, "empty-parent")))).mode & 0o777).toBe(
            0o700,
          )
          expect((yield* Effect.promise(() => fs.stat(path.join(destination, "script.sh")))).mode & 0o111).toBe(0o111)
          expect(yield* Effect.promise(() => fs.readdir(destination))).not.toContain(".git")
          expect(yield* read(path.join(project, "tracked.filtered"))).toBe("worktree changed\n")
          expect((yield* Effect.promise(() => fs.readFile(path.join(storage, "index")))).equals(indexBefore)).toBe(true)
          expect(yield* filterCanaries()).toEqual([])
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails exact capture before hashing an oversized untracked file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          const storage = AbsolutePath.make(path.join(root.path, "snapshot.git"))
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "oversized.txt"), "too large")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })

          const error = yield* Effect.flip(
            git.tree.captureExact({
              repository,
              scopes: [RelativePath.make(".")],
              ignores: source,
              maximumUntrackedFileBytes: 4,
            }),
          )
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("capture")
          expect(error.message).toContain("exceeds 4 bytes")
          expect(
            (yield* Effect.promise(() => fs.readdir(storage))).filter((file) => file.startsWith("capture-")),
          ).toEqual([])
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("preflights the tracked-file cap before writing snapshot objects", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          const storage = AbsolutePath.make(path.join(root.path, "snapshot.git"))
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            const file = await fs.open(path.join(project, "oversized.bin"), "w")
            try {
              await file.truncate(Git.MAX_MATERIALIZED_FILE_BYTES + 1)
            } finally {
              await file.close()
            }
            const empty = (await gitInput(project, ["hash-object", "-w", "--stdin"], Buffer.alloc(0)))
              .toString("utf8")
              .trim()
            await $`git update-index --add --cacheinfo 100644 ${empty} oversized.bin`.cwd(project).quiet()
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const before = yield* Effect.promise(() => $`git --git-dir ${storage} count-objects -v`.quiet().text())

          const error = yield* Effect.flip(
            git.tree.captureExact({
              repository,
              scopes: [RelativePath.make(".")],
              ignores: source,
              maximumUntrackedFileBytes: 1,
            }),
          )
          const after = yield* Effect.promise(() => $`git --git-dir ${storage} count-objects -v`.quiet().text())

          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.operation).toBe("capture")
          expect(error.message).toContain(`exceeds ${Git.MAX_MATERIALIZED_FILE_BYTES} bytes`)
          expect(after).toBe(before)
          expect(
            (yield* Effect.promise(() => fs.readdir(storage))).filter((file) => file.startsWith("capture-")),
          ).toEqual([])
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps edited tracked files despite new ignores and omits deletions and ignored untracked files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          const storage = AbsolutePath.make(path.join(root.path, "snapshot.git"))
          const destinationPath = path.join(root.path, "materialized")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, ".gitignore"), "")
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "deleted.txt"), "delete me\n")
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m tracked`.cwd(project).quiet()

            // Keep the size identical to exercise Git's racy-index edge.
            await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
            await fs.writeFile(path.join(project, ".gitignore"), "*.txt\n")
            await fs.rm(path.join(project, "deleted.txt"))
            await fs.writeFile(path.join(project, "ignored.txt"), "ignored\n")
            await fs.mkdir(destinationPath)
          })

          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const tree = yield* git.tree.captureExact({
            repository,
            scopes: [RelativePath.make(".")],
            ignores: source,
            maximumUntrackedFileBytes: 1024,
          })
          const destination = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(destinationPath)))
          const result = yield* git.tree.materialize({
            repository,
            tree,
            directory: destination,
          })

          expect(result.files).toBe(2)
          expect(yield* read(path.join(destination, "tracked.txt"))).toBe("two\n")
          expect(yield* read(path.join(destination, ".gitignore"))).toBe("*.txt\n")
          expect(yield* Effect.promise(() => fs.readdir(destination))).not.toContain("deleted.txt")
          expect(yield* Effect.promise(() => fs.readdir(destination))).not.toContain("ignored.txt")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects non-tree IDs, symlinks, gitlinks, and unsafe or colliding paths before writing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const project = path.join(root.path, "project")
          const storage = AbsolutePath.make(path.join(root.path, "snapshot.git"))
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await initRepo(project)
            await fs.writeFile(path.join(project, "payload.txt"), "payload")
          })
          const git = yield* Git.Service
          const source = yield* git.repo.discover(AbsolutePath.make(project))
          if (!source) throw new Error("Repository not found")
          const repository = yield* git.repo.create({
            worktree: source.worktree,
            gitDirectory: storage,
            seed: source,
          })
          const blob = (yield* Effect.promise(() =>
            $`git hash-object -w payload.txt`.cwd(project).quiet().text(),
          )).trim()
          const commit = (yield* git.history.head(source))!
          const trees = yield* Effect.promise(async () => [
            await writeRawTree(project, [rawTreeEntry("120000", "escape", blob)]),
            await writeRawTree(project, [rawTreeEntry("160000", "vendor", commit)]),
            await writeRawTree(project, [rawTreeEntry("100644", "..", blob)]),
            await writeRawTree(project, [rawTreeEntry("100644", ".GiT", blob)]),
            await writeRawTree(project, [
              rawTreeEntry("100644", "Case.txt", blob),
              rawTreeEntry("100644", "case.txt", blob),
            ]),
            await writeRawTree(project, [rawTreeEntry("100644", "stream:name", blob)]),
            await writeRawTree(project, [rawTreeEntry("100644", "x".repeat(256), blob)]),
            await writeRawTree(project, [rawTreeEntry("100644", Buffer.of(0xff), blob)]),
          ])
          const candidates = [
            Git.TreeID.make("HEAD"),
            Git.TreeID.make("f".repeat(40)),
            Git.TreeID.make(blob),
            Git.TreeID.make(trees[0]!.toUpperCase()),
            ...trees.map((tree) => Git.TreeID.make(tree)),
          ]

          for (const [index, tree] of candidates.entries()) {
            const destinationPath = path.join(root.path, `rejected-${index}`)
            yield* Effect.promise(() => fs.mkdir(destinationPath))
            const destination = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(destinationPath)))
            const error = yield* Effect.flip(
              git.tree.materialize({
                repository,
                tree,
                directory: destination,
              }),
            )
            expect(error).toBeInstanceOf(Git.OperationError)
            expect(error.operation).toBe("materialize")
            expect(yield* Effect.promise(() => fs.readdir(destination))).toEqual([])
          }
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(root.path, "escape")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})
