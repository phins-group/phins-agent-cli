import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { Hash } from "../src/shared/hash"
import { VerifierRegistry } from "../src/verification/registry"
import { testEffect } from "./lib/effect"

const it = testEffect(VerifierRegistry.defaultLayer)
const projectID = ProjectRegistry.ID.make("project_registry_test")
const projectRoot = AbsolutePath.make("/project")
const selectionInput = { projectID, projectRoot } satisfies VerifierRegistry.SelectInput
const bundleDigest = `sha256:${"a".repeat(64)}`
const GOLDEN_DIGEST = "sha256:b53ff1f4c5df42d1af7a5adcc9ce1dd11da66a35903feaa937ffb10c1cb92744"

const provenance = () => ({
  kind: "signed-policy" as const,
  authorityID: "production-policy",
  keyID: `sha256:${"c".repeat(64)}`,
  revision: 7,
  policyDigest: `sha256:${"d".repeat(64)}`,
})

const rootIdentity = (): VerifierRegistry.ProjectRootIdentity => ({
  schema: "phins.verifier-project-root-identity.v1",
  canonicalPath: projectRoot,
  device: "7",
  inode: "11",
})

const plan = () => ({
  id: "project-tests",
  version: "1",
  source: "policy" as const,
  check: {
    id: "unit",
    argv: ["pnpm", "run", "test"],
    cwd: "packages/core",
    timeoutMs: 120_000,
    maxOutputBytes: 16_384,
  },
  executor: {
    id: "local-sandbox",
    version: "1",
    bundleDigest,
  },
  containment: {
    subject: "snapshot-copy" as const,
    filesystem: "read-only" as const,
    network: "network-deny" as const,
    environment: "sanitized-env" as const,
  },
})

type ContainmentValues = {
  readonly subject: string
  readonly filesystem: string
  readonly network: string
  readonly environment: string
}

const canonicalDigest = (candidate: ReturnType<typeof plan>, containment: ContainmentValues) =>
  `sha256:${Hash.sha256(
    JSON.stringify([
      "phins.verifier-plan.v1",
      projectID,
      candidate.id,
      candidate.version,
      candidate.source,
      [
        candidate.check.id,
        candidate.check.argv,
        candidate.check.cwd,
        candidate.check.timeoutMs,
        candidate.check.maxOutputBytes,
      ],
      [candidate.executor.id, candidate.executor.version, candidate.executor.bundleDigest],
      [containment.subject, containment.filesystem, containment.network, containment.environment],
    ]),
  )}`

const canonicalProvenanceDigest = (candidate: ReturnType<typeof plan>, signed: ReturnType<typeof provenance>) =>
  `sha256:${Hash.sha256(
    JSON.stringify([
      "phins.verifier-plan.v2",
      projectID,
      projectRoot,
      candidate.id,
      candidate.version,
      candidate.source,
      [
        candidate.check.id,
        candidate.check.argv,
        candidate.check.cwd,
        candidate.check.timeoutMs,
        candidate.check.maxOutputBytes,
      ],
      [candidate.executor.id, candidate.executor.version, candidate.executor.bundleDigest],
      [
        candidate.containment.subject,
        candidate.containment.filesystem,
        candidate.containment.network,
        candidate.containment.environment,
      ],
      [signed.kind, signed.authorityID, signed.keyID, signed.revision, signed.policyDigest],
    ]),
  )}`

const canonicalRootIdentityDigest = (
  candidate: ReturnType<typeof plan>,
  signed: ReturnType<typeof provenance>,
  identity: VerifierRegistry.ProjectRootIdentity,
) =>
  `sha256:${Hash.sha256(
    JSON.stringify([
      "phins.verifier-plan.v3",
      projectID,
      projectRoot,
      [
        identity.schema,
        identity.canonicalPath,
        identity.device,
        identity.inode,
      ],
      candidate.id,
      candidate.version,
      candidate.source,
      [
        candidate.check.id,
        candidate.check.argv,
        candidate.check.cwd,
        candidate.check.timeoutMs,
        candidate.check.maxOutputBytes,
      ],
      [candidate.executor.id, candidate.executor.version, candidate.executor.bundleDigest],
      [
        candidate.containment.subject,
        candidate.containment.filesystem,
        candidate.containment.network,
        candidate.containment.environment,
      ],
      [signed.kind, signed.authorityID, signed.keyID, signed.revision, signed.policyDigest],
    ]),
  )}`

