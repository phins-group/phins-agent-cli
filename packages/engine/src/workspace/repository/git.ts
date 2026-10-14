export * as Git from "./git";

import path from "path";
import { randomUUID } from "crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { AbsolutePath, RelativePath } from "../../shared/schema";
import { FileAccess } from "../files/access";
import { ProcessRunner } from "../../execution/process/runner";
import { ServiceGraph } from "../../runtime/effect/service-graph";
import { File } from "../files/diff";
import { KeyedMutex } from "../../runtime/effect/keyed-mutex";
import { Flock } from "../../shared/flock";
import { Hash } from "../../shared/hash";

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

export const ChangeSet = Schema.String.pipe(Schema.brand("Git.ChangeSet"));
export type ChangeSet = typeof ChangeSet.Type;

export const TreeID = Schema.String.pipe(Schema.brand("Git.TreeID"));
export type TreeID = typeof TreeID.Type;

/** Canonical namespace used to retain captured snapshot trees. */
export const SNAPSHOT_REF_PREFIX = "refs/phins/snapshots";

/** Build the content-addressed ref for a captured snapshot tree. */
export const snapshotRef = (tree: string) => `${SNAPSHOT_REF_PREFIX}/${tree}`;

/** Candidate refs keep swept objects reachable until the atomic delete step. */
export const SNAPSHOT_RECLAIM_REF_PREFIX =
  "refs/phins/snapshot-reclaim-candidates";

export const snapshotReclaimRef = (tree: string) =>
  `${SNAPSHOT_RECLAIM_REF_PREFIX}/${tree}`;

/** Versioned contract persisted before a snapshot store may retain captures. */
export const SnapshotStoreDescriptorV1 = Schema.Struct({
  version: Schema.Literal(1),
  snapshotID: Schema.Literal("git-tree-oid"),
  localization: Schema.Literal("reachable-non-thin-pack-v1"),
  coverage: Schema.Literal("captures-after-descriptor"),
  retention: Schema.Literal("content-addressed-ref-v1"),
  reclamation: Schema.Literal("none"),
});
export type SnapshotStoreDescriptorV1 = typeof SnapshotStoreDescriptorV1.Type;

/** Installed only after an authoritative durable live-set backfill succeeds. */
export const SnapshotStoreDescriptorV2 = Schema.Struct({
  version: Schema.Literal(2),
  snapshotID: Schema.Literal("git-tree-oid"),
  localization: Schema.Literal("reachable-non-thin-pack-v1"),
  coverage: Schema.Literal("durable-live-set-backfill-v1"),
  retention: Schema.Literal("content-addressed-ref-v1"),
  reclamation: Schema.Literal("two-pass-live-mark-sweep-v1"),
});
export type SnapshotStoreDescriptorV2 = typeof SnapshotStoreDescriptorV2.Type;

export const SnapshotStoreDescriptor = Schema.Union([
  SnapshotStoreDescriptorV1,
  SnapshotStoreDescriptorV2,
]);
export type SnapshotStoreDescriptor = typeof SnapshotStoreDescriptor.Type;

export const SNAPSHOT_STORE_DESCRIPTOR = Object.freeze({
  version: 1,
  snapshotID: "git-tree-oid",
  localization: "reachable-non-thin-pack-v1",
  coverage: "captures-after-descriptor",
  retention: "content-addressed-ref-v1",
  reclamation: "none",
} as const satisfies SnapshotStoreDescriptor);

export const SNAPSHOT_STORE_DESCRIPTOR_V2 = Object.freeze({
  version: 2,
  snapshotID: "git-tree-oid",
  localization: "reachable-non-thin-pack-v1",
  coverage: "durable-live-set-backfill-v1",
  retention: "content-addressed-ref-v1",
  reclamation: "two-pass-live-mark-sweep-v1",
} as const satisfies SnapshotStoreDescriptor);

/** One atomic Git-config value keeps descriptor upgrades fail-closed. */
export const SNAPSHOT_STORE_DESCRIPTOR_KEY = "phins.snapshot.descriptor";
export const SNAPSHOT_STORE_DESCRIPTOR_JSON = JSON.stringify(
  SNAPSHOT_STORE_DESCRIPTOR,
);
export const SNAPSHOT_STORE_DESCRIPTOR_V2_JSON = JSON.stringify(
  SNAPSHOT_STORE_DESCRIPTOR_V2,
);

/** One exact value records the first pass used to age reclaim candidates. */
export const SNAPSHOT_RECLAMATION_STATE_KEY =
  "phins.snapshot.reclamation-state";
export const SNAPSHOT_RECLAMATION_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_SNAPSHOT_RETENTION_REFS = 100_000;
export const MAX_SNAPSHOT_RETENTION_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface SnapshotRetentionReport {
  readonly live: number;
  readonly retained: number;
  readonly candidates: number;
  readonly reclaimed: number;
  readonly garbageCollected: boolean;
  readonly preparedAt: number;
  readonly eligibleAt: number;
}

/**
 * Snapshot repositories retain captured trees under custom refs. These local
 * settings also prevent automatic maintenance from racing unretained legacy
 * objects while authoritative historical backfill and reclamation are pending.
 */
export const SNAPSHOT_RETENTION_CONFIG = Object.freeze([
  Object.freeze(["gc.auto", "0"] as const),
  Object.freeze(["gc.autoPackLimit", "0"] as const),
  Object.freeze(["maintenance.auto", "false"] as const),
  Object.freeze(["gc.pruneExpire", "never"] as const),
]);

/** Maximum in-memory non-thin pack accepted while localizing one capture. */
export const MAX_SNAPSHOT_LOCALIZATION_PACK_BYTES = 640 * 1024 * 1024;

/**
 * Cross-host replay is deliberately narrower than local retention. The
 * transfer stays buffered today, so reject oversized closures before they can
 * become an unbounded JSON/HTTP payload. A later streaming protocol may raise
 * this without weakening the pack contract.
 */
export const MAX_SNAPSHOT_TRANSFER_PACK_BYTES = 64 * 1024 * 1024;

/**
 * Canonical pack arguments. `--no-local` includes objects borrowed through an
 * alternate; disabling deltas makes the installed pack self-contained.
 */
export const SNAPSHOT_LOCALIZATION_PACK_ARGS = Object.freeze([
  "pack-objects",
  "--stdout",
  "--revs",
  "--no-thin",
  "--no-local",
  "--no-reuse-delta",
  "--no-reuse-object",
  "--window=0",
  "--depth=0",
  "--missing=error",
  "--no-use-bitmap-index",
] as const);

export interface SnapshotClosureV1 {
  readonly version: 1;
  readonly tree: TreeID;
  readonly objectFormat: "sha1" | "sha256";
  readonly encoding: "git-pack-v1";
  readonly digest: `sha256:${string}`;
  /** Canonical sorted object IDs for the tree's complete reachable closure. */
  readonly objects: readonly string[];
  readonly pack: Uint8Array;
}

export const MAX_MATERIALIZED_ENTRIES = 50_000;
export const MAX_MATERIALIZED_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_MATERIALIZED_PATH_BYTES = 4_096;
export const MAX_MATERIALIZED_SEGMENT_BYTES = 255;
export const MAX_MATERIALIZED_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_MATERIALIZED_TOTAL_BYTES = 512 * 1024 * 1024;

export interface MaterializedTree {
  readonly tree: TreeID;
  readonly files: number;
  readonly bytes: number;
}

export class OperationError extends Schema.TaggedErrorClass<OperationError>()(
  "Git.OperationError",
  {
    operation: Schema.Literals([
      "clone",
      "fetch",
      "checkout",
      "reset",
      "create",
      "configure",
      "retain",
      "reclaim",
      "refresh",
      "capture",
      "write_tree",
      "list_files",
      "diff",
      "restore",
      "materialize",
    ]),
    message: Schema.String,
    directory: Schema.optional(AbsolutePath),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literals(["main", "linked"]),
}) {}

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()(
  "Git.WorktreeError",
  {
    operation: Schema.Literals(["create", "remove", "list"]),
    message: Schema.String,
    directory: Schema.optional(AbsolutePath),
    forceRequired: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PatchError extends Schema.TaggedErrorClass<PatchError>()(
  "Git.PatchError",
  {
    operation: Schema.Literals(["capture", "apply", "reset"]),
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface Interface {
  readonly repo: {
    readonly discover: (
      input: AbsolutePath,
    ) => Effect.Effect<Repository | undefined>;
    readonly clone: (input: {
      remote: string;
      directory: AbsolutePath;
      branch?: string;
      depth?: number;
    }) => Effect.Effect<Repository, OperationError>;
    readonly create: (input: {
      worktree: AbsolutePath;
      gitDirectory: AbsolutePath;
      seed?: Repository;
    }) => Effect.Effect<Repository, OperationError>;
    readonly ensureSnapshotRetention: (
      repository: Repository,
    ) => Effect.Effect<void, OperationError>;
  };
  readonly remote: {
    readonly get: (
      repository: Repository,
      name?: string,
    ) => Effect.Effect<string | undefined>;
  };
  readonly history: {
    readonly head: (
      repository: Repository,
    ) => Effect.Effect<string | undefined>;
    readonly branch: (
      repository: Repository,
    ) => Effect.Effect<string | undefined>;
    readonly defaultRemoteBranch: (
      repository: Repository,
      remote?: string,
    ) => Effect.Effect<string | undefined>;
    readonly rootCommits: (
      repository: Repository,
    ) => Effect.Effect<readonly string[]>;
  };
  readonly sync: {
    readonly fetchRemotes: (
      repository: Repository,
      input?: { prune?: boolean },
    ) => Effect.Effect<void, OperationError>;
    readonly fetchBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) => Effect.Effect<void, OperationError>;
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, OperationError>;
    readonly resetHard: (
      repository: Repository,
      revision: string,
    ) => Effect.Effect<void, OperationError>;
  };
  readonly change: {
    readonly capture: (input: {
      repository: Repository;
      path: AbsolutePath;
    }) => Effect.Effect<ChangeSet, PatchError>;
    readonly apply: (input: {
      repository: Repository;
      path: AbsolutePath;
      changes: ChangeSet;
    }) => Effect.Effect<void, PatchError>;
    readonly discard: (input: {
      repository: Repository;
      path: AbsolutePath;
      index: "preserve" | "reset";
      untracked: "preserve" | "remove";
    }) => Effect.Effect<void, PatchError>;
  };
  readonly worktree: {
    readonly create: (input: {
      repository: Repository;
      directory: AbsolutePath;
    }) => Effect.Effect<Repository, WorktreeError>;
    readonly remove: (input: {
      repository: Repository;
      directory: AbsolutePath;
      force: boolean;
    }) => Effect.Effect<void, WorktreeError>;
    readonly list: (
      repository: Repository,
    ) => Effect.Effect<readonly Worktree[], WorktreeError>;
  };
  readonly index: {
    /** Refresh only the requested project-relative scope, preserving all other entries. */
    readonly refresh: (input: {
      repository: Repository;
      scope: RelativePath;
      ignores?: Repository;
      maximumUntrackedFileBytes?: number;
    }) => Effect.Effect<
      { readonly skipped: readonly RelativePath[] },
      OperationError
    >;
    readonly ignored: (input: {
      repository: Repository;
      paths: readonly RelativePath[];
    }) => Effect.Effect<ReadonlySet<RelativePath>, OperationError>;
  };
  readonly tree: {
    readonly capture: (input: {
      repository: Repository;
      scopes: readonly RelativePath[];
      ignores?: Repository;
      maximumUntrackedFileBytes?: number;
    }) => Effect.Effect<TreeID, OperationError>;
    readonly captureExact: (input: {
      repository: Repository;
      scopes: readonly RelativePath[];
      ignores?: Repository;
      maximumUntrackedFileBytes?: number;
    }) => Effect.Effect<TreeID, OperationError>;
    /** Localize and pin one caller-authorized historical or current tree. */
    readonly retain: (input: {
      repository: Repository;
      tree: TreeID;
    }) => Effect.Effect<void, OperationError>;
    /** Return whether a canonical ID names a tree visible to this store. */
    readonly contains: (input: {
      repository: Repository;
      tree: TreeID;
    }) => Effect.Effect<boolean, OperationError>;
    /** Export the exact reachable non-thin closure of one retained tree. */
    readonly exportClosure: (input: {
      repository: Repository;
      tree: TreeID;
    }) => Effect.Effect<SnapshotClosureV1, OperationError>;
    /** Verify, install, localize and pin one cross-host closure. */
    readonly importClosure: (input: {
      repository: Repository;
      expectedTree: TreeID;
      closure: SnapshotClosureV1;
    }) => Effect.Effect<void, OperationError>;
    /** Backfill the complete live set and advance two-pass reclamation safely. */
    readonly reconcileRetention: (input: {
      repository: Repository;
      live: readonly TreeID[];
      reclaim?: boolean;
      nowMs?: number;
      minimumAgeMs?: number;
    }) => Effect.Effect<SnapshotRetentionReport, OperationError>;
    readonly write: (
      repository: Repository,
    ) => Effect.Effect<TreeID, OperationError>;
    readonly files: (input: {
      repository: Repository;
      from: TreeID;
      to: TreeID;
    }) => Effect.Effect<readonly RelativePath[], OperationError>;
    readonly diff: (input: {
      repository: Repository;
      from: TreeID;
      to: TreeID;
      context?: number;
      paths?: readonly RelativePath[];
    }) => Effect.Effect<readonly File.Diff[], OperationError>;
    readonly preview: (input: {
      repository: Repository;
      current: TreeID;
      files: ReadonlyMap<RelativePath, TreeID>;
      context?: number;
    }) => Effect.Effect<readonly File.Diff[], OperationError>;
    readonly restore: (input: {
      repository: Repository;
      files: ReadonlyMap<RelativePath, TreeID>;
    }) => Effect.Effect<void, OperationError>;
    readonly checkout: (input: {
      repository: Repository;
      tree: TreeID;
    }) => Effect.Effect<void, OperationError>;
    /** Materialize raw tree blobs into an existing empty directory without touching the repository worktree. */
    readonly materialize: (input: {
      repository: Repository;
      tree: TreeID;
      directory: AbsolutePath;
    }) => Effect.Effect<MaterializedTree, OperationError>;
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/GitV2",
) {}

type MaterializationEntry =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly object: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly object: string;
      readonly executable: boolean;
      readonly size: number;
    };

const RESERVED_WINDOWS_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const materializationFailure = (message: string) =>
  new globalThis.Error(message);

const validateMaterializedPath = (input: string) => {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes === 0 || bytes > MAX_MATERIALIZED_PATH_BYTES)
    throw materializationFailure(
      `Tree path must be between 1 and ${MAX_MATERIALIZED_PATH_BYTES} UTF-8 bytes`,
    );
  if (
    /^[A-Za-z]:/.test(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input)
  )
    throw materializationFailure(
      `Tree path must be relative: ${JSON.stringify(input)}`,
    );
  if (input.includes("\\") || path.posix.normalize(input) !== input)
    throw materializationFailure(
      `Tree path is not portable and normalized: ${JSON.stringify(input)}`,
    );
  const segments = input.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.toLowerCase() === ".git" ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      RESERVED_WINDOWS_SEGMENT.test(segment) ||
      /[<>:"|?*]/.test(segment) ||
      /[\u0000-\u001f\u007f]/.test(segment) ||
      Buffer.byteLength(segment, "utf8") > MAX_MATERIALIZED_SEGMENT_BYTES
    )
      throw materializationFailure(
        `Tree path contains an unsafe segment: ${JSON.stringify(input)}`,
      );
  }
};

const decodeMaterializationManifest = (
  input: Uint8Array,
  objectBytes: number,
): MaterializationEntry[] => {
  if (input.length > 0 && input[input.length - 1] !== 0)
    throw materializationFailure("Git returned an unterminated tree manifest");
  const records = Buffer.from(input)
    .subarray(0, Math.max(0, input.length - 1))
    .toString("latin1");
  const rawRecords = records.length === 0 ? [] : records.split("\0");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: MaterializationEntry[] = [];
  const exact = new Map<string, MaterializationEntry["kind"]>();
  const portable = new Map<string, string>();
  let totalBytes = 0n;

  for (const rawRecord of rawRecords) {
    if (entries.length >= MAX_MATERIALIZED_ENTRIES)
      throw materializationFailure(
        `Tree exceeds ${MAX_MATERIALIZED_ENTRIES} materialized entries`,
      );
    const record = decoder.decode(Buffer.from(rawRecord, "latin1"));
    const delimiter = record.indexOf("\t");
    if (delimiter <= 0)
      throw materializationFailure(
        "Git returned a malformed tree manifest entry",
      );
    const metadata = record.slice(0, delimiter);
    const treePath = record.slice(delimiter + 1);
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+) +(-|\d+)$/.exec(
      metadata,
    );
    if (!match || match[3]?.length !== objectBytes * 2)
      throw materializationFailure(
        "Git returned a malformed tree manifest entry",
      );
    validateMaterializedPath(treePath);

    const collisionKey = treePath.normalize("NFC").toLowerCase();
    const collision = portable.get(collisionKey);
    if (collision !== undefined)
      throw materializationFailure(
        `Tree contains colliding paths: ${JSON.stringify(collision)} and ${JSON.stringify(treePath)}`,
      );
    if (exact.has(treePath))
      throw materializationFailure(
        `Tree contains a duplicate path: ${JSON.stringify(treePath)}`,
      );

    const mode = match[1];
    const type = match[2];
    const object = match[3];
    const sizeText = match[4];
    let entry: MaterializationEntry;
    if (mode === "040000" && type === "tree" && sizeText === "-") {
      entry = { kind: "directory", path: treePath, object };
    } else if (
      (mode === "100644" || mode === "100755") &&
      type === "blob" &&
      sizeText !== "-"
    ) {
      const size = BigInt(sizeText);
      if (size > BigInt(MAX_MATERIALIZED_FILE_BYTES))
        throw materializationFailure(
          `Tree blob exceeds ${MAX_MATERIALIZED_FILE_BYTES} bytes: ${JSON.stringify(treePath)}`,
        );
      totalBytes += size;
      if (totalBytes > BigInt(MAX_MATERIALIZED_TOTAL_BYTES))
        throw materializationFailure(
          `Tree exceeds ${MAX_MATERIALIZED_TOTAL_BYTES} materialized bytes`,
        );
      entry = {
        kind: "file",
        path: treePath,
        object,
        executable: mode === "100755",
        size: Number(size),
      };
    } else if (mode === "120000") {
      throw materializationFailure(
        `Tree symlinks are not allowed: ${JSON.stringify(treePath)}`,
      );
    } else if (mode === "160000" || type === "commit") {
      throw materializationFailure(
        `Tree gitlinks are not allowed: ${JSON.stringify(treePath)}`,
      );
    } else {
      throw materializationFailure(
        `Tree entry mode is not allowed: ${JSON.stringify(treePath)}`,
      );
    }
    exact.set(treePath, entry.kind);
    portable.set(collisionKey, treePath);
    entries.push(entry);
  }

  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join("/");
      const kind = exact.get(ancestor);
      if (kind !== "directory")
        throw materializationFailure(
          `Tree path has an invalid ancestor: ${JSON.stringify(ancestor)}`,
        );
    }
  }
  return entries;
};

