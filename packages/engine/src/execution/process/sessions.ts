export * as ProcessSessions from "./sessions"

import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { Context, Effect, Layer, Schema } from "effect"
import { ProcessSandbox } from "../sandbox"

const OUTPUT_LIMIT = 256 * 1024 // UTF-16 code units; at most 1 MiB UTF-8.
const ACTIVE_LIMIT = 16
const EXITED_LIMIT = 32
export const MAX_TIMEOUT = 10 * 60 * 1000

export class Error extends Schema.TaggedErrorClass<Error>()("ProcessSessionError", { message: Schema.String }) {}
export const Snapshot = Schema.Struct({
  processID: Schema.String,
  status: Schema.Literals(["running", "exited", "cancelled", "timed-out"]),
  output: Schema.String,
  cursor: Schema.Number,
  omitted: Schema.Number,
  exitCode: Schema.optional(Schema.Number),
})
export type Snapshot = typeof Snapshot.Type
export const Followup = Schema.Struct({
  processID: Schema.String,
  action: Schema.Literals(["wait", "write", "cancel"]),
  cursor: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  waitMs: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 30000 }))),
  data: Schema.optional(Schema.String),
})
export type Followup = typeof Followup.Type
type Start = ProcessSandbox.Command & { readonly timeout?: number }
type Entry = {
  owner: string
  process: ChildProcess
  status: Snapshot["status"]
  output: string
  cursor: number
  exitCode?: number
  changed: Set<() => void>
  timer: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
  done: Promise<void>
  closed: boolean
}
export interface Interface {
  start(owner: string, input: Start): Effect.Effect<string, Error | ProcessSandbox.Error>
  followup(owner: string, input: Followup): Effect.Effect<Snapshot, Error>
  disposeOwner(owner: string): Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@phins/ProcessSessions") {}

export const make = Effect.gen(function* () {
  const boot = randomUUID()
  const entries = new Map<string, Entry>()
  let reservations = 0
  const signal = (entry: Entry) => {
    for (const notify of [...entry.changed]) notify()
  }
  const kill = (entry: Entry, name: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && entry.process.pid) process.kill(-entry.process.pid, name)
      else entry.process.kill(name)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    }
  }
  const stop = (entry: Entry, status: "cancelled" | "timed-out") => {
    if (entry.status !== "running") return
    entry.status = status
    kill(entry, "SIGTERM")
    entry.killTimer = setTimeout(() => kill(entry, "SIGKILL"), 3000)
    entry.killTimer.unref()
    signal(entry)
  }
  const disposeOwner = (owner: string) =>
    Effect.promise(async () => {
      const owned = [...entries.entries()].filter(([, entry]) => entry.owner === owner)
      for (const [, entry] of owned) stop(entry, "cancelled")
      await Promise.all(owned.map(([, entry]) => entry.done))
      for (const [id] of owned) entries.delete(id)
    })
  yield* Effect.addFinalizer(() =>
    Effect.forEach(new Set([...entries.values()].map((entry) => entry.owner)), disposeOwner, {
      concurrency: "unbounded",
      discard: true,
    }),
  )