describe("VerifierRegistry", () => {
  test("pins a stable golden digest independent of object property order", () => {
    const expected = VerifierRegistry.pin(plan(), selectionInput)
    const reordered = {
      containment: {
        environment: "sanitized-env",
        network: "network-deny",
        filesystem: "read-only",
        subject: "snapshot-copy",
      },
      executor: {
        bundleDigest,
        version: "1",
        id: "local-sandbox",
      },
      check: {
        maxOutputBytes: 16_384,
        timeoutMs: 120_000,
        cwd: ".\\packages/core/../core",
        argv: ["pnpm", "run", "test"],
        id: "unit",
      },
      source: "policy",
      version: "1",
      id: "project-tests",
    }
    const actual = VerifierRegistry.pin(reordered, selectionInput)

    expect(actual.verifier.digest).toBe(GOLDEN_DIGEST)
    expect(actual.verifier.digest).toBe(expected.verifier.digest)
    expect(actual.verifier).not.toHaveProperty("provenance")
    expect(actual.projectRoot).toBe(projectRoot)
    expect(actual.plan).toEqual(expected.plan)
    expect(actual.plan.check.cwd).toBe("packages/core")
  })

  test("uses the v2 domain and changes the digest when any provenance field changes", () => {
    const base = provenance()
    const pinned = VerifierRegistry.pin(plan(), selectionInput, base)
    const changes = [
      { ...base, authorityID: "secondary-policy" },
      { ...base, keyID: `sha256:${"e".repeat(64)}` },
      { ...base, revision: 8 },
      { ...base, policyDigest: `sha256:${"f".repeat(64)}` },
    ]

    expect(pinned.verifier.digest).toBe(canonicalProvenanceDigest(plan(), base))
    expect(pinned.verifier.digest).not.toBe(GOLDEN_DIGEST)
    expect(pinned.verifier).toMatchObject({ provenance: base })
    for (const changed of changes)
      expect(VerifierRegistry.pin(plan(), selectionInput, changed).verifier.digest).not.toBe(pinned.verifier.digest)

    const anotherRoot = { ...selectionInput, projectRoot: AbsolutePath.make("/another-project") }
    expect(VerifierRegistry.pin(plan(), anotherRoot, base).verifier.digest).not.toBe(pinned.verifier.digest)
  })

  test("uses the v3 domain to bind canonical path, device and inode", () => {
    const signed = provenance()
    const identity = rootIdentity()
    const pinned = VerifierRegistry.pin(
      plan(),
      { ...selectionInput, projectRootIdentity: identity },
      signed,
    )

    expect(pinned.verifier.digest).toBe(
      canonicalRootIdentityDigest(plan(), signed, identity),
    )
    expect(pinned.projectRootIdentity).toEqual(identity)
    expect(pinned.verifier.digest).not.toBe(
      VerifierRegistry.pin(plan(), selectionInput, signed).verifier.digest,
    )
    for (const changed of [
      { ...identity, device: "8" },
      { ...identity, inode: "12" },
    ])
      expect(
        VerifierRegistry.pin(
          plan(),
          { ...selectionInput, projectRootIdentity: changed },
          signed,
        ).verifier.digest,
      ).not.toBe(pinned.verifier.digest)
    expect(() =>
      VerifierRegistry.pin(
        plan(),
        { ...selectionInput, projectRootIdentity: identity },
      ),
    ).toThrow("signed-policy provenance")
  })

  test("canonicalizes a symlink alias and detects replacement of the selected root", async () => {
    const temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "phins-verifier-root-")),
    )
    const directory = path.join(temporary, "project")
    const moved = path.join(temporary, "project-old")
    const alias = path.join(temporary, "project-alias")
    try {
      await mkdir(directory)
      await symlink(directory, alias, "dir")
      const identity = await Effect.runPromise(
        VerifierRegistry.inspectProjectRoot(AbsolutePath.make(alias)),
      )

      expect(identity.canonicalPath).toBe(AbsolutePath.make(directory))
      expect(identity.device).toMatch(/^(?:0|[1-9][0-9]*)$/)
      expect(identity.inode).toMatch(/^(?:0|[1-9][0-9]*)$/)

      await rename(directory, moved)
      await mkdir(directory)
      await expect(
        Effect.runPromise(
          VerifierRegistry.revalidateProjectRoot(identity),
        ),
      ).rejects.toThrow("changed after selection")
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("rejects malformed signed-policy provenance", () => {
    const base = provenance()
    const invalid = [
      { ...base, kind: "project-file" },
      { ...base, authorityID: "" },
      { ...base, authorityID: "x".repeat(257) },
      { ...base, keyID: "sha256:not-a-digest" },
      { ...base, revision: -1 },
      { ...base, revision: 1.5 },
      { ...base, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, policyDigest: "sha256:not-a-digest" },
      { ...base, unexpected: true },
      null,
    ]

    for (const candidate of invalid) expect(() => VerifierRegistry.pin(plan(), selectionInput, candidate)).toThrow()
  })

  test("changes the digest when any variable plan field or project changes", () => {
    const base = plan()
    const digest = VerifierRegistry.pin(base, selectionInput).verifier.digest
    const changes = [
      { ...base, id: "project-tests-next" },
      { ...base, version: "2" },
      { ...base, source: "task" as const },
      { ...base, check: { ...base.check, id: "integration" } },
      { ...base, check: { ...base.check, argv: ["pnpm", "run", "check"] } },
      { ...base, check: { ...base.check, cwd: "apps/agent" } },
      { ...base, check: { ...base.check, timeoutMs: 60_000 } },
      { ...base, check: { ...base.check, maxOutputBytes: 8_192 } },
      { ...base, executor: { ...base.executor, id: "remote-sandbox" } },
      { ...base, executor: { ...base.executor, version: "2" } },
      {
        ...base,
        executor: {
          ...base.executor,
          bundleDigest: `sha256:${"b".repeat(64)}`,
        },
      },
    ]

    for (const changed of changes)
      expect(VerifierRegistry.pin(changed, selectionInput).verifier.digest).not.toBe(digest)
    expect(
      VerifierRegistry.pin(base, {
        ...selectionInput,
        projectID: ProjectRegistry.ID.make("another_project"),
      }).verifier.digest,
    ).not.toBe(digest)
  })

  test("includes every fixed containment requirement in the digest", () => {
    const base = plan()
    const digest = VerifierRegistry.pin(base, selectionInput).verifier.digest

    expect(canonicalDigest(base, base.containment)).toBe(digest)
    for (const field of Object.keys(base.containment) as Array<keyof ContainmentValues>)
      expect(
        canonicalDigest(base, {
          ...base.containment,
          [field]: `${base.containment[field]}-changed`,
        }),
      ).not.toBe(digest)
  })

  test("pins qualified OCI image identity, platform, and containment profile", () => {
    const base = plan()
    const qualified = {
      ...base,
      executor: {
        id: "phins.oci",
        version: "1",
        bundleDigest,
        oci: {
          reference: `registry.example/phins/verifier@${bundleDigest}`,
          platform: "linux/amd64" as const,
        },
      },
      containment: {
        ...base.containment,
        profile: "linux-oci-v1" as const,
      },
    }
    const digest = VerifierRegistry.pin(qualified, selectionInput, provenance()).verifier.digest
    const otherBundle = `sha256:${"b".repeat(64)}`

    expect(
      VerifierRegistry.pin(
        {
          ...qualified,
          executor: {
            ...qualified.executor,
            bundleDigest: otherBundle,
            oci: {
              ...qualified.executor.oci,
              reference: `registry.example/phins/verifier@${otherBundle}`,
            },
          },
        },
        selectionInput,
        provenance(),
      ).verifier.digest,
    ).not.toBe(digest)
    expect(
      VerifierRegistry.pin(
        {
          ...qualified,
          executor: {
            ...qualified.executor,
            oci: { ...qualified.executor.oci, platform: "linux/arm64" as const },
          },
        },
        selectionInput,
        provenance(),
      ).verifier.digest,
    ).not.toBe(digest)
    expect(() =>
      VerifierRegistry.pin(
        {
          ...qualified,
          executor: {
            ...qualified.executor,
            oci: {
              ...qualified.executor.oci,
              reference: `registry.example/phins/verifier@sha256:${"b".repeat(64)}`,
            },
          },
        },
        selectionInput,
      ),
    ).toThrow()
    for (const reference of [
      "registry.example/phins/verifier:latest",
      `Registry.example/phins/verifier@${bundleDigest}`,
      `registry.example/phins/../verifier@${bundleDigest}`,
      `registry.example//phins/verifier@${bundleDigest}`,
    ])
      expect(() =>
        VerifierRegistry.pin(
          {
            ...qualified,
            executor: {
              ...qualified.executor,
              oci: { ...qualified.executor.oci, reference },
            },
          },
          selectionInput,
        ),
      ).toThrow()

    const pinned = VerifierRegistry.pin(qualified, selectionInput)
    expect(Object.isFrozen(pinned.plan.executor.oci)).toBe(true)
  })

  test("rejects unsafe cwd, malformed executor digest, invalid argv, and excessive limits", () => {
    expect(() => VerifierRegistry.pin({ ...plan(), check: { ...plan().check, cwd: "" } }, selectionInput)).toThrow()
    expect(() =>
      VerifierRegistry.pin({ ...plan(), check: { ...plan().check, cwd: "../outside" } }, selectionInput),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin({ ...plan(), check: { ...plan().check, cwd: "/outside" } }, selectionInput),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        {
          ...plan(),
          executor: { ...plan().executor, bundleDigest: "sha256:not-a-digest" },
        },
        selectionInput,
      ),
    ).toThrow()
    expect(() => VerifierRegistry.pin({ ...plan(), check: { ...plan().check, argv: [] } }, selectionInput)).toThrow()
    expect(() => VerifierRegistry.pin({ ...plan(), check: { ...plan().check, argv: [""] } }, selectionInput)).toThrow()
    expect(() => VerifierRegistry.pin({ ...plan(), check: { ...plan().check, argv: ["  "] } }, selectionInput)).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        {
          ...plan(),
          check: {
            ...plan().check,
            argv: Array.from({ length: 17 }, () => "x".repeat(4_096)),
          },
        },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        { ...plan(), check: { ...plan().check, cwd: "x".repeat(VerifierRegistry.MAX_CWD_BYTES + 1) } },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        { ...plan(), check: { ...plan().check, cwd: "é".repeat(VerifierRegistry.MAX_CWD_BYTES / 2 + 1) } },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        {
          ...plan(),
          check: {
            ...plan().check,
            argv: Array.from({ length: 16 }, () => "é".repeat(2_048)),
          },
        },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        {
          ...plan(),
          check: {
            ...plan().check,
            timeoutMs: VerifierRegistry.MAX_TIMEOUT_MS + 1,
          },
        },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        {
          ...plan(),
          check: {
            ...plan().check,
            maxOutputBytes: VerifierRegistry.MAX_OUTPUT_BYTES + 1,
          },
        },
        selectionInput,
      ),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(plan(), {
        ...selectionInput,
        projectID: ProjectRegistry.ID.make("x".repeat(VerifierRegistry.MAX_PROJECT_ID_BYTES + 1)),
      }),
    ).toThrow()
    expect(() =>
      VerifierRegistry.pin(
        plan(),
        {
          ...selectionInput,
          projectID: ProjectRegistry.ID.make("é".repeat(VerifierRegistry.MAX_PROJECT_ID_BYTES / 2 + 1)),
        },
      ),
    ).toThrow()
  })

  test("deep-freezes the pinned plan and verifier", () => {
    const pinned = VerifierRegistry.pin(plan(), selectionInput, provenance())

    expect(Object.isFrozen(pinned)).toBe(true)
    expect(Object.isFrozen(pinned.plan)).toBe(true)
    expect(Object.isFrozen(pinned.plan.check)).toBe(true)
    expect(Object.isFrozen(pinned.plan.check.argv)).toBe(true)
    expect(Object.isFrozen(pinned.plan.executor)).toBe(true)
    expect(Object.isFrozen(pinned.plan.containment)).toBe(true)
    expect(Object.isFrozen(pinned.verifier)).toBe(true)
    expect(Object.isFrozen(pinned.verifier.provenance)).toBe(true)
  })

  it.effect("supplies project root to selectors while the empty and fixed registries remain compatible", () =>
    Effect.gen(function* () {
      const registry = yield* VerifierRegistry.Registry
      const input = { projectID, projectRoot }
      expect(yield* registry.select(input)).toBeUndefined()

      let received: VerifierRegistry.SelectInput | undefined
      const observing: VerifierRegistry.Interface = {
        select: (next) =>
          Effect.sync(() => {
            received = next
            return undefined
          }),
      }
      yield* observing.select(input)
      expect(received).toBe(input)
      expect(received?.projectRoot).toBe(projectRoot)

      const selected = yield* VerifierRegistry.fixed(plan()).select(input)
      expect(selected).toEqual(VerifierRegistry.pin(plan(), input))
      expect(Object.isFrozen(selected)).toBe(true)
      expect(Object.isFrozen(selected?.plan)).toBe(true)
      expect(Object.isFrozen(selected?.verifier)).toBe(true)
    }),
  )
})