const decodeExactCapturePaths = (input: Uint8Array) => {
  if (input.length > 0 && input[input.length - 1] !== 0)
    throw materializationFailure(
      "Git returned an unterminated exact-capture path list",
    );
  const records = Buffer.from(input)
    .subarray(0, Math.max(0, input.length - 1))
    .toString("latin1");
  if (records.length === 0) return [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: RelativePath[] = [];
  const portable = new Map<string, string>();
  for (const record of records.split("\0")) {
    if (paths.length >= MAX_MATERIALIZED_ENTRIES)
      throw materializationFailure(
        `Exact capture exceeds ${MAX_MATERIALIZED_ENTRIES} entries`,
      );
    const candidate = decoder.decode(Buffer.from(record, "latin1"));
    validateMaterializedPath(candidate);
    const collisionKey = candidate.normalize("NFC").toLowerCase();
    const collision = portable.get(collisionKey);
    if (collision !== undefined)
      throw materializationFailure(
        `Exact capture contains colliding paths: ${JSON.stringify(collision)} and ${JSON.stringify(candidate)}`,
      );
    portable.set(collisionKey, candidate);
    paths.push(RelativePath.make(candidate));
  }
  return paths;
};

const snapshotStoreLocks = KeyedMutex.makeUnsafe<string>();

/** Serialize snapshot-store index, descriptor, alternate, and ref mutations. */
export const withSnapshotStoreLock = <A, E, R>(
  gitDirectory: string,
  effect: Effect.Effect<A, E, R>,
) =>
  snapshotStoreLocks.withLock(gitDirectory)(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Flock.effect(`snapshot-store:${gitDirectory}`, {
          dir: path.join(gitDirectory, "phins-locks"),
        });
        return yield* effect;
      }),
    ),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileAccess.Service;
    const proc = yield* ProcessRunner.Service;
    const retainedSnapshotRepositories = new WeakSet<Repository>();
    const snapshotObjectCharacters = new WeakMap<Repository, 40 | 64>();
    const snapshotRetentionArgs = SNAPSHOT_RETENTION_CONFIG.flatMap(
      ([key, value]) => ["-c", `${key}=${value}`],
    );
    const locked = <A, E, R>(
      repository: Repository,
      effect: Effect.Effect<A, E, R>,
    ) => withSnapshotStoreLock(repository.gitDirectory, effect);

    const discover = Effect.fn("Git.repo.discover")(function* (
      input: AbsolutePath,
    ) {
      const dotgit = yield* fs.up({ targets: [".git"], start: input }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (!dotgit) return undefined;

      const cwd = path.dirname(dotgit);
      const git = run(cwd, proc);
      const topLevel = yield* git(["rev-parse", "--show-toplevel"]);
      const gitDir = yield* git(["rev-parse", "--git-dir"]);
      const commonDir = yield* git(["rev-parse", "--git-common-dir"]);
      if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return undefined;

      return new Repository({
        worktree: AbsolutePath.make(
          topLevel.exitCode === 0 ? resolvePath(cwd, topLevel.text) : cwd,
        ),
        gitDirectory: AbsolutePath.make(resolvePath(cwd, gitDir.text)),
        commonDirectory: AbsolutePath.make(resolvePath(cwd, commonDir.text)),
      });
    });

    const remote = Effect.fn("Git.remote.get")(function* (
      repository: Repository,
      name = "origin",
    ) {
      const result = yield* run(
        repository.worktree,
        proc,
      )(["remote", "get-url", name]);
      if (result.exitCode !== 0) return undefined;
      return result.text.trim() || undefined;
    });

    const roots = Effect.fn("Git.history.rootCommits")(function* (
      repository: Repository,
    ) {
      const result = yield* run(
        repository.worktree,
        proc,
      )(["rev-list", "--max-parents=0", "HEAD"]);
      if (result.exitCode !== 0) return [];
      return result.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted();
    });

    const head = Effect.fn("Git.history.head")(function* (
      repository: Repository,
    ) {
      const result = yield* run(
        repository.worktree,
        proc,
      )(["rev-parse", "HEAD"]);
      if (result.exitCode !== 0) return undefined;
      return result.text.trim() || undefined;
    });

    const branch = Effect.fn("Git.history.branch")(function* (
      repository: Repository,
    ) {
      const result = yield* run(
        repository.worktree,
        proc,
      )(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (result.exitCode !== 0) return undefined;
      return result.text.trim() || undefined;
    });

    const remoteHead = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Repository,
      remoteName = "origin",
    ) {
      const result = yield* run(
        repository.worktree,
        proc,
      )(["symbolic-ref", `refs/remotes/${remoteName}/HEAD`]);
      if (result.exitCode !== 0) return undefined;
      return (
        result.text
          .trim()
          .replace(new RegExp(`^refs/remotes/${remoteName}/`), "") || undefined
      );
    });

    const operation = Effect.fnUntraced(function* (
      operation: OperationError["operation"],
      directory: AbsolutePath,
      args: string[],
    ) {
      const result = yield* execute(
        directory,
        proc,
      )(args).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation,
              directory,
              message: cause.message,
              cause,
            }),
        ),
      );
      if (result.exitCode === 0) return;
      return yield* new OperationError({
        operation,
        directory,
        message:
          result.stderr.trim() ||
          result.text.trim() ||
          `Git ${operation} failed`,
      });
    });

    const clone = Effect.fn("Git.repo.clone")(function* (input: {
      remote: string;
      directory: AbsolutePath;
      branch?: string;
      depth?: number;
    }) {
      yield* operation(
        "clone",
        AbsolutePath.make(path.dirname(input.directory)),
        [
          "clone",
          "--depth",
          String(input.depth ?? 100),
          ...(input.branch ? ["--branch", input.branch] : []),
          "--",
          input.remote,
          input.directory,
        ],
      );
      const repository = yield* discover(input.directory);
      if (repository) return repository;
      return yield* new OperationError({
        operation: "clone",
        directory: input.directory,
        message: "Cloned repository could not be opened",
      });
    });

    const fetch = Effect.fn("Git.sync.fetchRemotes")(function* (
      repository: Repository,
      input: { prune?: boolean } = {},
    ) {
      yield* operation("fetch", repository.worktree, [
        "fetch",
        "--all",
        ...(input.prune === false ? [] : ["--prune"]),
      ]);
    });

    const fetchBranch = Effect.fn("Git.sync.fetchBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) {
      const remoteName = input.remote ?? "origin";
      const spec = `refs/heads/${input.branch}:refs/remotes/${remoteName}/${input.branch}`;
      yield* operation("fetch", repository.worktree, [
        "fetch",
        remoteName,
        input.force === false ? spec : `+${spec}`,
      ]);
    });

    const checkout = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) {
      const remoteName = input.remote ?? "origin";
      yield* operation("checkout", repository.worktree, [
        "checkout",
        ...(input.reset === false
          ? [input.branch]
          : ["-B", input.branch, `${remoteName}/${input.branch}`]),
      ]);
    });

    const reset = Effect.fn("Git.sync.resetHard")(function* (
      repository: Repository,
      revision: string,
    ) {
      yield* operation("reset", repository.worktree, [
        "reset",
        "--hard",
        revision,
      ]);
    });

    const repositoryArgs = (repository: Repository, args: string[]) => [
      "--git-dir",
      repository.gitDirectory,
      "--work-tree",
      repository.worktree,
      ...(retainedSnapshotRepositories.has(repository)
        ? snapshotRetentionArgs
        : []),
      ...args,
    ];

    const repositoryOperation = Effect.fnUntraced(function* (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: { stdin?: string; env?: Record<string, string> },
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", repositoryArgs(repository, args), {
            cwd: repository.worktree,
            env: options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: operationName,
                directory: repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        );
      const text = result.stdout.toString("utf8");
      if (result.exitCode === 0)
        return { text, stderr: result.stderr.toString("utf8") };
      return yield* new OperationError({
        operation: operationName,
        directory: repository.worktree,
        message:
          result.stderr.toString("utf8").trim() ||
          text.trim() ||
          `Git ${operationName} failed`,
      });
    });

    const localConfigValues = Effect.fnUntraced(function* (
      repository: Repository,
      key: string,
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make(
            "git",
            repositoryArgs(repository, ["config", "--local", "--get-all", key]),
            {
              cwd: repository.worktree,
              env: { LANG: "C", LC_ALL: "C" },
              extendEnv: true,
            },
          ),
          { maxOutputBytes: 64 * 1024, maxErrorBytes: 64 * 1024 },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "configure",
                directory: repository.gitDirectory,
                message: cause.message,
                cause,
              }),
          ),
        );
      if (
        result.exitCode === 1 &&
        result.stdout.length === 0 &&
        result.stderr.length === 0
      )
        return [];
      if (result.exitCode !== 0)
        return yield* new OperationError({
          operation: "configure",
          directory: repository.gitDirectory,
          message:
            result.stderr.toString("utf8").trim() ||
            "Failed to read snapshot store descriptor",
        });
      if (result.stdoutTruncated || result.stderrTruncated)
        return yield* new OperationError({
          operation: "configure",
          directory: repository.gitDirectory,
          message: "Snapshot store descriptor exceeded its output limit",
        });
      return result.stdout
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .filter((value) => value.length > 0);
    });

    const persistSnapshotDescriptor = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const existing = yield* localConfigValues(
        repository,
        SNAPSHOT_STORE_DESCRIPTOR_KEY,
      );
      const compatible = (value: string) =>
        value === SNAPSHOT_STORE_DESCRIPTOR_JSON ||
        value === SNAPSHOT_STORE_DESCRIPTOR_V2_JSON;
      if (
        existing.length > 0 &&
        (existing.length !== 1 || !compatible(existing[0] ?? ""))
      )
        return yield* new OperationError({
          operation: "configure",
          directory: repository.gitDirectory,
          message:
            "Snapshot store descriptor is incompatible with this runtime",
        });
      if (existing.length === 0)
        yield* repositoryOperation(
          "configure",
          repository,
          [
            "config",
            "--local",
            "--replace-all",
            SNAPSHOT_STORE_DESCRIPTOR_KEY,
            SNAPSHOT_STORE_DESCRIPTOR_JSON,
          ],
          { env: { LANG: "C", LC_ALL: "C" } },
        );
      const verified = yield* localConfigValues(
        repository,
        SNAPSHOT_STORE_DESCRIPTOR_KEY,
      );
      if (verified.length === 1 && compatible(verified[0] ?? "")) return;
      return yield* new OperationError({
        operation: "configure",
        directory: repository.gitDirectory,
        message: "Snapshot store descriptor was not persisted exactly",
      });
    });

    const upgradeSnapshotDescriptor = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const existing = yield* localConfigValues(
        repository,
        SNAPSHOT_STORE_DESCRIPTOR_KEY,
      );
      if (
        existing.length !== 1 ||
        (existing[0] !== SNAPSHOT_STORE_DESCRIPTOR_JSON &&
          existing[0] !== SNAPSHOT_STORE_DESCRIPTOR_V2_JSON)
      )
        return yield* new OperationError({
          operation: "reclaim",
          directory: repository.gitDirectory,
          message:
            "Snapshot store descriptor cannot be upgraded from an incompatible value",
        });
      if (existing[0] !== SNAPSHOT_STORE_DESCRIPTOR_V2_JSON)
        yield* repositoryOperation(
          "reclaim",
          repository,
          [
            "config",
            "--local",
            "--replace-all",
            SNAPSHOT_STORE_DESCRIPTOR_KEY,
            SNAPSHOT_STORE_DESCRIPTOR_V2_JSON,
          ],
          { env: { LANG: "C", LC_ALL: "C" } },
        );
      const verified = yield* localConfigValues(
        repository,
        SNAPSHOT_STORE_DESCRIPTOR_KEY,
      );
      if (
        verified.length === 1 &&
        verified[0] === SNAPSHOT_STORE_DESCRIPTOR_V2_JSON
      )
        return;
      return yield* new OperationError({
        operation: "reclaim",
        directory: repository.gitDirectory,
        message: "Snapshot store descriptor upgrade was not persisted exactly",
      });
    });

    const persistSnapshotRetention = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const environment = { LANG: "C", LC_ALL: "C" };
      for (const [key, value] of SNAPSHOT_RETENTION_CONFIG) {
        yield* repositoryOperation(
          "configure",
          repository,
          ["config", "--local", "--replace-all", key, value],
          {
            env: environment,
          },
        );
      }
      for (const [key, expected] of SNAPSHOT_RETENTION_CONFIG) {
        const result = yield* repositoryOperation(
          "configure",
          repository,
          ["config", "--local", "--get-all", key],
          {
            env: environment,
          },
        );
        const values = result.text
          .replaceAll("\r\n", "\n")
          .split("\n")
          .filter((value) => value.length > 0);
        if (values.length === 1 && values[0] === expected) continue;
        return yield* new OperationError({
          operation: "configure",
          directory: repository.gitDirectory,
          message: `Snapshot retention setting ${key} was not persisted exactly`,
        });
      }
    });

    const isConfigLockRace = (cause: OperationError) => {
      const message = cause.message.toLowerCase();
      return (
        message.includes("could not lock config file") &&
        (message.includes("file exists") || message.includes("already exists"))
      );
    };

    const persistSnapshotRetentionWithRetry = (
      repository: Repository,
      attempt = 0,
    ): Effect.Effect<void, OperationError> =>
      persistSnapshotRetention(repository).pipe(
        Effect.catch((cause) => {
          if (attempt >= 4 || !isConfigLockRace(cause))
            return Effect.fail(cause);
          return Effect.sleep(Duration.millis(10 * 2 ** attempt)).pipe(
            Effect.andThen(
              persistSnapshotRetentionWithRetry(repository, attempt + 1),
            ),
          );
        }),
      );

    const persistSnapshotDescriptorWithRetry = (
      repository: Repository,
      attempt = 0,
    ): Effect.Effect<void, OperationError> =>
      persistSnapshotDescriptor(repository).pipe(
        Effect.catch((cause) => {
          if (attempt >= 4 || !isConfigLockRace(cause))
            return Effect.fail(cause);
          return Effect.sleep(Duration.millis(10 * 2 ** attempt)).pipe(
            Effect.andThen(
              persistSnapshotDescriptorWithRetry(repository, attempt + 1),
            ),
          );
        }),
      );

    const parkedAlternatesPattern =
      /^alternates\.phins-(?:localization|reclamation)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    const recoverParkedSnapshotAlternates = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const infoDirectory = path.join(
        repository.gitDirectory,
        "objects",
        "info",
      );
      if (!(yield* fs.existsSafe(infoDirectory))) return;
      const entries = yield* fs.readDirectoryEntries(infoDirectory).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "retain",
              directory: repository.gitDirectory,
              message: "Failed to inspect parked snapshot alternates",
              cause,
            }),
        ),
      );
      const suspicious = entries.filter((entry) =>
        entry.name.startsWith("alternates.phins-"),
      );
      if (
        suspicious.some(
          (entry) =>
            entry.type !== "file" || !parkedAlternatesPattern.test(entry.name),
        ) ||
        suspicious.length > 1
      )
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot store has ambiguous parked alternates",
        });
      if (suspicious.length === 0) return;

      const alternates = path.join(infoDirectory, "alternates");
      if (yield* fs.existsSafe(alternates))
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message:
            "Snapshot store has both active and parked alternates; refusing recovery",
        });
      yield* fs
        .rename(path.join(infoDirectory, suspicious[0]!.name), alternates)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "retain",
                directory: repository.gitDirectory,
                message: "Failed to restore parked snapshot alternates",
                cause,
              }),
          ),
        );
    });

    const ensureSnapshotRetention = Effect.fn(
      "Git.repo.ensureSnapshotRetention",
    )((repository: Repository) =>
      locked(
        repository,
        Effect.gen(function* () {
          yield* recoverParkedSnapshotAlternates(repository);
          yield* persistSnapshotDescriptorWithRetry(repository);
          yield* persistSnapshotRetentionWithRetry(repository);
          retainedSnapshotRepositories.add(repository);
        }),
      ),
    );

    const objectOperation = Effect.fnUntraced(function* (
      repository: Repository,
      args: readonly string[],
      maximumOutputBytes: number,
      options: {
        readonly operation?: "capture" | "materialize" | "retain" | "reclaim";
        readonly stdin?: Uint8Array;
        readonly environment?: Readonly<Record<string, string>>;
        readonly worktree?: boolean;
      } = {},
    ) {
      const operationName = options.operation ?? "materialize";
      const environment: Record<string, string> = {
        ...options.environment,
        PATH:
          process.env.PATH ??
          (process.platform === "win32"
            ? "C:\\Windows\\System32"
            : "/usr/bin:/bin"),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
      };
      if (process.platform === "win32" && process.env.SystemRoot)
        environment.SystemRoot = process.env.SystemRoot;
      const result = yield* proc
        .run(
          ChildProcess.make(
            "git",
            [
              "--git-dir",
              repository.gitDirectory,
              ...(options.worktree ? ["--work-tree", repository.worktree] : []),
              ...(retainedSnapshotRepositories.has(repository)
                ? snapshotRetentionArgs
                : []),
              ...args,
            ],
            {
              cwd: options.worktree
                ? repository.worktree
                : repository.gitDirectory,
              env: environment,
              extendEnv: false,
              stdin: "ignore",
            },
          ),
          {
            maxOutputBytes: maximumOutputBytes,
            maxErrorBytes: 64 * 1024,
            stdin: options.stdin,
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: operationName,
                directory: repository.gitDirectory,
                message: cause.message,
                cause,
              }),
          ),
        );
      if (result.exitCode !== 0)
        return yield* new OperationError({
          operation: operationName,
          directory: repository.gitDirectory,
          message:
            result.stderr.toString("utf8").trim() ||
            result.stdout.toString("utf8").trim() ||
            "Git object operation failed",
        });
      if (result.stdoutTruncated || result.stderrTruncated)
        return yield* new OperationError({
          operation: operationName,
          directory: repository.gitDirectory,
          message: "Git object operation exceeded its output limit",
        });
      return result.stdout;
    });

    const snapshotObjectIDCharacters = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const cached = snapshotObjectCharacters.get(repository);
      if (cached !== undefined) return cached;
      const format = (yield* objectOperation(
        repository,
        ["rev-parse", "--show-object-format"],
        32,
        {
          operation: "retain",
        },
      ))
        .toString("utf8")
        .trim();
      const characters =
        format === "sha1" ? 40 : format === "sha256" ? 64 : undefined;
      if (characters === undefined)
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot retention requires a supported Git object format",
        });
      snapshotObjectCharacters.set(repository, characters);
      return characters;
    });

    const snapshotClosureManifest = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
      environment?: Readonly<Record<string, string>>,
    ) {
      const objects = yield* objectOperation(
        repository,
        ["rev-list", "--objects", "--no-object-names", tree],
        MAX_MATERIALIZED_MANIFEST_BYTES,
        { operation: "retain", environment },
      );
      const characters = yield* snapshotObjectIDCharacters(repository);
      const ids = objects
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .filter(Boolean);
      if (
        ids.length === 0 ||
        ids[0] !== tree ||
        ids.some((id) => !new RegExp(`^[0-9a-f]{${characters}}$`).test(id))
      )
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message:
            "Snapshot localization produced an invalid reachable-object manifest",
        });
      const checked = yield* objectOperation(
        repository,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        MAX_MATERIALIZED_MANIFEST_BYTES,
        { operation: "retain", stdin: objects, environment },
      );
      const results = checked
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .filter(Boolean);
      if (
        results.length !== ids.length ||
        results.some(
          (result, index) =>
            !result.startsWith(`${ids[index]} `) ||
            result.endsWith(" missing"),
        )
      )
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message:
            "Snapshot reachable closure is not present in the local object database",
        });
      return Object.freeze(ids.toSorted());
    });

    const verifyLocalizedSnapshotTree = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
    ) {
      const verify = snapshotClosureManifest(repository, tree);
      const alternates = path.join(
        repository.gitDirectory,
        "objects",
        "info",
        "alternates",
      );
      if (!(yield* fs.existsSafe(alternates))) return yield* verify;

      const parked = `${alternates}.phins-localization-${randomUUID()}`;
      const move = (from: string, to: string, message: string) =>
        fs.rename(from, to).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "retain",
                directory: repository.gitDirectory,
                message,
                cause,
              }),
          ),
        );
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* move(
            alternates,
            parked,
            "Failed to disable snapshot alternates for localization verification",
          );
          const result = yield* restore(verify).pipe(Effect.exit);
          yield* move(
            parked,
            alternates,
            "Failed to restore snapshot alternates after localization verification",
          );
          if (result._tag === "Success") return result.value;
          return yield* Effect.failCause(result.cause);
        }),
      );
    });

    const localizeSnapshotTree = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
    ) {
      const alreadyLocal = yield* verifyLocalizedSnapshotTree(
        repository,
        tree,
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (alreadyLocal) return;

      const pack = yield* objectOperation(
        repository,
        SNAPSHOT_LOCALIZATION_PACK_ARGS,
        MAX_SNAPSHOT_LOCALIZATION_PACK_BYTES,
        { operation: "retain", stdin: Buffer.from(`${tree}\n`, "utf8") },
      );
      if (pack.length < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK")
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot localization did not produce a canonical pack",
        });

      const characters = yield* snapshotObjectIDCharacters(repository);
      const installed = (yield* objectOperation(
        repository,
        ["index-pack", "--stdin", "--strict"],
        characters + 8,
        {
          operation: "retain",
          stdin: pack,
        },
      ))
        .toString("utf8")
        .trim();
      if (!new RegExp(`^pack\\s[0-9a-f]{${characters}}$`).test(installed))
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot localization pack was not installed exactly",
        });
      yield* verifyLocalizedSnapshotTree(repository, tree);
    });

    const snapshotTreeExists = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
      operation: "retain" | "reclaim",
    ) {
      const characters = yield* snapshotObjectIDCharacters(repository);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))
        return yield* new OperationError({
          operation,
          directory: repository.gitDirectory,
          message: "Snapshot must be a canonical full tree object ID",
        });
      if (tree.length !== characters) return false;
      const output = (yield* objectOperation(
        repository,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        characters + 16,
        {
          operation,
          stdin: Buffer.from(`${tree}\n`, "utf8"),
        },
      ))
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .trimEnd();
      if (output === `${tree} missing`) return false;
      if (output === `${tree} tree`) return true;
      return yield* new OperationError({
        operation,
        directory: repository.gitDirectory,
        message: "Snapshot ID resolved to an unexpected Git object",
      });
    });

    const listRetentionRefs = Effect.fnUntraced(function* (
      repository: Repository,
      prefix: string,
    ) {
      const characters = yield* snapshotObjectIDCharacters(repository);
      const output = (yield* objectOperation(
        repository,
        ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
        MAX_SNAPSHOT_RETENTION_MANIFEST_BYTES,
        { operation: "reclaim" },
      ))
        .toString("utf8")
        .replaceAll("\r\n", "\n");
      if (/\0|\r/.test(output))
        return yield* new OperationError({
          operation: "reclaim",
          directory: repository.gitDirectory,
          message: "Snapshot retention ref manifest is not canonical",
        });
      const refs = new Map<TreeID, string>();
      const lines = output.split("\n").filter(Boolean);
      if (lines.length > MAX_SNAPSHOT_RETENTION_REFS)
        return yield* new OperationError({
          operation: "reclaim",
          directory: repository.gitDirectory,
          message: `Snapshot retention exceeds ${MAX_SNAPSHOT_RETENTION_REFS} refs`,
        });
      for (const line of lines) {
        const separator = line.indexOf(" ");
        const ref = separator === -1 ? "" : line.slice(0, separator);
        const object = separator === -1 ? "" : line.slice(separator + 1);
        if (!ref.startsWith(`${prefix}/`))
          return yield* new OperationError({
            operation: "reclaim",
            directory: repository.gitDirectory,
            message: "Snapshot retention ref escaped its namespace",
          });
        const suffix = ref.slice(prefix.length + 1);
        if (
          !new RegExp(`^[0-9a-f]{${characters}}$`).test(suffix) ||
          object !== suffix ||
          refs.has(TreeID.make(suffix))
        )
          return yield* new OperationError({
            operation: "reclaim",
            directory: repository.gitDirectory,
            message: "Snapshot retention ref did not match its exact tree",
          });
        refs.set(TreeID.make(suffix), object);
      }
      return refs;
    });

    const exactRetentionRefTarget = Effect.fnUntraced(function* (
      repository: Repository,
      prefix: string,
      tree: TreeID,
      operation: "retain" | "reclaim",
    ) {
      const output = (yield* objectOperation(
        repository,
        [
          "for-each-ref",
          "--format=%(objectname)",
          "--count=1",
          `${prefix}/${tree}`,
        ],
        tree.length + 2,
        { operation },
      ))
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .trimEnd();
      if (output === "") return undefined;
      if (output === tree) return tree;
      return yield* new OperationError({
        operation,
        directory: repository.gitDirectory,
        message: "Snapshot retention ref did not match its exact tree",
      });
    });

    type ReclamationState = {
      readonly version: 3;
      readonly digest: string;
      /** Exact candidate generation aged by this journal entry. */
      readonly candidatesDigest?: string;
      readonly preparedAt: number;
      readonly phase: "prepared" | "gc-pending";
    };

    const reclamationCandidatesDigest = (
      candidates: ReadonlyMap<TreeID, string>,
    ) =>
      `sha256:${Hash.sha256(
        JSON.stringify(
          Array.from(candidates).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      )}`;

    const readReclamationState = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const values = yield* localConfigValues(
        repository,
        SNAPSHOT_RECLAMATION_STATE_KEY,
      );
      if (values.length === 0) return undefined;
      if (values.length !== 1)
        return yield* new OperationError({
          operation: "reclaim",
          directory: repository.gitDirectory,
          message: "Snapshot reclamation state is ambiguous",
        });
      return yield* Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(values[0] ?? "");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new globalThis.Error("state is not an object");
          const record = parsed as Record<string, unknown>;
          const keys = Object.keys(record).sort().join("\0");
          const legacy =
            record.version === 1 &&
            keys === ["digest", "preparedAt", "version"].sort().join("\0");
          const previous =
            record.version === 2 &&
            keys ===
              ["digest", "phase", "preparedAt", "version"].sort().join("\0");
          const current =
            record.version === 3 &&
            keys ===
              [
                "candidatesDigest",
                "digest",
                "phase",
                "preparedAt",
                "version",
              ]
                .sort()
                .join("\0");
          if (
            (!legacy && !previous && !current) ||
            typeof record.digest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(record.digest) ||
            (current &&
              (typeof record.candidatesDigest !== "string" ||
                !/^sha256:[0-9a-f]{64}$/.test(record.candidatesDigest))) ||
            typeof record.preparedAt !== "number" ||
            !Number.isSafeInteger(record.preparedAt) ||
            record.preparedAt < 0 ||
            ((previous || current) &&
              record.phase !== "prepared" &&
              record.phase !== "gc-pending")
          )
            throw new globalThis.Error("state has an invalid shape");
          return {
            version: 3,
            digest: record.digest,
            ...(current
              ? { candidatesDigest: record.candidatesDigest as string }
              : {}),
            preparedAt: record.preparedAt,
            phase: previous || current
              ? (record.phase as ReclamationState["phase"])
              : "prepared",
          } satisfies ReclamationState;
        },
        catch: (cause) =>
          new OperationError({
            operation: "reclaim",
            directory: repository.gitDirectory,
            message: "Snapshot reclamation state is invalid",
            cause,
          }),
      });
    });

    const persistReclamationState = Effect.fnUntraced(function* (
      repository: Repository,
      state: ReclamationState,
    ) {
      const encoded = JSON.stringify(state);
      yield* repositoryOperation(
        "reclaim",
        repository,
        [
          "config",
          "--local",
          "--replace-all",
          SNAPSHOT_RECLAMATION_STATE_KEY,
          encoded,
        ],
        { env: { LANG: "C", LC_ALL: "C" } },
      );
      const verified = yield* localConfigValues(
        repository,
        SNAPSHOT_RECLAMATION_STATE_KEY,
      );
      if (verified.length === 1 && verified[0] === encoded) return;
      return yield* new OperationError({
        operation: "reclaim",
        directory: repository.gitDirectory,
        message: "Snapshot reclamation state was not persisted exactly",
      });
    });

    const updateCandidateRefs = Effect.fnUntraced(function* (
      repository: Repository,
      existing: ReadonlyMap<TreeID, string>,
      desired: ReadonlyMap<TreeID, string>,
    ) {
      const commands: string[] = ["start"];
      for (const [tree, object] of existing) {
        if (desired.has(tree)) continue;
        commands.push(`delete ${snapshotReclaimRef(tree)} ${object}`);
      }
      for (const [tree, object] of desired) {
        if (existing.has(tree)) continue;
        commands.push(`create ${snapshotReclaimRef(tree)} ${object}`);
      }
      if (commands.length === 1) return;
      commands.push("prepare", "commit", "");
      yield* repositoryOperation(
        "reclaim",
        repository,
        ["update-ref", "--stdin"],
        { stdin: commands.join("\n") },
      );
    });

    const sweepCandidateRefs = Effect.fnUntraced(function* (
      repository: Repository,
      snapshotRefs: ReadonlyMap<TreeID, string>,
      candidates: ReadonlyMap<TreeID, string>,
    ) {
      if (candidates.size === 0) return;
      const commands: string[] = ["start"];
      for (const [tree, object] of candidates) {
        const retained = snapshotRefs.get(tree);
        if (retained !== undefined)
          commands.push(`delete ${snapshotRef(tree)} ${retained}`);
        commands.push(`delete ${snapshotReclaimRef(tree)} ${object}`);
      }
      commands.push("prepare", "commit", "");
      yield* repositoryOperation(
        "reclaim",
        repository,
        ["update-ref", "--stdin"],
        { stdin: commands.join("\n") },
      );
    });

    const garbageCollectSnapshotStore = Effect.fnUntraced(function* (
      repository: Repository,
    ) {
      const collect = Effect.gen(function* () {
        yield* repositoryOperation("reclaim", repository, [
          "reflog",
          "expire",
          "--expire=now",
          "--expire-unreachable=now",
          "--all",
        ]);
        yield* repositoryOperation("reclaim", repository, [
          "gc",
          "--prune=now",
        ]);
      });
      const alternates = path.join(
        repository.gitDirectory,
        "objects",
        "info",
        "alternates",
      );
      if (!(yield* fs.existsSafe(alternates))) return yield* collect;
      const parked = `${alternates}.phins-reclamation-${randomUUID()}`;
      const move = (from: string, to: string, message: string) =>
        fs.rename(from, to).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "reclaim",
                directory: repository.gitDirectory,
                message,
                cause,
              }),
          ),
        );
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* move(
            alternates,
            parked,
            "Failed to disable snapshot alternates before reclamation",
          );
          const result = yield* restore(collect).pipe(Effect.exit);
          yield* move(
            parked,
            alternates,
            "Failed to restore snapshot alternates after reclamation",
          );
          if (result._tag === "Success") return result.value;
          return yield* Effect.failCause(result.cause);
        }),
      );
    });

    const isRefLockRace = (cause: OperationError) => {
      const message = cause.message.toLowerCase();
      return (
        message.includes("cannot lock ref") &&
        (message.includes("file exists") ||
          message.includes("another git process"))
      );
    };

    const updateSnapshotRef = (
      repository: Repository,
      ref: string,
      tree: TreeID,
      attempt = 0,
    ): Effect.Effect<void, OperationError> =>
      objectOperation(repository, ["update-ref", "--no-deref", ref, tree], 16, {
        operation: "retain",
      }).pipe(
        Effect.asVoid,
        Effect.catch((cause) => {
          if (attempt >= 4 || !isRefLockRace(cause)) return Effect.fail(cause);
          return Effect.sleep(Duration.millis(10 * 2 ** attempt)).pipe(
            Effect.andThen(
              updateSnapshotRef(repository, ref, tree, attempt + 1),
            ),
          );
        }),
      );

    const retainSnapshotTree = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
    ) {
      const characters = yield* snapshotObjectIDCharacters(repository);
      if (!new RegExp(`^[0-9a-f]{${characters}}$`).test(tree))
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot must be a canonical full tree object ID",
        });
      const type = (yield* objectOperation(
        repository,
        ["cat-file", "-t", tree],
        16,
        {
          operation: "retain",
        },
      ))
        .toString("utf8")
        .trim();
      if (type !== "tree")
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot retention target is not a tree",
        });

      yield* localizeSnapshotTree(repository, tree);
      const ref = snapshotRef(tree);
      yield* updateSnapshotRef(repository, ref, tree);
      // Re-retaining a tree is an authoritative liveness signal. Requiring the
      // expected old value makes a corrupted candidate fail closed.
      const reclaimCandidate = yield* exactRetentionRefTarget(
        repository,
        SNAPSHOT_RECLAIM_REF_PREFIX,
        tree,
        "retain",
      );
      if (reclaimCandidate !== undefined)
        yield* objectOperation(
          repository,
          ["update-ref", "-d", snapshotReclaimRef(tree), tree],
          16,
          { operation: "retain" },
        );
      const retained = (yield* objectOperation(
        repository,
        ["show-ref", "--verify", "--hash", ref],
        characters + 1,
        {
          operation: "retain",
        },
      ))
        .toString("utf8")
        .trim();
      if (retained !== tree)
        return yield* new OperationError({
          operation: "retain",
          directory: repository.gitDirectory,
          message: "Snapshot retention ref did not persist the exact tree",
        });
    });

    const snapshotClosureFailure = (
      repository: Repository,
      message: string,
    ) =>
      new OperationError({
        operation: "retain",
        directory: repository.gitDirectory,
        message,
      });

    const sameObjectManifest = (
      left: readonly string[],
      right: readonly string[],
    ) =>
      left.length === right.length &&
      left.every((object, index) => object === right[index]);

    const validateSnapshotClosure = Effect.fnUntraced(function* (
      repository: Repository,
      closure: SnapshotClosureV1,
    ) {
      const keys = Object.keys(closure as object).sort();
      const expectedKeys = [
        "digest",
        "encoding",
        "objectFormat",
        "objects",
        "pack",
        "tree",
        "version",
      ];
      if (!sameObjectManifest(keys, expectedKeys))
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure envelope fields are not exact",
        );
      const version = closure.version;
      const tree = closure.tree;
      const objectFormat = closure.objectFormat;
      const encoding = closure.encoding;
      const digest = closure.digest;
      const sourceObjects = closure.objects;
      const sourcePack = closure.pack;
      if (version !== 1 || encoding !== "git-pack-v1")
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure protocol is incompatible",
        );
      if (!Array.isArray(sourceObjects) || sourceObjects.length === 0)
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure object manifest is empty",
        );
      const objects = Object.freeze(Array.from(sourceObjects));
      if (
        !(sourcePack instanceof Uint8Array) ||
        sourcePack.byteLength < 12 ||
        sourcePack.byteLength > MAX_SNAPSHOT_TRANSFER_PACK_BYTES
      )
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure pack exceeded its canonical bounds",
        );
      const pack = Buffer.from(sourcePack);
      const characters = yield* snapshotObjectIDCharacters(repository);
      const targetObjectFormat = characters === 40 ? "sha1" : "sha256";
      if (objectFormat !== targetObjectFormat)
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure object format does not match the target store",
        );
      const objectPattern = new RegExp(`^[0-9a-f]{${characters}}$`);
      if (!objectPattern.test(tree))
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure tree is not a canonical full object ID",
        );
      let manifestBytes = 0;
      let previous: string | undefined;
      let containsTree = false;
      for (const object of objects) {
        if (
          typeof object !== "string" ||
          !objectPattern.test(object) ||
          (previous !== undefined && previous >= object)
        )
          return yield* snapshotClosureFailure(
            repository,
            "Snapshot closure object manifest is not canonical",
          );
        manifestBytes += Buffer.byteLength(object, "utf8") + 1;
        if (manifestBytes > MAX_SNAPSHOT_RETENTION_MANIFEST_BYTES)
          return yield* snapshotClosureFailure(
            repository,
            "Snapshot closure object manifest exceeded its byte limit",
          );
        if (object === tree) containsTree = true;
        previous = object;
      }
      if (!containsTree)
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure object manifest does not contain its tree",
        );
      if (pack.subarray(0, 4).toString("ascii") !== "PACK")
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure did not contain a Git pack",
        );
      if (!/^sha256:[0-9a-f]{64}$/.test(digest))
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure digest is not canonical",
        );
      const actualDigest = `sha256:${Hash.sha256(pack)}`;
      if (digest !== actualDigest)
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure digest does not match its pack",
        );
      return { characters, objects, pack, tree };
    });

    const inspectSnapshotClosurePack = Effect.fnUntraced(function* (
      repository: Repository,
      pack: Uint8Array,
      characters: 40 | 64,
      objectDirectory: string,
      environment?: Readonly<Record<string, string>>,
    ) {
      const installed = (yield* objectOperation(
        repository,
        ["index-pack", "--stdin", "--strict"],
        characters + 8,
        {
          operation: "retain",
          stdin: pack,
          environment,
        },
      ))
        .toString("utf8")
        .trim();
      const match = new RegExp(
        `^pack\\s([0-9a-f]{${characters}})$`,
      ).exec(installed);
      if (!match)
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure pack was not installed exactly",
        );
      const packHash = match[1]!;
      const index = path.join(
        objectDirectory,
        "pack",
        `pack-${packHash}.idx`,
      );
      const verified = (yield* objectOperation(
        repository,
        ["verify-pack", "-v", index],
        MAX_SNAPSHOT_RETENTION_MANIFEST_BYTES,
        { operation: "retain", environment },
      ))
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .filter(Boolean);
      const objectPattern = new RegExp(`^([0-9a-f]{${characters}})\\s`);
      const packedObjects: string[] = [];
      for (const line of verified) {
        const object = objectPattern.exec(line)?.[1];
        if (object) {
          packedObjects.push(object);
          continue;
        }
        if (
          /^non delta: \d+ objects$/.test(line) ||
          /^chain length = \d+: \d+ objects?$/.test(line) ||
          (line.endsWith(": ok") && line.includes(`pack-${packHash}.`))
        )
          continue;
        return yield* snapshotClosureFailure(
          repository,
          "Snapshot closure pack verification output is not canonical",
        );
      }
      return Object.freeze(packedObjects.toSorted());
    });

    const exportSnapshotClosure = Effect.fn("Git.tree.exportClosure")(
      function* (input: { repository: Repository; tree: TreeID }) {
        yield* ensureSnapshotRetention(input.repository);
        return yield* locked(
          input.repository,
          Effect.gen(function* () {
            const retained = yield* exactRetentionRefTarget(
              input.repository,
              SNAPSHOT_REF_PREFIX,
              input.tree,
              "retain",
            );
            if (retained !== input.tree)
              return yield* snapshotClosureFailure(
                input.repository,
                "Snapshot closure export requires an exact retained tree",
              );
            const objects = yield* verifyLocalizedSnapshotTree(
              input.repository,
              input.tree,
            );
            const pack = yield* objectOperation(
              input.repository,
              SNAPSHOT_LOCALIZATION_PACK_ARGS,
              MAX_SNAPSHOT_TRANSFER_PACK_BYTES,
              {
                operation: "retain",
                stdin: Buffer.from(`${input.tree}\n`, "utf8"),
              },
            );
            if (
              pack.length < 12 ||
              pack.subarray(0, 4).toString("ascii") !== "PACK"
            )
              return yield* snapshotClosureFailure(
                input.repository,
                "Snapshot closure export did not produce a canonical pack",
              );
            const characters = yield* snapshotObjectIDCharacters(
              input.repository,
            );
            return Object.freeze({
              version: 1,
              tree: input.tree,
              objectFormat: characters === 40 ? "sha1" : "sha256",
              encoding: "git-pack-v1",
              digest: `sha256:${Hash.sha256(pack)}`,
              objects,
              pack: new Uint8Array(pack),
            }) satisfies SnapshotClosureV1;
          }),
        );
      },
    );

    const importSnapshotClosure = Effect.fn("Git.tree.importClosure")(
      function* (input: {
        repository: Repository;
        expectedTree: TreeID;
        closure: SnapshotClosureV1;
      }) {
        yield* ensureSnapshotRetention(input.repository);
        yield* locked(
          input.repository,
          Effect.gen(function* () {
            const validated = yield* validateSnapshotClosure(
              input.repository,
              input.closure,
            );
            if (validated.tree !== input.expectedTree)
              return yield* snapshotClosureFailure(
                input.repository,
                "Snapshot closure tree does not match the expected replay root",
              );
            yield* Effect.acquireUseRelease(
              fs
                .makeTempDirectory({ prefix: "phins-snapshot-import-" })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OperationError({
                        operation: "retain",
                        directory: input.repository.gitDirectory,
                        message:
                          "Failed to create snapshot closure quarantine",
                        cause,
                      }),
                  ),
                ),
              (quarantine) =>
                Effect.gen(function* () {
                  const packDirectory = path.join(quarantine, "pack");
                  yield* fs.ensureDir(packDirectory).pipe(
                    Effect.mapError(
                      (cause) =>
                        new OperationError({
                          operation: "retain",
                          directory: input.repository.gitDirectory,
                          message:
                            "Failed to prepare snapshot closure quarantine",
                          cause,
                        }),
                    ),
                  );
                  const environment = {
                    GIT_OBJECT_DIRECTORY: quarantine,
                    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
                  };
                  const packedObjects =
                    yield* inspectSnapshotClosurePack(
                      input.repository,
                      validated.pack,
                      validated.characters,
                      quarantine,
                      environment,
                    );
                  if (
                    !sameObjectManifest(
                      packedObjects,
                      validated.objects,
                    )
                  )
                    return yield* snapshotClosureFailure(
                      input.repository,
                      "Snapshot closure pack does not match its exact object manifest",
                    );
                  const reachable = yield* snapshotClosureManifest(
                    input.repository,
                    validated.tree,
                    environment,
                  );
                  if (
                    !sameObjectManifest(reachable, validated.objects)
                  )
                    return yield* snapshotClosureFailure(
                      input.repository,
                      "Snapshot closure manifest does not match the reachable tree",
                    );
                }),
              (quarantine) =>
                fs
                  .remove(quarantine, { recursive: true, force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new OperationError({
                          operation: "retain",
                          directory: input.repository.gitDirectory,
                          message:
                            "Failed to clean snapshot closure quarantine",
                          cause,
                        }),
                    ),
                  ),
            );

            const packedObjects = yield* inspectSnapshotClosurePack(
              input.repository,
              validated.pack,
              validated.characters,
              path.join(input.repository.gitDirectory, "objects"),
            );
            if (!sameObjectManifest(packedObjects, validated.objects))
              return yield* snapshotClosureFailure(
                input.repository,
                "Installed snapshot closure changed after quarantine",
              );
            const reachable = yield* verifyLocalizedSnapshotTree(
              input.repository,
              validated.tree,
            );
            if (!sameObjectManifest(reachable, validated.objects))
              return yield* snapshotClosureFailure(
                input.repository,
                "Installed snapshot closure does not match its exact manifest",
              );
            yield* retainSnapshotTree(
              input.repository,
              validated.tree,
            );
          }),
        );
      },
    );

    const retainTree = Effect.fn("Git.tree.retain")(function* (input: {
      repository: Repository;
      tree: TreeID;
    }) {
      yield* ensureSnapshotRetention(input.repository);
      yield* locked(
        input.repository,
        retainSnapshotTree(input.repository, input.tree),
      );
    });

    const containsTree = Effect.fn("Git.tree.contains")(function* (input: {
      repository: Repository;
      tree: TreeID;
    }) {
      yield* ensureSnapshotRetention(input.repository);
      return yield* locked(
        input.repository,
        snapshotTreeExists(input.repository, input.tree, "retain"),
      );
    });

    const reconcileRetention = Effect.fn("Git.tree.reconcileRetention")(
      function* (input: {
        repository: Repository;
        live: readonly TreeID[];
        reclaim?: boolean;
        nowMs?: number;
        minimumAgeMs?: number;
      }) {
        const nowMs = input.nowMs ?? Date.now();
        const minimumAgeMs =
          input.minimumAgeMs ?? SNAPSHOT_RECLAMATION_MIN_AGE_MS;
        if (
          !Number.isSafeInteger(nowMs) ||
          nowMs < 0 ||
          !Number.isSafeInteger(minimumAgeMs) ||
          minimumAgeMs < 0
        )
          return yield* new OperationError({
            operation: "reclaim",
            directory: input.repository.gitDirectory,
            message: "Snapshot reclamation time bounds are invalid",
          });
        if (input.live.length > MAX_SNAPSHOT_RETENTION_REFS)
          return yield* new OperationError({
            operation: "reclaim",
            directory: input.repository.gitDirectory,
            message: `Snapshot live set exceeds ${MAX_SNAPSHOT_RETENTION_REFS} refs`,
          });
        const live = Array.from(new Set(input.live)).sort();
        yield* ensureSnapshotRetention(input.repository);
        return yield* locked(
          input.repository,
          Effect.gen(function* () {
            for (const tree of live) {
              if (
                !(yield* snapshotTreeExists(input.repository, tree, "reclaim"))
              )
                return yield* new OperationError({
                  operation: "reclaim",
                  directory: input.repository.gitDirectory,
                  message: `Authoritative live snapshot is missing: ${tree}`,
                });
              yield* retainSnapshotTree(input.repository, tree);
            }

            const liveSet = new Set(live);
            let refs = yield* listRetentionRefs(
              input.repository,
              SNAPSHOT_REF_PREFIX,
            );
            for (const tree of live) {
              if (refs.get(tree) !== tree)
                return yield* new OperationError({
                  operation: "reclaim",
                  directory: input.repository.gitDirectory,
                  message:
                    "Authoritative live snapshot was not retained exactly",
                });
            }
            let candidates = yield* listRetentionRefs(
              input.repository,
              SNAPSHOT_RECLAIM_REF_PREFIX,
            );
            const digest = `sha256:${Hash.sha256(JSON.stringify(live))}`;
            let state = yield* readReclamationState(input.repository);
            let reclaimed = 0;
            let garbageCollected = false;

            const desiredBeforeSweep = new Map<TreeID, string>();
            for (const [tree, object] of refs) {
              if (!liveSet.has(tree)) desiredBeforeSweep.set(tree, object);
            }
            const candidatesMatch =
              candidates.size === desiredBeforeSweep.size &&
              Array.from(desiredBeforeSweep).every(
                ([tree, object]) => candidates.get(tree) === object,
              );
            const candidatesDigest =
              reclamationCandidatesDigest(candidates);
            const journalMatchesCandidates =
              state?.candidatesDigest === candidatesDigest;

            const resumeGc = state?.phase === "gc-pending";
            const beginGc =
              state !== undefined &&
              state.phase === "prepared" &&
              state.digest === digest &&
              journalMatchesCandidates &&
              candidatesMatch &&
              input.reclaim === true &&
              candidates.size > 0 &&
              nowMs >= state.preparedAt + minimumAgeMs;

            if (resumeGc || beginGc) {
              if (!state)
                return yield* new OperationError({
                  operation: "reclaim",
                  directory: input.repository.gitDirectory,
                  message: "Snapshot reclamation journal disappeared",
                });
              if (!resumeGc) {
                state = { ...state, version: 3, phase: "gc-pending" };
                // Journal the destructive phase before the single atomic ref
                // deletion. A killed process therefore resumes GC even when no
                // candidate refs remain on the next invocation.
                yield* persistReclamationState(input.repository, state);
              }
              // A retain/capture removes its candidate under this same
              // cross-process lock. After a restart, only sweep when the live
              // set and exact candidate generation still match the journal.
              // An older journal without a candidate digest is ambiguous, as
              // is a mismatch after a crash, so both paths only finish GC and
              // restart aging below.
              const sweep = new Map<TreeID, string>();
              if (
                state.digest === digest &&
                state.candidatesDigest === candidatesDigest &&
                candidatesMatch
              ) {
                for (const [tree, object] of candidates) {
                  if (!liveSet.has(tree)) sweep.set(tree, object);
                }
              }
              yield* sweepCandidateRefs(input.repository, refs, sweep);
              reclaimed = sweep.size;
              yield* garbageCollectSnapshotStore(input.repository);
              garbageCollected = true;
              for (const tree of live) {
                yield* verifyLocalizedSnapshotTree(input.repository, tree);
              }
              refs = yield* listRetentionRefs(
                input.repository,
                SNAPSHOT_REF_PREFIX,
              );
              const remainingCandidates = yield* listRetentionRefs(
                input.repository,
                SNAPSHOT_RECLAIM_REF_PREFIX,
              );
              const desired = new Map<TreeID, string>();
              for (const [tree, object] of refs) {
                if (!liveSet.has(tree)) desired.set(tree, object);
              }
              state = {
                version: 3,
                digest,
                candidatesDigest: reclamationCandidatesDigest(desired),
                preparedAt: nowMs,
                phase: "prepared",
              };
              // Persist the generation before publishing its refs. Either
              // side of a crash then disagrees and must restart the grace
              // period instead of inheriting an older preparedAt value.
              yield* persistReclamationState(input.repository, state);
              yield* updateCandidateRefs(
                input.repository,
                remainingCandidates,
                desired,
              );
              candidates = desired;
            } else if (!state || state.digest !== digest) {
              state = {
                version: 3,
                digest,
                candidatesDigest:
                  reclamationCandidatesDigest(desiredBeforeSweep),
                preparedAt: nowMs,
                phase: "prepared",
              };
              yield* persistReclamationState(input.repository, state);
              yield* updateCandidateRefs(
                input.repository,
                candidates,
                desiredBeforeSweep,
              );
              candidates = desiredBeforeSweep;
            } else if (!candidatesMatch || !journalMatchesCandidates) {
              // A new unreferenced capture (or a fresh liveness signal that
              // cleared one candidate), a legacy journal, or either half of a
              // journal/ref crash starts a new complete aging pass.
              state = {
                version: 3,
                digest,
                candidatesDigest:
                  reclamationCandidatesDigest(desiredBeforeSweep),
                preparedAt: nowMs,
                phase: "prepared",
              };
              yield* persistReclamationState(input.repository, state);
              yield* updateCandidateRefs(
                input.repository,
                candidates,
                desiredBeforeSweep,
              );
              candidates = desiredBeforeSweep;
            }

            yield* upgradeSnapshotDescriptor(input.repository);
            return Object.freeze({
              live: live.length,
              retained: live.length,
              candidates: candidates.size,
              reclaimed,
              garbageCollected,
              preparedAt: state.preparedAt,
              eligibleAt: state.preparedAt + minimumAgeMs,
            }) satisfies SnapshotRetentionReport;
          }),
        );
      },
    );

    const create = Effect.fn("Git.repo.create")(function* (input: {
      worktree: AbsolutePath;
      gitDirectory: AbsolutePath;
      seed?: Repository;
    }) {
      yield* fs.ensureDir(input.gitDirectory).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "create",
              directory: input.gitDirectory,
              message: "Failed to create Git storage",
              cause,
            }),
        ),
      );
      const repository = new Repository({
        worktree: input.worktree,
        gitDirectory: input.gitDirectory,
        commonDirectory: input.gitDirectory,
      });
      yield* repositoryOperation("create", repository, ["init"]);
      yield* Effect.forEach(
        [
          ["core.autocrlf", "false"],
          ["core.longpaths", "true"],
          ["core.symlinks", "true"],
          ["core.fsmonitor", "false"],
          ["feature.manyFiles", "true"],
          ["index.version", "4"],
          ["index.threads", "true"],
          ["core.untrackedCache", "true"],
        ],
        ([key, value]) =>
          repositoryOperation("create", repository, ["config", key, value]),
        { discard: true },
      );
      if (!input.seed) return repository;
      yield* fs
        .ensureDir(path.join(input.gitDirectory, "objects", "info"))
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "create",
                directory: input.gitDirectory,
                message: "Failed to configure shared Git objects",
                cause,
              }),
          ),
        );
      yield* fs
        .writeFileString(
          path.join(input.gitDirectory, "objects", "info", "alternates"),
          path.join(input.seed.commonDirectory, "objects") + "\n",
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "create",
                directory: input.gitDirectory,
                message: "Failed to configure shared Git objects",
                cause,
              }),
          ),
        );
      yield* fs
        .copyFile(
          path.join(input.seed.gitDirectory, "index"),
          path.join(input.gitDirectory, "index"),
        )
        .pipe(Effect.catch(() => Effect.void));
      return repository;
    });

    const refresh = Effect.fn("Git.index.refresh")(function* (input: {
      repository: Repository;
      scope: RelativePath;
      ignores?: Repository;
      maximumUntrackedFileBytes?: number;
    }) {
      const list = (args: string[]) =>
        repositoryOperation("refresh", input.repository, args).pipe(
          Effect.map((result) => result.text.split("\0").filter(Boolean)),
        );
      const [tracked, untracked] = yield* Effect.all(
        [
          list(["diff-files", "--name-only", "-z", "--", input.scope]),
          list([
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            input.scope,
          ]),
        ],
        { concurrency: 2 },
      );
      const candidates = Array.from(new Set([...tracked, ...untracked]));
      if (!candidates.length) return { skipped: [] };
      const ignored = input.ignores
        ? new Set(
            (yield* repositoryOperation(
              "refresh",
              input.ignores,
              ["check-ignore", "--no-index", "--stdin", "-z"],
              {
                stdin: candidates.join("\0") + "\0",
              },
            ).pipe(
              Effect.catch(() => Effect.succeed({ text: "", stderr: "" })),
            )).text
              .split("\0")
              .filter(Boolean),
          )
        : new Set<string>();
      const allowed = candidates.filter((item) => !ignored.has(item));
      const allowedSet = new Set(allowed);
      const maximum = input.maximumUntrackedFileBytes;
      const skipped = maximum
        ? (yield* Effect.forEach(
            untracked.filter((item) => allowedSet.has(item)),
            (item) =>
              fs.stat(path.join(input.repository.worktree, item)).pipe(
                Effect.map((info) =>
                  info.type === "File" && Number(info.size) > maximum
                    ? RelativePath.make(item)
                    : undefined,
                ),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            { concurrency: 8 },
          )).filter((item): item is RelativePath => item !== undefined)
        : [];
      const skippedSet = new Set<string>(skipped);
      const stage = allowed.filter((item) => !skippedSet.has(item));
      const remove = [...ignored, ...skipped];
      if (remove.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          [
            "rm",
            "--cached",
            "-f",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { stdin: remove.join("\0") + "\0" },
        );
      if (stage.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          [
            "add",
            "--all",
            "--sparse",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { stdin: stage.join("\0") + "\0" },
        );
      return { skipped };
    });

    const ignored = Effect.fn("Git.index.ignored")(function* (input: {
      repository: Repository;
      paths: readonly RelativePath[];
    }) {
      if (!input.paths.length) return new Set<RelativePath>();
      const result = yield* proc
        .run(
          ChildProcess.make(
            "git",
            repositoryArgs(input.repository, [
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ]),
            {
              cwd: input.repository.worktree,
              extendEnv: true,
            },
          ),
          { stdin: input.paths.join("\0") + "\0" },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "list_files",
                directory: input.repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        );
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* new OperationError({
          operation: "list_files",
          directory: input.repository.worktree,
          message:
            result.stderr.toString("utf8").trim() ||
            "Failed to check ignored paths",
        });
      return new Set(
        result.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((file) => RelativePath.make(file)),
      );
    });

    const writeTree = Effect.fn("Git.tree.write")(function* (
      repository: Repository,
    ) {
      return TreeID.make(
        (yield* repositoryOperation("write_tree", repository, [
          "write-tree",
        ])).text.trim(),
      );
    });

    type CaptureTreeInput = {
      readonly repository: Repository;
      readonly scopes: readonly RelativePath[];
      readonly ignores?: Repository;
      readonly maximumUntrackedFileBytes?: number;
    };

    const captureTree = Effect.fn("Git.tree.capture")(
      (input: CaptureTreeInput) =>
        ensureSnapshotRetention(input.repository).pipe(
          Effect.andThen(
            locked(
              input.repository,
              Effect.gen(function* () {
                yield* Effect.forEach(
                  input.scopes,
                  (scope) => refresh({ ...input, scope }),
                  { discard: true },
                );
                const tree = yield* writeTree(input.repository);
                yield* retainSnapshotTree(input.repository, tree);
                return tree;
              }),
            ),
          ),
        ),
    );

    const captureExactTree = Effect.fn("Git.tree.captureExact")(
      (input: CaptureTreeInput) =>
        ensureSnapshotRetention(input.repository).pipe(
          Effect.andThen(
            locked(
              input.repository,
              Effect.gen(function* () {
                const exactScope = input.scopes[0];
                const normalizedScope =
                  exactScope === undefined
                    ? undefined
                    : path.posix.normalize(exactScope.replaceAll("\\", "/"));
                if (
                  input.scopes.length !== 1 ||
                  exactScope === undefined ||
                  !input.ignores ||
                  exactScope.includes("\0") ||
                  exactScope !== normalizedScope ||
                  path.posix.isAbsolute(exactScope) ||
                  exactScope === ".." ||
                  exactScope.startsWith("../") ||
                  Buffer.byteLength(exactScope, "utf8") >
                    MAX_MATERIALIZED_PATH_BYTES
                )
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message:
                      "Exact capture requires one normalized project-relative scope and the source repository",
                  });

                const source = input.ignores;
                const maximumUntrackedFileBytes =
                  input.maximumUntrackedFileBytes ??
                  MAX_MATERIALIZED_FILE_BYTES;
                if (
                  !Number.isSafeInteger(maximumUntrackedFileBytes) ||
                  maximumUntrackedFileBytes < 0
                )
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message:
                      "Exact capture requires a non-negative, safe untracked-file byte limit",
                  });
                const projectWorktree = yield* Effect.tryPromise({
                  try: async () => {
                    const [repositoryWorktree, sourceWorktree] =
                      await Promise.all([
                        realpath(input.repository.worktree),
                        realpath(source.worktree),
                      ]);
                    if (repositoryWorktree !== sourceWorktree)
                      throw materializationFailure(
                        "Exact-capture repositories do not share one canonical worktree",
                      );
                    return repositoryWorktree;
                  },
                  catch: (cause) =>
                    new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message:
                        cause instanceof globalThis.Error
                          ? cause.message
                          : "Failed to resolve the exact-capture worktree",
                      cause,
                    }),
                });
                const gitOptions = [
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "core.untrackedCache=false",
                  "-c",
                  `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
                ];
                const operationOptions = {
                  operation: "capture" as const,
                  worktree: true,
                };
                const [
                  trackedOutput,
                  untrackedOutput,
                  sparseOutput,
                  unmergedOutput,
                ] = yield* Effect.all(
                  [
                    objectOperation(
                      source,
                      [
                        ...gitOptions,
                        "ls-files",
                        "-z",
                        "--cached",
                        "--deduplicate",
                        "--",
                        exactScope,
                      ],
                      MAX_MATERIALIZED_MANIFEST_BYTES,
                      operationOptions,
                    ),
                    objectOperation(
                      source,
                      [
                        ...gitOptions,
                        "ls-files",
                        "-z",
                        "--others",
                        "--exclude-standard",
                        "--",
                        exactScope,
                      ],
                      MAX_MATERIALIZED_MANIFEST_BYTES,
                      operationOptions,
                    ),
                    objectOperation(
                      source,
                      [
                        ...gitOptions,
                        "ls-files",
                        "-t",
                        "-z",
                        "--cached",
                        "--",
                        exactScope,
                      ],
                      MAX_MATERIALIZED_MANIFEST_BYTES,
                      operationOptions,
                    ),
                    objectOperation(
                      source,
                      [
                        ...gitOptions,
                        "ls-files",
                        "-z",
                        "--unmerged",
                        "--",
                        exactScope,
                      ],
                      MAX_MATERIALIZED_MANIFEST_BYTES,
                      operationOptions,
                    ),
                  ],
                  { concurrency: 4 },
                );
                if (unmergedOutput.length > 0)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message:
                      "Exact capture does not support an unmerged Git index",
                  });
                if (
                  Buffer.from(sparseOutput)
                    .toString("latin1")
                    .split("\0")
                    .some((entry) => entry.startsWith("S "))
                )
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message:
                      "Exact capture does not support skip-worktree entries",
                  });

                const [tracked, untracked] = yield* Effect.try({
                  try: () =>
                    [
                      decodeExactCapturePaths(trackedOutput),
                      decodeExactCapturePaths(untrackedOutput),
                    ] as const,
                  catch: (cause) =>
                    new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message:
                        cause instanceof globalThis.Error
                          ? cause.message
                          : "Exact-capture paths are invalid",
                      cause,
                    }),
                });
                const candidates = [
                  ...tracked.map((file) => ({ file, tracked: true }) as const),
                  ...untracked.map(
                    (file) => ({ file, tracked: false }) as const,
                  ),
                ];
                if (candidates.length > MAX_MATERIALIZED_ENTRIES)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message: `Exact capture exceeds ${MAX_MATERIALIZED_ENTRIES} entries`,
                  });
                const candidateBytes = candidates.reduce(
                  (total, candidate) =>
                    total + Buffer.byteLength(candidate.file, "utf8") + 1,
                  0,
                );
                if (candidateBytes > MAX_MATERIALIZED_MANIFEST_BYTES)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message: `Exact-capture paths exceed ${MAX_MATERIALIZED_MANIFEST_BYTES} bytes`,
                  });
                const candidatePaths = new Set<string>();
                for (const { file } of candidates) {
                  if (candidatePaths.has(file))
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact capture contains a duplicate path: ${JSON.stringify(file)}`,
                    });
                  candidatePaths.add(file);
                }
                const candidateDirectories = new Set<string>();
                for (const { file } of candidates) {
                  const segments = file.split("/");
                  for (let index = 1; index < segments.length; index++) {
                    candidateDirectories.add(
                      segments.slice(0, index).join("/"),
                    );
                    if (
                      candidatePaths.size + candidateDirectories.size >
                      MAX_MATERIALIZED_ENTRIES
                    )
                      return yield* new OperationError({
                        operation: "capture",
                        directory: input.repository.worktree,
                        message: `Exact capture exceeds ${MAX_MATERIALIZED_ENTRIES} materialized entries`,
                      });
                  }
                }
                for (const directory of candidateDirectories) {
                  if (candidatePaths.has(directory))
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact capture contains a file/directory prefix collision: ${JSON.stringify(directory)}`,
                    });
                }
                const portable = new Map<string, string>();
                for (const capturePath of [
                  ...candidateDirectories,
                  ...candidatePaths,
                ]) {
                  const collisionKey = capturePath
                    .normalize("NFC")
                    .toLowerCase();
                  const collision = portable.get(collisionKey);
                  if (collision !== undefined)
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact capture contains colliding paths: ${JSON.stringify(collision)} and ${JSON.stringify(capturePath)}`,
                    });
                  portable.set(collisionKey, capturePath);
                }

                const objectFormat = (yield* objectOperation(
                  input.repository,
                  ["rev-parse", "--show-object-format"],
                  32,
                  {
                    operation: "capture",
                  },
                ))
                  .toString("utf8")
                  .trim();
                const objectCharacters =
                  objectFormat === "sha1"
                    ? 40
                    : objectFormat === "sha256"
                      ? 64
                      : undefined;
                if (objectCharacters === undefined)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.gitDirectory,
                    message:
                      "Exact capture requires a supported Git object format",
                  });
                snapshotObjectCharacters.set(
                  input.repository,
                  objectCharacters,
                );

                const captureCandidates: Array<
                  (typeof candidates)[number] & {
                    readonly target: string;
                    readonly initial: BigIntStats;
                  }
                > = [];
                let preflightBytes = 0n;
                for (const candidate of candidates) {
                  const target = path.join(
                    projectWorktree,
                    ...candidate.file.split("/"),
                  );
                  const initial = yield* Effect.tryPromise({
                    try: async () => {
                      try {
                        return await lstat(target, { bigint: true });
                      } catch (cause) {
                        if ((cause as NodeJS.ErrnoException).code === "ENOENT")
                          return undefined;
                        throw cause;
                      }
                    },
                    catch: (cause) =>
                      new OperationError({
                        operation: "capture",
                        directory: input.repository.worktree,
                        message: `Failed to inspect raw file: ${JSON.stringify(candidate.file)}`,
                        cause,
                      }),
                  });
                  if (!initial) continue;
                  if (!initial.isFile())
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact capture only supports regular files: ${JSON.stringify(candidate.file)}`,
                    });
                  const canonical = yield* Effect.tryPromise({
                    try: () => realpath(target),
                    catch: (cause) =>
                      new OperationError({
                        operation: "capture",
                        directory: input.repository.worktree,
                        message: `Failed to resolve raw file: ${JSON.stringify(candidate.file)}`,
                        cause,
                      }),
                  });
                  if (
                    canonical !== target ||
                    !FileAccess.contains(projectWorktree, canonical)
                  )
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact-capture file resolves outside the canonical project tree: ${JSON.stringify(candidate.file)}`,
                    });
                  const maximum = candidate.tracked
                    ? MAX_MATERIALIZED_FILE_BYTES
                    : Math.min(
                        maximumUntrackedFileBytes,
                        MAX_MATERIALIZED_FILE_BYTES,
                      );
                  if (initial.size > BigInt(maximum))
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact-capture file exceeds ${maximum} bytes: ${JSON.stringify(candidate.file)}`,
                    });
                  preflightBytes += initial.size;
                  if (preflightBytes > BigInt(MAX_MATERIALIZED_TOTAL_BYTES))
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.worktree,
                      message: `Exact capture exceeds ${MAX_MATERIALIZED_TOTAL_BYTES} bytes`,
                    });
                  captureCandidates.push({ ...candidate, target, initial });
                }

                const capturedPaths = new Set(
                  captureCandidates.map(
                    (candidate) => candidate.file as string,
                  ),
                );
                const capturedDirectories = new Set<string>();
                for (const candidate of captureCandidates) {
                  const segments = candidate.file.split("/");
                  for (let index = 1; index < segments.length; index++) {
                    capturedDirectories.add(segments.slice(0, index).join("/"));
                    if (
                      capturedPaths.size + capturedDirectories.size >
                      MAX_MATERIALIZED_ENTRIES
                    )
                      return yield* new OperationError({
                        operation: "capture",
                        directory: input.repository.worktree,
                        message: `Exact capture exceeds ${MAX_MATERIALIZED_ENTRIES} materialized entries`,
                      });
                  }
                }
                const capturedEntries =
                  capturedPaths.size + capturedDirectories.size;
                if (capturedEntries > MAX_MATERIALIZED_ENTRIES)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message: `Exact capture exceeds ${MAX_MATERIALIZED_ENTRIES} materialized entries`,
                  });
                const manifestRecordBytes = (
                  capturePath: string,
                  size?: bigint,
                ) =>
                  6 +
                  1 +
                  4 +
                  1 +
                  objectCharacters +
                  1 +
                  Math.max(7, size === undefined ? 1 : size.toString().length) +
                  1 +
                  Buffer.byteLength(capturePath, "utf8") +
                  1;
                const capturedManifestBytes =
                  Array.from(capturedDirectories).reduce(
                    (total, directory) =>
                      total + manifestRecordBytes(directory),
                    0,
                  ) +
                  captureCandidates.reduce(
                    (total, candidate) =>
                      total +
                      manifestRecordBytes(
                        candidate.file,
                        candidate.initial.size,
                      ),
                    0,
                  );
                if (capturedManifestBytes > MAX_MATERIALIZED_MANIFEST_BYTES)
                  return yield* new OperationError({
                    operation: "capture",
                    directory: input.repository.worktree,
                    message: `Exact-capture tree manifest exceeds ${MAX_MATERIALIZED_MANIFEST_BYTES} bytes`,
                  });

                const index = path.join(
                  input.repository.gitDirectory,
                  `capture-${randomUUID()}.index`,
                );
                const indexEnvironment = { GIT_INDEX_FILE: index };
                const exact = Effect.gen(function* () {
                  yield* objectOperation(
                    input.repository,
                    ["read-tree", "--empty"],
                    16,
                    {
                      operation: "capture",
                      environment: indexEnvironment,
                    },
                  );
                  const staged: Buffer[] = [];
                  let totalBytes = 0;
                  for (const candidate of captureCandidates) {
                    const captured = yield* Effect.tryPromise({
                      try: async () => {
                        const initial = await lstat(candidate.target, {
                          bigint: true,
                        });
                        if (!initial.isFile())
                          throw materializationFailure(
                            "Entry is not a regular file",
                          );
                        if (
                          initial.dev !== candidate.initial.dev ||
                          initial.ino !== candidate.initial.ino ||
                          initial.mode !== candidate.initial.mode ||
                          initial.size !== candidate.initial.size ||
                          initial.mtimeNs !== candidate.initial.mtimeNs ||
                          initial.ctimeNs !== candidate.initial.ctimeNs
                        )
                          throw materializationFailure(
                            "Entry changed after exact-capture preflight",
                          );
                        const canonical = await realpath(candidate.target);
                        if (
                          canonical !== candidate.target ||
                          !FileAccess.contains(projectWorktree, canonical)
                        )
                          throw materializationFailure(
                            "Entry resolves outside the canonical project tree",
                          );
                        const handle = await open(
                          candidate.target,
                          constants.O_RDONLY | constants.O_NOFOLLOW,
                        );
                        try {
                          const before = await handle.stat({ bigint: true });
                          if (
                            !before.isFile() ||
                            before.dev !== initial.dev ||
                            before.ino !== initial.ino ||
                            before.mode !== initial.mode ||
                            before.size !== initial.size ||
                            before.mtimeNs !== initial.mtimeNs ||
                            before.ctimeNs !== initial.ctimeNs
                          )
                            throw materializationFailure(
                              "Entry identity changed while opening",
                            );
                          const maximum = candidate.tracked
                            ? MAX_MATERIALIZED_FILE_BYTES
                            : Math.min(
                                maximumUntrackedFileBytes,
                                MAX_MATERIALIZED_FILE_BYTES,
                              );
                          if (before.size > BigInt(maximum))
                            throw materializationFailure(
                              `Entry exceeds ${maximum} bytes`,
                            );
                          const expected = Number(before.size);
                          const buffer = Buffer.alloc(expected + 1);
                          let offset = 0;
                          while (offset < buffer.length) {
                            const { bytesRead } = await handle.read(
                              buffer,
                              offset,
                              buffer.length - offset,
                              null,
                            );
                            if (bytesRead === 0) break;
                            offset += bytesRead;
                          }
                          const after = await handle.stat({ bigint: true });
                          if (
                            offset !== expected ||
                            after.dev !== before.dev ||
                            after.ino !== before.ino ||
                            after.mode !== before.mode ||
                            after.size !== before.size ||
                            after.mtimeNs !== before.mtimeNs ||
                            after.ctimeNs !== before.ctimeNs
                          )
                            throw materializationFailure(
                              "Entry changed while reading",
                            );
                          return {
                            bytes: buffer.subarray(0, expected),
                            mode:
                              (before.mode & 0o111n) === 0n
                                ? "100644"
                                : "100755",
                          };
                        } finally {
                          await handle.close();
                        }
                      },
                      catch: (cause) =>
                        new OperationError({
                          operation: "capture",
                          directory: input.repository.worktree,
                          message: `Failed to capture raw file: ${JSON.stringify(candidate.file)}${
                            cause instanceof globalThis.Error
                              ? `: ${cause.message}`
                              : ""
                          }`,
                          cause,
                        }),
                    });
                    totalBytes += captured.bytes.length;
                    if (totalBytes > MAX_MATERIALIZED_TOTAL_BYTES)
                      return yield* new OperationError({
                        operation: "capture",
                        directory: input.repository.worktree,
                        message: `Exact capture exceeds ${MAX_MATERIALIZED_TOTAL_BYTES} bytes`,
                      });
                    const object = (yield* objectOperation(
                      input.repository,
                      ["hash-object", "-w", "--no-filters", "--stdin"],
                      128,
                      { operation: "capture", stdin: captured.bytes },
                    ))
                      .toString("utf8")
                      .trim();
                    if (
                      !new RegExp(`^[0-9a-f]{${objectCharacters}}$`).test(
                        object,
                      )
                    )
                      return yield* new OperationError({
                        operation: "capture",
                        directory: input.repository.gitDirectory,
                        message: "Git returned an invalid raw blob object ID",
                      });
                    staged.push(
                      Buffer.from(
                        `${captured.mode} blob ${object}\t${candidate.file}\0`,
                        "utf8",
                      ),
                    );
                  }
                  if (staged.length > 0)
                    yield* objectOperation(
                      input.repository,
                      ["update-index", "-z", "--index-info"],
                      16,
                      {
                        operation: "capture",
                        stdin: Buffer.concat(staged),
                        environment: indexEnvironment,
                      },
                    );
                  const tree = (yield* objectOperation(
                    input.repository,
                    ["write-tree"],
                    128,
                    {
                      operation: "capture",
                      environment: indexEnvironment,
                    },
                  ))
                    .toString("utf8")
                    .trim();
                  if (!new RegExp(`^[0-9a-f]{${objectCharacters}}$`).test(tree))
                    return yield* new OperationError({
                      operation: "capture",
                      directory: input.repository.gitDirectory,
                      message: "Git returned an invalid exact tree object ID",
                    });
                  const retained = TreeID.make(tree);
                  yield* retainSnapshotTree(input.repository, retained);
                  return retained;
                });
                const cleanupIndex = Effect.all(
                  [
                    fs.remove(index, { force: true }),
                    fs.remove(`${index}.lock`, { force: true }),
                  ],
                  { discard: true },
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OperationError({
                        operation: "capture",
                        directory: input.repository.gitDirectory,
                        message:
                          "Failed to remove the isolated exact-capture index",
                        cause,
                      }),
                  ),
                  Effect.uninterruptible,
                );
                return yield* exact.pipe(
                  Effect.matchCauseEffect({
                    onSuccess: (tree) => cleanupIndex.pipe(Effect.as(tree)),
                    onFailure: (cause) =>
                      Effect.gen(function* () {
                        yield* cleanupIndex;
                        return yield* Effect.failCause(cause);
                      }),
                  }),
                );
              }),
            ),
          ),
        ),
    );

    const treeFiles = Effect.fn("Git.tree.files")(function* (input: {
      repository: Repository;
      from: TreeID;
      to: TreeID;
    }) {
      return (yield* repositoryOperation("list_files", input.repository, [
        "diff",
        "--name-only",
        "-z",
        input.from,
        input.to,
      ])).text
        .split("\0")
        .filter(Boolean)
        .map((file) => RelativePath.make(file));
    });

    const treeDiff = Effect.fn("Git.tree.diff")(function* (input: {
      repository: Repository;
      from: TreeID;
      to: TreeID;
      context?: number;
      paths?: readonly RelativePath[];
    }) {
      const paths = input.paths ?? (yield* treeFiles(input));
      return yield* Effect.forEach(paths, (file) =>
        Effect.gen(function* () {
          const statusText = (yield* repositoryOperation(
            "diff",
            input.repository,
            [
              "diff",
              "--name-status",
              "--no-renames",
              input.from,
              input.to,
              "--",
              file,
            ],
          )).text.trim();
          const status = statusText.startsWith("A")
            ? "added"
            : statusText.startsWith("D")
              ? "deleted"
              : "modified";
          const stats = (yield* repositoryOperation("diff", input.repository, [
            "diff",
            "--numstat",
            "--no-renames",
            input.from,
            input.to,
            "--",
            file,
          ])).text.split("\t");
          const binary = stats[0] === "-" || stats[1] === "-";
          const patch = binary
            ? ""
            : (yield* repositoryOperation("diff", input.repository, [
                "diff",
                `--unified=${input.context ?? 3}`,
                "--no-renames",
                input.from,
                input.to,
                "--",
                file,
              ])).text;
          return {
            path: file,
            status,
            additions: binary ? 0 : Number(stats[0] ?? 0),
            deletions: binary ? 0 : Number(stats[1] ?? 0),
            patch,
          } satisfies File.Diff;
        }),
      );
    });

    const entry = Effect.fnUntraced(function* (
      repository: Repository,
      tree: TreeID,
      file: RelativePath,
    ) {
      const text = (yield* repositoryOperation("restore", repository, [
        "ls-tree",
        "-z",
        tree,
        "--",
        file,
      ])).text.replace(/\0$/, "");
      if (!text) return;
      const match = text.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t/);
      if (!match)
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid tree entry for ${file}`,
        });
      return { mode: match[1], object: match[2] };
    });

    const preview = Effect.fn("Git.tree.preview")(
      (input: {
        repository: Repository;
        current: TreeID;
        files: ReadonlyMap<RelativePath, TreeID>;
        context?: number;
      }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            const index = path.join(
              input.repository.gitDirectory,
              `preview-${randomUUID()}.index`,
            );
            const env = { GIT_INDEX_FILE: index };
            return yield* Effect.gen(function* () {
              yield* repositoryOperation(
                "diff",
                input.repository,
                ["read-tree", input.current],
                { env },
              );
              yield* Effect.forEach(
                input.files,
                ([file, tree]) =>
                  Effect.gen(function* () {
                    const source = yield* entry(input.repository, tree, file);
                    if (!source) {
                      yield* repositoryOperation(
                        "diff",
                        input.repository,
                        ["update-index", "--force-remove", "--", file],
                        { env },
                      );
                      return;
                    }
                    yield* repositoryOperation(
                      "diff",
                      input.repository,
                      [
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        source.mode,
                        source.object,
                        file,
                      ],
                      { env },
                    );
                  }),
                { discard: true },
              );
              const target = TreeID.make(
                (yield* repositoryOperation(
                  "diff",
                  input.repository,
                  ["write-tree"],
                  { env },
                )).text.trim(),
              );
              return yield* treeDiff({
                repository: input.repository,
                from: input.current,
                to: target,
                context: input.context,
                paths: Array.from(input.files.keys()),
              });
            }).pipe(
              Effect.ensuring(
                fs.remove(index).pipe(Effect.catch(() => Effect.void)),
              ),
            );
          }),
        ),
    );

    const restore = Effect.fn("Git.tree.restore")(
      (input: {
        repository: Repository;
        files: ReadonlyMap<RelativePath, TreeID>;
      }) =>
        locked(
          input.repository,
          Effect.forEach(
            input.files,
            ([file, tree]) =>
              Effect.gen(function* () {
                if (yield* entry(input.repository, tree, file)) {
                  yield* repositoryOperation("restore", input.repository, [
                    "checkout",
                    tree,
                    "--",
                    file,
                  ]);
                  return;
                }
                yield* fs
                  .remove(path.join(input.repository.worktree, file), {
                    recursive: true,
                    force: true,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new OperationError({
                          operation: "restore",
                          directory: input.repository.worktree,
                          message: `Failed to remove ${file}`,
                          cause,
                        }),
                    ),
                  );
              }),
            { discard: true },
          ),
        ),
    );

    const checkoutTree = Effect.fn("Git.tree.checkout")(
      (input: { repository: Repository; tree: TreeID }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            yield* repositoryOperation("restore", input.repository, [
              "read-tree",
              input.tree,
            ]);
            yield* repositoryOperation("restore", input.repository, [
              "checkout-index",
              "--all",
              "--force",
            ]);
          }),
        ),
    );

    const materializeTree = Effect.fn("Git.tree.materialize")(
      function* (input: {
        repository: Repository;
        tree: TreeID;
        directory: AbsolutePath;
      }) {
        const directory = path.normalize(input.directory);
        if (
          !path.isAbsolute(input.directory) ||
          path.resolve(input.directory) !== input.directory ||
          directory !== input.directory
        )
          return yield* new OperationError({
            operation: "materialize",
            directory: input.directory,
            message:
              "Materialization directory must be an absolute normalized path",
          });
        const canonicalDirectory = yield* fs.realPath(input.directory).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "materialize",
                directory: input.directory,
                message: "Failed to resolve materialization directory",
                cause,
              }),
          ),
        );
        if (
          canonicalDirectory !== input.directory ||
          FileAccess.overlaps(input.repository.worktree, input.directory)
        )
          return yield* new OperationError({
            operation: "materialize",
            directory: input.directory,
            message:
              "Materialization directory must be canonical and outside the repository worktree",
          });
        const info = yield* fs.stat(input.directory).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "materialize",
                directory: input.directory,
                message: "Failed to inspect materialization directory",
                cause,
              }),
          ),
        );
        const contents = yield* fs.readDirectory(input.directory).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "materialize",
                directory: input.directory,
                message: "Failed to list materialization directory",
                cause,
              }),
          ),
        );
        if (info.type !== "Directory" || contents.length !== 0)
          return yield* new OperationError({
            operation: "materialize",
            directory: input.directory,
            message: "Materialization directory must be an empty directory",
          });

        const objectFormat = (yield* objectOperation(
          input.repository,
          ["rev-parse", "--show-object-format"],
          32,
        ))
          .toString("utf8")
          .trim();
        const objectCharacters =
          objectFormat === "sha1"
            ? 40
            : objectFormat === "sha256"
              ? 64
              : undefined;
        if (
          objectCharacters === undefined ||
          !new RegExp(`^[0-9a-f]{${objectCharacters}}$`).test(input.tree)
        )
          return yield* new OperationError({
            operation: "materialize",
            directory: input.directory,
            message: "Snapshot must be a canonical full tree object ID",
          });
        const objectType = (yield* objectOperation(
          input.repository,
          ["cat-file", "-t", input.tree],
          16,
        ))
          .toString("utf8")
          .trim();
        if (objectType !== "tree")
          return yield* new OperationError({
            operation: "materialize",
            directory: input.directory,
            message: "Snapshot object is not a tree",
          });

        const manifest = yield* objectOperation(
          input.repository,
          [
            "ls-tree",
            "-r",
            "-t",
            "-z",
            "--full-tree",
            "--long",
            input.tree,
            "--",
          ],
          MAX_MATERIALIZED_MANIFEST_BYTES,
        );
        const entries = yield* Effect.try({
          try: () =>
            decodeMaterializationManifest(manifest, objectCharacters / 2),
          catch: (cause) =>
            new OperationError({
              operation: "materialize",
              directory: input.directory,
              message:
                cause instanceof globalThis.Error
                  ? cause.message
                  : "Tree manifest is invalid",
              cause,
            }),
        });

        yield* fs.chmod(input.directory, 0o700).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "materialize",
                directory: input.directory,
                message: "Failed to secure materialization directory",
                cause,
              }),
          ),
        );
        const directories = entries
          .filter(
            (
              entry,
            ): entry is Extract<MaterializationEntry, { kind: "directory" }> =>
              entry.kind === "directory",
          )
          .toSorted(
            (left, right) =>
              left.path.split("/").length - right.path.split("/").length,
          );
        for (const entry of directories)
          yield* fs
            .makeDirectory(
              path.join(input.directory, ...entry.path.split("/")),
              {
                recursive: true,
                mode: 0o700,
              },
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OperationError({
                    operation: "materialize",
                    directory: input.directory,
                    message: `Failed to create tree directory: ${JSON.stringify(entry.path)}`,
                    cause,
                  }),
              ),
            );

        const files = entries.filter(
          (entry): entry is Extract<MaterializationEntry, { kind: "file" }> =>
            entry.kind === "file",
        );
        let bytes = 0;
        for (const entry of files) {
          const target = path.join(input.directory, ...entry.path.split("/"));
          yield* fs
            .makeDirectory(path.dirname(target), {
              recursive: true,
              mode: 0o700,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OperationError({
                    operation: "materialize",
                    directory: input.directory,
                    message: `Failed to create tree parent: ${JSON.stringify(entry.path)}`,
                    cause,
                  }),
              ),
            );
          const blob = yield* objectOperation(
            input.repository,
            ["cat-file", "blob", entry.object],
            entry.size + 1,
          );
          if (blob.length !== entry.size)
            return yield* new OperationError({
              operation: "materialize",
              directory: input.directory,
              message: `Tree blob size did not match its manifest: ${JSON.stringify(entry.path)}`,
            });
          yield* fs.writeFile(target, blob, { flag: "wx", mode: 0o600 }).pipe(
            Effect.andThen(fs.chmod(target, entry.executable ? 0o755 : 0o644)),
            Effect.mapError(
              (cause) =>
                new OperationError({
                  operation: "materialize",
                  directory: input.directory,
                  message: `Failed to write tree blob: ${JSON.stringify(entry.path)}`,
                  cause,
                }),
            ),
          );
          bytes += entry.size;
        }
        return {
          tree: input.tree,
          files: files.length,
          bytes,
        } satisfies MaterializedTree;
      },
    );

    const capture = Effect.fn("Git.change.capture")(function* (input: {
      repository: Repository;
      path: AbsolutePath;
    }) {
      const scope =
        path
          .relative(input.repository.worktree, input.path)
          .replaceAll("\\", "/") || ".";
      const tracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["diff", "--binary", "HEAD", "--", scope]).pipe(
        Effect.mapError(
          (cause) =>
            new PatchError({
              operation: "capture",
              directory: input.path,
              message: cause.message,
              cause,
            }),
        ),
      );
      if (tracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message:
            tracked.stderr.trim() ||
            tracked.text.trim() ||
            "Failed to capture tracked changes",
        });
      }

      const untracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["ls-files", "--others", "--exclude-standard", "-z", "--", scope]).pipe(
        Effect.mapError(
          (cause) =>
            new PatchError({
              operation: "capture",
              directory: input.path,
              message: cause.message,
              cause,
            }),
        ),
      );
      if (untracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message:
            untracked.stderr.trim() ||
            untracked.text.trim() ||
            "Failed to list untracked changes",
        });
      }

      const created = yield* Effect.forEach(
        untracked.text.split("\0").filter(Boolean),
        (file) =>
          execute(
            input.repository.worktree,
            proc,
          )(["diff", "--binary", "--no-index", "--", "/dev/null", file]).pipe(
            Effect.mapError(
              (cause) =>
                new PatchError({
                  operation: "capture",
                  directory: input.path,
                  message: cause.message,
                  cause,
                }),
            ),
            Effect.flatMap((result) =>
              // git diff --no-index returns 1 when differences were found.
              result.exitCode === 0 || result.exitCode === 1
                ? Effect.succeed(result.text)
                : Effect.fail(
                    new PatchError({
                      operation: "capture",
                      directory: input.path,
                      message:
                        result.stderr.trim() ||
                        result.text.trim() ||
                        `Failed to capture untracked change: ${file}`,
                    }),
                  ),
            ),
          ),
      );
      return ChangeSet.make(
        [tracked.text, ...created].filter(Boolean).join("\n"),
      );
    });

    const apply = Effect.fn("Git.change.apply")(function* (input: {
      repository: Repository;
      path: AbsolutePath;
      changes: ChangeSet;
    }) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", ["apply", "-"], {
            cwd: input.path,
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(input.changes)),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PatchError({
                operation: "apply",
                directory: input.path,
                message: cause.message,
                cause,
              }),
          ),
        );
      if (result.exitCode === 0) return;
      return yield* new PatchError({
        operation: "apply",
        directory: input.path,
        message:
          result.stderr.toString("utf8").trim() ||
          result.stdout.toString("utf8").trim() ||
          "Failed to apply changes",
      });
    });

    const discard = Effect.fn("Git.change.discard")(function* (input: {
      repository: Repository;
      path: AbsolutePath;
      index: "preserve" | "reset";
      untracked: "preserve" | "remove";
    }) {
      const scope =
        path
          .relative(input.repository.worktree, input.path)
          .replaceAll("\\", "/") || ".";
      const restore = yield* execute(
        input.repository.worktree,
        proc,
      )(
        input.index === "reset"
          ? ["checkout", "HEAD", "--", scope]
          : ["checkout", "--", scope],
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PatchError({
              operation: "reset",
              directory: input.path,
              message: cause.message,
              cause,
            }),
        ),
      );
      if (restore.exitCode !== 0) {
        return yield* new PatchError({
          operation: "reset",
          directory: input.path,
          message:
            restore.stderr.trim() ||
            restore.text.trim() ||
            "Failed to restore tracked changes",
        });
      }
      if (input.untracked === "preserve") return;
      const clean = yield* execute(
        input.repository.worktree,
        proc,
      )(["clean", "-fd", "--", scope]).pipe(
        Effect.mapError(
          (cause) =>
            new PatchError({
              operation: "reset",
              directory: input.path,
              message: cause.message,
              cause,
            }),
        ),
      );
      if (clean.exitCode === 0) return;
      return yield* new PatchError({
        operation: "reset",
        directory: input.path,
        message:
          clean.stderr.trim() ||
          clean.text.trim() ||
          "Failed to clean untracked changes",
      });
    });

    const worktreeRun = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repository: Repository,
      args: string[],
      worktreeDirectory?: AbsolutePath,
      cwd = repository.worktree,
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", args, {
            cwd,
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorktreeError({
                operation,
                directory: worktreeDirectory,
                message: cause.message,
                cause,
              }),
          ),
        );
      if (result.exitCode === 0) return result.stdout.toString("utf8");
      const message =
        result.stderr.toString("utf8").trim() ||
        result.stdout.toString("utf8").trim() ||
        "Git failed";
      return yield* new WorktreeError({
        operation,
        directory: worktreeDirectory,
        message,
        forceRequired:
          operation === "remove" &&
          /contains modified or untracked files|is dirty/i.test(message),
      });
    });

    const worktreeCreate = Effect.fn("Git.worktree.create")(function* (input: {
      repository: Repository;
      directory: AbsolutePath;
    }) {
      yield* worktreeRun(
        "create",
        input.repository,
        ["worktree", "add", "--detach", input.directory, "HEAD"],
        input.directory,
      );
      const repository = yield* discover(input.directory);
      if (repository) return repository;
      return yield* new WorktreeError({
        operation: "create",
        directory: input.directory,
        message: "Created worktree could not be opened",
      });
    });

    const worktreeRemove = Effect.fn("Git.worktree.remove")(function* (input: {
      repository: Repository;
      directory: AbsolutePath;
      force: boolean;
    }) {
      yield* worktreeRun(
        "remove",
        input.repository,
        [
          "worktree",
          "remove",
          ...(input.force ? ["--force"] : []),
          input.directory,
        ],
        input.directory,
        input.repository.commonDirectory,
      );
    });

    const worktreeList = Effect.fn("Git.worktree.list")(function* (
      repository: Repository,
    ) {
      return (yield* worktreeRun("list", repository, [
        "worktree",
        "list",
        "--porcelain",
      ]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Worktree({
              directory: AbsolutePath.make(
                resolvePath(
                  repository.worktree,
                  line.slice("worktree ".length).trim(),
                ),
              ),
              kind: index === 0 ? "main" : "linked",
            }),
        );
    });

    return Service.of({
      repo: { discover, clone, create, ensureSnapshotRetention },
      remote: { get: remote },
      history: {
        head,
        branch,
        defaultRemoteBranch: remoteHead,
        rootCommits: roots,
      },
      sync: {
        fetchRemotes: fetch,
        fetchBranch,
        checkoutRemoteBranch: checkout,
        resetHard: reset,
      },
      change: { capture, apply, discard },
      worktree: {
        create: worktreeCreate,
        remove: worktreeRemove,
        list: worktreeList,
      },
      index: { refresh, ignored },
      tree: {
        capture: captureTree,
        captureExact: captureExactTree,
        retain: retainTree,
        contains: containsTree,
        exportClosure: exportSnapshotClosure,
        importClosure: importSnapshotClosure,
        reconcileRetention,
        write: writeTree,
        files: treeFiles,
        diff: treeDiff,
        preview,
        restore,
        checkout: checkoutTree,
        materialize: materializeTree,
      },
    });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(FileAccess.defaultLayer),
  Layer.provide(ProcessRunner.defaultLayer),
);
export const node = ServiceGraph.node(layer, [FileAccess.node, ProcessRunner.node]);

interface Result {
  readonly exitCode: number;
  readonly text: string;
  readonly stderr: string;
}

function run(cwd: string, proc: ProcessRunner.Interface) {
  return (args: string[]) =>
    execute(
      cwd,
      proc,
    )(args).pipe(
      Effect.catch(() => Effect.succeed({ exitCode: 1, text: "", stderr: "" })),
    );
}

function execute(cwd: string, proc: ProcessRunner.Interface) {
  return (args: string[]) =>
    proc
      .run(
        ChildProcess.make("git", args, {
          cwd,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.map(
          (result) =>
            ({
              exitCode: result.exitCode,
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            }) satisfies Result,
        ),
      );
}

function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "");
  if (!trimmed) return cwd;
  const normalized = FileAccess.windowsPath(trimmed);
  if (path.isAbsolute(normalized)) return path.normalize(normalized);
  return path.resolve(cwd, normalized);
}
