import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { FileAccess } from "../src/workspace/files/access"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { AbsolutePath } from "../src/shared/schema"
import { VerifierAuthority } from "../src/verification/authority"
import { VerifierRegistry } from "../src/verification/registry"

const projectID = ProjectRegistry.ID.make("project_signed_authority_test")
const projectRoot = path.resolve(
  path.parse(process.cwd()).root,
  "phins-authority-project",
)
const absoluteProjectRoot = AbsolutePath.make(projectRoot)
const otherProjectRoot = path.resolve(
  path.parse(process.cwd()).root,
  "phins-authority-project-secondary",
)
const absoluteOtherProjectRoot = AbsolutePath.make(otherProjectRoot)
const nowMs = 2_000_000

const authority = generateKeyPairSync("ed25519")
const otherAuthority = generateKeyPairSync("ed25519")
const spki = Buffer.from(
  authority.publicKey.export({ format: "der", type: "spki" }),
)
const authoritySpki = spki.toString("base64url")

const plan = () => ({
  id: "signed-project-tests",
  version: "1",
  source: "policy" as const,
  check: {
    id: "unit",
    argv: ["pnpm", "--filter", "@phins/core", "test"],
    cwd: ".",
    timeoutMs: 120_000,
    maxOutputBytes: 16_384,
  },
  executor: {
    id: "oci-verifier",
    version: "1",
    bundleDigest: `sha256:${"a".repeat(64)}`,
  },
  containment: {
    subject: "snapshot-copy" as const,
    filesystem: "read-only" as const,
    network: "network-deny" as const,
    environment: "sanitized-env" as const,
  },
})

const payload = (overrides: Record<string, unknown> = {}) => ({
  schema: "phins.verifier-policy.v1",
  authorityID: "phins-test-authority",
  revision: 7,
  notBeforeMs: nowMs - 1_000,
  expiresAtMs: nowMs + 1_000,
  entries: [{ projectID, projectRoot, plan: plan() }],
  ...overrides,
})

const bundle = (value: unknown, privateKey = authority.privateKey) => {
  const payloadBytes = Buffer.from(JSON.stringify(value), "utf8")
  return {
    payloadBytes,
    text: JSON.stringify({
      payload: payloadBytes.toString("base64url"),
      signature: sign(null, payloadBytes, privateKey).toString("base64url"),
    }),
  }
}