  const start: Interface["start"] = (owner, input) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin" && process.platform !== "linux")
        return yield* new Error({
          message: "Process sessions currently require macOS or Linux",
        })
      if (
        !owner ||
        !Number.isFinite(input.timeout ?? MAX_TIMEOUT) ||
        (input.timeout ?? MAX_TIMEOUT) <= 0 ||
        (input.timeout ?? MAX_TIMEOUT) > MAX_TIMEOUT
      )
        return yield* new Error({
          message: `Process timeout must be between 1 and ${MAX_TIMEOUT} ms`,
        })
      if ([...entries.values()].filter((entry) => !entry.closed).length + reservations >= ACTIVE_LIMIT)
        return yield* new Error({
          message: `Active process limit (${ACTIVE_LIMIT}) reached`,
        })
      reservations++
      return yield* Effect.gen(function* () {
        const command = yield* ProcessSandbox.prepare(input)
        return yield* Effect.try({
          try: () => {
            const id = `proc_${boot}_${randomUUID()}`
            const child = spawn(command.command, [...command.args], {
              cwd: command.cwd,
              env: command.env,
              detached: process.platform !== "win32",
              stdio: "pipe",
            })
            let finish!: () => void
            const done = new Promise<void>((resolve) => {
              finish = resolve
            })
            const entry: Entry = {
              owner,
              process: child,
              status: "running",
              output: "",
              cursor: 0,
              changed: new Set(),
              done,
              closed: false,
              timer: setTimeout(() => stop(entry, "timed-out"), input.timeout ?? MAX_TIMEOUT),
            }
            entry.timer.unref()
            const append = (text: string) => {
              entry.cursor += text.length
              entry.output = (entry.output + text).slice(-OUTPUT_LIMIT)
              signal(entry)
            }
            for (const source of [child.stdout, child.stderr]) {
              const decoder = new StringDecoder("utf8")
              source?.on("data", (chunk: Buffer) => append(decoder.write(chunk)))
              source?.on("end", () => append(decoder.end()))
            }
            // EPIPE is expected when an interactive child closes stdin first.
            child.stdin?.on("error", () => {})
            child.on("error", (cause) => append(`Process error: ${cause.message}\n`))
            child.once("close", (code) => {
              entry.closed = true
              // A shell can leave background descendants with redirected stdio.
              // They still belong to this execution, even after its leader exits.
              if (process.platform !== "win32") kill(entry, "SIGKILL")
              clearTimeout(entry.timer)
              if (entry.killTimer) clearTimeout(entry.killTimer)
              if (entry.status === "running") entry.status = "exited"
              if (code !== null) entry.exitCode = code
              signal(entry)
              finish()
              const exited = [...entries].filter(([, value]) => value.closed)
              for (const [old] of exited.slice(0, Math.max(0, exited.length - EXITED_LIMIT))) entries.delete(old)
            })
            entries.set(id, entry)
            return id
          },
          catch: (cause) => new Error({ message: String(cause) }),
        })
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reservations--
          }),
        ),
      )
    })

  const followup: Interface["followup"] = (owner, input) =>
    Effect.gen(function* () {
      const entry = entries.get(input.processID)
      if (!entry || entry.owner !== owner)
        return yield* new Error({
          message:
            "Process is unavailable for this session (expired, interrupted by restart, or owned by another session)",
        })
      const cursor = input.cursor ?? 0
      const waitMs = input.waitMs ?? 1000
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor > entry.cursor ||
        !Number.isFinite(waitMs) ||
        waitMs < 0 ||
        waitMs > 30000
      )
        return yield* new Error({
          message: "Invalid process output cursor or wait interval",
        })
      if (input.action === "write") {
        if (entry.status !== "running" || !entry.process.stdin?.writable)
          return yield* new Error({ message: "Process stdin is closed" })
        if (input.data === undefined || Buffer.byteLength(input.data) > 65536)
          return yield* new Error({
            message: "Process input must be present and at most 64 KiB",
          })
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) =>
              entry.process.stdin!.write(input.data!, (error) => (error ? reject(error) : resolve())),
            ),
          catch: (cause) => new Error({ message: String(cause) }),
        })
      }
      if (input.action === "cancel") stop(entry, "cancelled")
      if (entry.status === "running" && entry.cursor === cursor && waitMs > 0)
        yield* Effect.callback<void>((resume) => {
          const changed = () => resume(Effect.void)
          const timer = setTimeout(changed, waitMs)
          entry.changed.add(changed)
          return Effect.sync(() => {
            clearTimeout(timer)
            entry.changed.delete(changed)
          })
        })
      const start = entry.cursor - entry.output.length
      return {
        processID: input.processID,
        status: entry.status,
        output: entry.output.slice(Math.max(0, cursor - start)),
        cursor: entry.cursor,
        omitted: Math.max(0, start - cursor),
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      }
    })
  return Service.of({ start, followup, disposeOwner })
})

export const layer = Layer.effect(Service, make)
