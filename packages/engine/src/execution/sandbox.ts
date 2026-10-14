export * as ProcessSandbox from "./sandbox"

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import * as LocalPolicy from "../security/launcher-policy"
import { Effect, Schema } from "effect"

export const Policy = Schema.Struct({
  mode: Schema.Literals(["disabled", "read-only", "workspace-write"]),
  network: Schema.Literals(["deny", "allow"]).pipe(Schema.optional),
  writeRoots: Schema.Array(Schema.String).pipe(Schema.optional),
  denyRead: Schema.Array(Schema.String).pipe(Schema.optional),
})
export type Policy = typeof Policy.Type

export class Error extends Schema.TaggedErrorClass<Error>()("ProcessSandboxError", {
  message: Schema.String,
}) {}

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** Active project, never the model-selected workdir. */
  readonly root: string
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const protectedNames = [".git", ".agents", ".codex", ".phins"]

/** Only the launcher environment can set policy. Never read project config. */
const launcherPolicy = process.env.PHINS_SANDBOX_POLICY
const decode = Schema.decodeUnknownSync(Policy)

export const parse = (value: string | undefined): Policy =>
  value === undefined ? { mode: "disabled" } : decode(JSON.parse(value))

export const prepareWith = (policy: Policy, input: Command) =>
  Effect.tryPromise({
    try: async () => {
      if (LocalPolicy.enabled && (policy.mode === "disabled" || policy.network === "allow" || policy.writeRoots?.length))
        throw new globalThis.Error("Autonomous profile requires contained files and denied networking")
      if (policy.mode === "disabled") return input
      if (process.platform !== "darwin" && process.platform !== "linux")
        throw new globalThis.Error(`Sandbox is unavailable on ${process.platform}`)

      const { SandboxManager, getDefaultWritePaths } = await import("@anthropic-ai/sandbox-runtime")
      const dependencies = SandboxManager.checkDependencies()
      // Missing seccomp is a warning upstream but leaves Unix sockets open.
      const problems = [...dependencies.errors, ...dependencies.warnings]
      if (problems.length) throw new globalThis.Error(problems.join("; "))

      const root = await fs.realpath(input.root)
      const roots =
        policy.mode === "workspace-write"
          ? await Promise.all(
              [root, ...(policy.writeRoots ?? [])].map(async (value) => {
                if (!path.isAbsolute(value)) throw new globalThis.Error("Sandbox roots must be absolute")
                const canonical = await fs.realpath(value)
                if (!(await fs.stat(canonical)).isDirectory())
                  throw new globalThis.Error("Sandbox root is not a directory")
                return canonical
              }),
            )
          : []
      const denyWrite = getDefaultWritePaths().filter((entry) => !entry.startsWith("/dev/"))
      for (const directory of new Set([root, ...roots])) {
        for (const name of protectedNames) {
          const entry = path.join(directory, name)
          denyWrite.push(entry)
          try {
            denyWrite.push(await fs.realpath(entry))
            if (name === ".git" && (await fs.stat(entry)).isFile()) {
              const match = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(entry, "utf8"))
              if (match) denyWrite.push(await fs.realpath(path.resolve(directory, match[1]!)))
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      }
      if (LocalPolicy.enabled) {
        denyWrite.push(...LocalPolicy.protectedPaths(root))
        if (!LocalPolicy.permitted(root, input.cwd)) throw new globalThis.Error("Command cwd is outside the reviewed project")
      }
      const privateHome = process.env.PHINS_TEST_HOME ?? os.homedir()
      if (LocalPolicy.enabled && LocalPolicy.inside(root, path.join(privateHome, ".phins")))
        throw new globalThis.Error("Autonomous project must not contain the agent credential store")
      if (LocalPolicy.enabled) {
        // A reviewed demo tree cannot also be a credential/config store. The
        // sandbox re-allows the project subtree, so reject sensitive paths there.
        const inspect = async (directory: string) => {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if ([".git", "node_modules"].includes(entry.name)) continue
            const target = path.join(directory, entry.name)
            if (!LocalPolicy.permitted(root, target)) throw new globalThis.Error("Reviewed project contains a sensitive or external path")
            if (entry.isDirectory()) await inspect(target)
          }
        }
        await inspect(root)
      }
      const privatePaths = [path.join(privateHome, ".phins"), path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".aws"),
        ...[process.env.PHINS_SPENDING_LEDGER, process.env.PHINS_CONFIG].filter((p): p is string => !!p)]
      const runtimes = LocalPolicy.enabled ? (await Promise.all(["node", "bun"].map(async (name) => {
        const executable = Bun.which(name)
        return executable ? [executable, await fs.realpath(executable)] : []
      }))).flat() : []
      // Per-invocation policy; deny-all networking needs no mutable proxy.
      const wrapped = await SandboxManager.wrapWithSandbox(
        `${LocalPolicy.enabled ? "ulimit -t 30 && ulimit -f 102400 && ulimit -n 256 || exit 125; " : ""}export TMPDIR=${quote(root)}; exec ${[input.command, ...input.args].map(quote).join(" ")}`,
        "/bin/sh",
        {
          filesystem: {
            allowWrite: [...new Set(roots)],
            denyWrite,
            denyRead: [...(policy.denyRead ?? []), ...(LocalPolicy.enabled ? ["/", ...privatePaths] : [])],
            ...(LocalPolicy.enabled ? { allowRead: [root, "/bin", "/sbin", "/usr", "/System", "/Library",
              "/opt/homebrew", "/private/etc", "/dev", "/private/var/db/dyld", "/private/var/select", ...runtimes] } : {}),
          },
          ...(policy.network === "allow" ? {} : { network: { allowedDomains: [], deniedDomains: [] } }),
          allowPty: true,
        },
      )
      return { ...input, command: "/bin/sh", args: ["-c", wrapped] }
    },
    catch: (cause) => new Error({ message: `Sandbox setup failed: ${String(cause)}` }),
  })

export const prepare = (input: Command) =>
  Effect.try({
    try: () => parse(launcherPolicy ?? (LocalPolicy.enabled ? '{"mode":"workspace-write","network":"deny"}' : undefined)),
    catch: (cause) => new Error({ message: `Invalid PHINS_SANDBOX_POLICY: ${String(cause)}` }),
  }).pipe(Effect.flatMap((policy) => prepareWith(policy, input)))

export const enabled = (() => {
  try {
    return LocalPolicy.enabled || parse(launcherPolicy).mode !== "disabled"
  } catch {
    return true
  }
})()