const policyDigest = (payloadBytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`

const bundlePolicyDigest = (text: string) => {
  const envelope = JSON.parse(text) as { payload: string }
  return policyDigest(Buffer.from(envelope.payload, "base64url"))
}

const trusted = (
  text: string,
  overrides: Partial<VerifierAuthority.TrustedInput> = {},
) => ({
  bundle: text,
  expectedAuthorityID: "phins-test-authority",
  expectedRevision: 7,
  expectedPolicyDigest: bundlePolicyDigest(text),
  authoritySpki,
  nowMs,
  projectRootInspector: null,
  ...overrides,
})

const expectFailure = (
  run: () => unknown,
  reason: VerifierAuthority.ErrorReason,
) => {
  let failure: unknown
  try {
    run()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
  expect((failure as VerifierAuthority.AuthorityError).reason).toBe(reason)
}

describe("VerifierAuthority", () => {
  test("canonicalizes a project-root alias into a v3 identity-bound selection", async () => {
    const temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "phins-authority-root-")),
    )
    const directory = path.join(temporary, "project")
    const alias = path.join(temporary, "project-alias")
    try {
      await mkdir(directory)
      await symlink(directory, alias, "dir")
      const signed = bundle(
        payload({
          entries: [{ projectID, projectRoot: directory, plan: plan() }],
        }),
      )
      const registry = VerifierAuthority.make(
        trusted(signed.text, { projectRootInspector: undefined }),
      )

      const selected = await Effect.runPromise(
        registry.select({
          projectID,
          projectRoot: AbsolutePath.make(alias),
        }),
      )

      expect(selected?.projectRoot).toBe(AbsolutePath.make(directory))
      expect(selected?.projectRootIdentity).toMatchObject({
        schema: "phins.verifier-project-root-identity.v1",
        canonicalPath: AbsolutePath.make(directory),
      })
      expect(selected?.verifier.digest).not.toBe(
        VerifierRegistry.pin(
          plan(),
          { projectID, projectRoot: AbsolutePath.make(directory) },
          selected?.verifier.provenance,
        ).verifier.digest,
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("verifies an Ed25519 bundle and returns one immutable exact-match selection", async () => {
    const signed = bundle(payload())
    const registry = VerifierAuthority.make(trusted(signed.text))

    const selected = await Effect.runPromise(
      registry.select({ projectID, projectRoot: absoluteProjectRoot }),
    )
    expect(selected?.plan).toEqual(plan())
    expect(selected?.projectID).toBe(projectID)
    expect(selected?.projectRoot).toBe(absoluteProjectRoot)
    expect(selected?.verifier.provenance).toEqual({
      kind: "signed-policy",
      authorityID: "phins-test-authority",
      keyID: `sha256:${createHash("sha256").update(spki).digest("hex")}`,
      revision: 7,
      policyDigest: `sha256:${createHash("sha256").update(signed.payloadBytes).digest("hex")}`,
    })
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected?.verifier.provenance)).toBe(true)

    expect(
      await Effect.runPromise(
        registry.select({
          projectID,
          projectRoot: AbsolutePath.make(
            path.resolve(path.parse(process.cwd()).root, "different-project"),
          ),
        }),
      ),
    ).toBeUndefined()
    expect(
      await Effect.runPromise(
        registry.select({
          projectID: ProjectRegistry.ID.make("another-project"),
          projectRoot: absoluteProjectRoot,
        }),
      ),
    ).toBeUndefined()
  })

  test("binds signed selections and verifier digests to the exact project root", async () => {
    const signed = bundle(
      payload({
        entries: [
          { projectID, projectRoot, plan: plan() },
          { projectID, projectRoot: otherProjectRoot, plan: plan() },
        ],
      }),
    )
    const registry = VerifierAuthority.make(trusted(signed.text))

    const primary = await Effect.runPromise(
      registry.select({ projectID, projectRoot: absoluteProjectRoot }),
    )
    const secondary = await Effect.runPromise(
      registry.select({ projectID, projectRoot: absoluteOtherProjectRoot }),
    )
    expect(primary?.projectRoot).toBe(absoluteProjectRoot)
    expect(secondary?.projectRoot).toBe(absoluteOtherProjectRoot)
    expect(primary?.verifier.provenance).toEqual(secondary?.verifier.provenance)
    expect(primary?.verifier.digest).not.toBe(secondary?.verifier.digest)

    const unauthorizedRoot = AbsolutePath.make(
      path.resolve(
        path.parse(process.cwd()).root,
        "phins-authority-project-transplant",
      ),
    )
    expect(
      await Effect.runPromise(
        registry.select({ projectID, projectRoot: unauthorizedRoot }),
      ),
    ).toBeUndefined()
  })

  test("rejects payload tampering before parsing the changed payload", () => {
    const signed = bundle(payload())
    const envelope = JSON.parse(signed.text) as {
      payload: string
      signature: string
    }
    envelope.payload = Buffer.from("not-json", "utf8").toString("base64url")

    expectFailure(
      () => VerifierAuthority.make(trusted(JSON.stringify(envelope))),
      "signature",
    )
  })

  test("rejects a signature from the wrong key and a non-Ed25519 trusted key", () => {
    const signedByOther = bundle(payload(), otherAuthority.privateKey)
    expectFailure(
      () => VerifierAuthority.make(trusted(signedByOther.text)),
      "signature",
    )

    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    const ecSpki = Buffer.from(
      ec.publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64url")
    const signed = bundle(payload())
    expectFailure(
      () =>
        VerifierAuthority.make(trusted(signed.text, { authoritySpki: ecSpki })),
      "key",
    )
  })

  test("rejects a parseable but non-canonical Ed25519 SPKI", () => {
    const signed = bundle(payload())
    // OpenSSL accepts and discards trailing DER bytes. Trust configuration must
    // bind the unique canonical SubjectPublicKeyInfo encoding instead.
    const nonCanonicalSpki = Buffer.concat([spki, Buffer.of(0)]).toString(
      "base64url",
    )
    expectFailure(
      () =>
        VerifierAuthority.make(
          trusted(signed.text, { authoritySpki: nonCanonicalSpki }),
        ),
      "key",
    )
  })

  test("rejects a signed payload from a different authority", () => {
    const signed = bundle(payload({ authorityID: "another-authority" }))
    expectFailure(
      () => VerifierAuthority.make(trusted(signed.text)),
      "authority",
    )
  })

  test("rejects signed policy rollback and untrusted future revisions", () => {
    const rollback = bundle(payload({ revision: 6 }))
    expectFailure(
      () => VerifierAuthority.make(trusted(rollback.text)),
      "revision",
    )

    const future = bundle(payload({ revision: 8 }))
    expectFailure(
      () => VerifierAuthority.make(trusted(future.text)),
      "revision",
    )

    const current = bundle(payload())
    expectFailure(
      () =>
        VerifierAuthority.make(
          trusted(current.text, {
            expectedRevision: Number.MAX_SAFE_INTEGER + 1,
          }),
        ),
      "configuration",
    )
  })

  test("rejects a different valid bundle at the same trusted revision", () => {
    const trustedBundle = bundle(payload())
    const transplanted = bundle(
      payload({
        entries: [
          {
            projectID,
            projectRoot: otherProjectRoot,
            plan: plan(),
          },
        ],
      }),
    )

    expectFailure(
      () =>
        VerifierAuthority.make(
          trusted(transplanted.text, {
            expectedPolicyDigest: policyDigest(trustedBundle.payloadBytes),
          }),
        ),
      "digest",
    )
    for (const invalid of [
      createHash("sha256").update(trustedBundle.payloadBytes).digest("hex"),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
    ]) {
      expectFailure(
        () =>
          VerifierAuthority.make(
            trusted(trustedBundle.text, { expectedPolicyDigest: invalid }),
          ),
        "configuration",
      )
    }
  })

  test("rejects expired and not-yet-active policy windows", () => {
    const expired = bundle(payload({ expiresAtMs: nowMs }))
    expectFailure(
      () => VerifierAuthority.make(trusted(expired.text)),
      "inactive",
    )

    const future = bundle(
      payload({ notBeforeMs: nowMs + 1, expiresAtMs: nowMs + 2_000 }),
    )
    expectFailure(
      () => VerifierAuthority.make(trusted(future.text)),
      "inactive",
    )
  })

  test("revalidates expiry on every selection from a long-lived registry", async () => {
    let current = nowMs
    const signed = bundle(payload())
    const registry = VerifierAuthority.make(
      trusted(signed.text, {
        nowMs: undefined,
        clock: () => current,
      }),
    )

    expect(
      await Effect.runPromise(
        registry.select({ projectID, projectRoot: absoluteProjectRoot }),
      ),
    ).toBeDefined()
    current = nowMs + 1_000
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.select({ projectID, projectRoot: absoluteProjectRoot }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
      expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
        "inactive",
      )
    }
  })

  test("rejects duplicate exact project/root entries", () => {
    const entry = { projectID, projectRoot, plan: plan() }
    const signed = bundle(payload({ entries: [entry, entry] }))
    expectFailure(
      () => VerifierAuthority.make(trusted(signed.text)),
      "duplicate",
    )
  })

  test("requires policy-source plans, normalized absolute roots, and strict payload fields", () => {
    const projectPlan = { ...plan(), source: "project" }
    const wrongSource = bundle(
      payload({ entries: [{ projectID, projectRoot, plan: projectPlan }] }),
    )
    expectFailure(
      () => VerifierAuthority.make(trusted(wrongSource.text)),
      "payload",
    )

    const relativeRoot = bundle(
      payload({
        entries: [{ projectID, projectRoot: "relative", plan: plan() }],
      }),
    )
    expectFailure(
      () => VerifierAuthority.make(trusted(relativeRoot.text)),
      "payload",
    )

    const extra = bundle({ ...payload(), unexpected: true })
    expectFailure(() => VerifierAuthority.make(trusted(extra.text)), "payload")
  })

  test("strictly rejects excess envelope fields", () => {
    const signed = bundle(payload())
    const envelope = {
      ...(JSON.parse(signed.text) as object),
      unexpected: true,
    }
    expectFailure(
      () => VerifierAuthority.make(trusted(JSON.stringify(envelope))),
      "envelope",
    )
  })

  test("environment layer is empty only when all settings are absent and rejects partial settings", async () => {
    const empty = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* VerifierRegistry.Registry
      }).pipe(
        Effect.provide(VerifierAuthority.layer({ env: {}, nowMs })),
        Effect.provide(FileAccess.defaultLayer),
      ),
    )
    expect(
      await Effect.runPromise(
        empty.select({ projectID, projectRoot: absoluteProjectRoot }),
      ),
    ).toBeUndefined()

    const partial = Effect.gen(function* () {
      return yield* VerifierRegistry.Registry
    }).pipe(
      Effect.provide(
        VerifierAuthority.layer({
          env: { [VerifierAuthority.ENV.authorityID]: "phins-test-authority" },
          nowMs,
        }),
      ),
      Effect.provide(FileAccess.defaultLayer),
    )
    const exit = await Effect.runPromise(Effect.exit(partial))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("required authority mode fails closed and rejects invalid switch values", async () => {
    const required = Effect.gen(function* () {
      return yield* VerifierRegistry.Registry
    }).pipe(
      Effect.provide(
        VerifierAuthority.layer({
          env: { [VerifierAuthority.ENV.required]: "1" },
          nowMs,
        }),
      ),
      Effect.provide(FileAccess.defaultLayer),
    )
    const requiredExit = await Effect.runPromise(Effect.exit(required))
    expect(Exit.isFailure(requiredExit)).toBe(true)
    if (Exit.isFailure(requiredExit)) {
      const failure = Cause.squash(requiredExit.cause)
      expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
      expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
        "configuration",
      )
    }

    for (const invalid of ["0", "true", " 1", ""]) {
      const configured = Effect.gen(function* () {
        return yield* VerifierRegistry.Registry
      }).pipe(
        Effect.provide(
          VerifierAuthority.layer({
            env: { [VerifierAuthority.ENV.required]: invalid },
            nowMs,
          }),
        ),
        Effect.provide(FileAccess.defaultLayer),
      )
      const exit = await Effect.runPromise(Effect.exit(configured))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
        expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
          "configuration",
        )
      }
    }
  })

  test("environment revision and payload digest pins are canonical", async () => {
    const signed = bundle(payload())
    for (const invalid of ["07", "+7", "7.0", "7e0", "9007199254740992"]) {
      const configured = Effect.gen(function* () {
        return yield* VerifierRegistry.Registry
      }).pipe(
        Effect.provide(
          VerifierAuthority.layer({
            env: {
              [VerifierAuthority.ENV.bundle]: path.resolve(
                path.parse(process.cwd()).root,
                "not-read.json",
              ),
              [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
              [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
              [VerifierAuthority.ENV.revision]: invalid,
              [VerifierAuthority.ENV.digest]: policyDigest(
                signed.payloadBytes,
              ),
            },
            nowMs,
          }),
        ),
        Effect.provide(FileAccess.defaultLayer),
      )
      const exit = await Effect.runPromise(Effect.exit(configured))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
        expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
          "configuration",
        )
      }
    }

    for (const invalid of [
      createHash("sha256").update(signed.payloadBytes).digest("hex"),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(65)}`,
    ]) {
      const configured = VerifierAuthority.loadFromEnvironment({
        env: {
          [VerifierAuthority.ENV.bundle]: path.resolve(
            path.parse(process.cwd()).root,
            "not-read.json",
          ),
          [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
          [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
          [VerifierAuthority.ENV.revision]: "7",
          [VerifierAuthority.ENV.digest]: invalid,
        },
        nowMs,
      })
      const exit = await Effect.runPromise(Effect.exit(configured))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
        expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
          "configuration",
        )
      }
    }

    const missingDigest = VerifierAuthority.loadFromEnvironment({
      env: {
        [VerifierAuthority.ENV.bundle]: path.resolve(
          path.parse(process.cwd()).root,
          "not-read.json",
        ),
        [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
        [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
        [VerifierAuthority.ENV.revision]: "7",
      },
      nowMs,
    })
    const missingExit = await Effect.runPromise(Effect.exit(missingDigest))
    expect(Exit.isFailure(missingExit)).toBe(true)
    if (Exit.isFailure(missingExit)) {
      const failure = Cause.squash(missingExit.cause)
      expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
      expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
        "configuration",
      )
    }
  })

  test("environment layer reads an absolute bundle file once", async () => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "phins-verifier-authority-")),
    )
    const filepath = path.join(directory, "policy.json")
    try {
      const signed = bundle(
        payload({
          entries: [{ projectID, projectRoot: directory, plan: plan() }],
        }),
      )
      await writeFile(filepath, signed.text, "utf8")
      const registry = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* VerifierRegistry.Registry
        }).pipe(
          Effect.provide(
            VerifierAuthority.layer({
              env: {
                [VerifierAuthority.ENV.bundle]: filepath,
                [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
                [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
                [VerifierAuthority.ENV.revision]: "7",
                [VerifierAuthority.ENV.digest]: policyDigest(
                  signed.payloadBytes,
                ),
                [VerifierAuthority.ENV.required]: "1",
              },
              nowMs,
            }),
          ),
          Effect.provide(FileAccess.defaultLayer),
        ),
      )

      await writeFile(filepath, "not the original signed bundle", "utf8")
      const selected = await Effect.runPromise(
        registry.select({
          projectID,
          projectRoot: AbsolutePath.make(directory),
        }),
      )
      expect(selected?.projectRoot).toBe(AbsolutePath.make(directory))
      expect(selected?.projectRootIdentity).toMatchObject({
        schema: "phins.verifier-project-root-identity.v1",
        canonicalPath: AbsolutePath.make(directory),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("environment loader rejects an oversized bundle before reading it", async () => {
    const directory = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "phins-verifier-authority-oversized-"),
      ),
    )
    const filepath = path.join(directory, "policy.json")
    try {
      await writeFile(filepath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
      const configured = Effect.gen(function* () {
        return yield* VerifierRegistry.Registry
      }).pipe(
        Effect.provide(
          VerifierAuthority.layer({
            env: {
              [VerifierAuthority.ENV.bundle]: filepath,
              [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
              [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
              [VerifierAuthority.ENV.revision]: "7",
              [VerifierAuthority.ENV.digest]: `sha256:${"0".repeat(64)}`,
            },
            nowMs,
          }),
        ),
        Effect.provide(FileAccess.defaultLayer),
      )
      const exit = await Effect.runPromise(Effect.exit(configured))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
        expect((failure as VerifierAuthority.AuthorityError).reason).toBe(
          "read",
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("environment loader rejects symlink aliases and invalid UTF-8", async () => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "phins-verifier-authority-secure-")),
    )
    const filepath = path.join(directory, "policy.json")
    const alias = path.join(directory, "policy-link.json")
    const signed = bundle(payload())
    const environment = (bundlePath: string) => ({
      [VerifierAuthority.ENV.bundle]: bundlePath,
      [VerifierAuthority.ENV.authorityID]: "phins-test-authority",
      [VerifierAuthority.ENV.authoritySpki]: authoritySpki,
      [VerifierAuthority.ENV.revision]: "7",
      [VerifierAuthority.ENV.digest]: policyDigest(signed.payloadBytes),
    })
    const failureReason = async (bundlePath: string) => {
      const exit = await Effect.runPromise(
        Effect.exit(
          VerifierAuthority.loadFromEnvironment({
            env: environment(bundlePath),
            nowMs,
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return undefined
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(VerifierAuthority.AuthorityError)
      return (failure as VerifierAuthority.AuthorityError).reason
    }

    try {
      await writeFile(filepath, signed.text, "utf8")
      await symlink(filepath, alias)
      expect(await failureReason(alias)).toBe("read")

      await writeFile(filepath, Buffer.from([0xff, 0xfe, 0xfd]))
      expect(await failureReason(filepath)).toBe("read")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
