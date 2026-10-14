/** No legacy runtime: read the same native store, catalog and location. */
import { Config } from "../../../settings/config"
import { Catalog } from "../../../inference/catalog/registry"
import { AppPaths } from "../../../runtime/paths"
import { Location } from "../../../workspace/location"
import { Database } from "../../../storage/database"
import { ProjectDirectories } from "../../../workspace/projects/directories"
import { McpLocal } from "../../../extensions/mcp/local"
import { Formatter } from "../../../workspace/files/formatter"
import { Snapshot } from "../../../workspace/repository/snapshot"
import { SessionManager } from "../../../sessions/service"
import { SessionInputTable, SessionTable } from "../../../storage/tables/sessions"
import { SessionTodo } from "../../../sessions/tasks"
import { SessionAdministration } from "../../../sessions/actions/administration"
import { legacyInfo } from "../../../sessions/info"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { and, asc, eq, isNull } from "drizzle-orm"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ConflictError, InvalidRequestError, ServiceUnavailableError, SessionNotFoundError, UnknownError } from "../../api/errors"
import { Api } from "../api"

const execute = promisify(execFile)

export const TuiHandler = HttpApiBuilder.group(Api, "server.tui", (handlers) =>
  Effect.gen(function* () {
    const global = yield* AppPaths.Service
    const directories = yield* ProjectDirectories.Service
    const session = yield* SessionManager.Service
    const administration = yield* SessionAdministration.Service
    const { db } = yield* Database.Service
    return handlers
      .handle("tui.context", Effect.fn(function* () {
        const location = yield* Location.Service
        const config = yield* Config.Service
        const catalog = yield* Catalog.Service
        const mcp = yield* McpLocal.Service
        const formatter = yield* Formatter.Service
        const entries = yield* config.entries()
        const configuredModel = Config.latest(entries, "model")
        const agent = Config.latest(entries, "default_agent")
        const username = Config.latest(entries, "username")
        const model = yield* catalog.model.default()
        const branch = location.vcs?.type === "git"
          ? yield* Effect.tryPromise({
              try: (signal) => execute("git", ["branch", "--show-current"], {
                cwd: location.directory, signal, timeout: 2000,
                maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
              }),
              catch: () => new Error("Branch is unavailable"),
            }).pipe(Effect.map((value) => value.stdout.trim()), Effect.catch(() => Effect.succeed(undefined)))
          : undefined
        return {
          config: {
            ...(configuredModel ? { model: configuredModel } : {}),
            ...(agent ? { default_agent: agent } : {}),
            ...(username ? { username } : {}),
          },
          ...(model ? { defaultModel: `${model.providerID}/${model.id}` } : {}),
          path: { home: global.home, state: global.state, config: global.config,
            directory: location.directory, worktree: location.project.directory },
          project: { id: location.project.id, worktree: location.project.directory },
          directories: yield* directories.list(location.project.id),
          ...(branch ? { vcs: { branch } } : {}),
          mcp: yield* mcp.status(),
          formatter: yield* formatter.status(),
        }
      }))
      .handle("tui.status", Effect.fn(function* () {
        const location = yield* Location.Service
        const values = yield* session.list({ directory: location.directory })
        const statuses = yield* Effect.forEach(values, (value) => session.runState(value.id).pipe(
          Effect.map((run) => [value.id, run?.status === "busy" ? { type: "busy" as const }
            : run?.status === "retrying" ? { type: "retry" as const, attempt: run.attempt,
              message: run.error.message, next: DateTime.toEpochMillis(run.nextRetryAt) }
              : { type: "idle" as const }] as const),
          Effect.mapError(() => new UnknownError({ message: "Unable to read session status" })),
        ))
        return Object.fromEntries(statuses)
      }))
      .handle("tui.mcp", Effect.fn(function* (ctx) {
        const mcp = yield* McpLocal.Service
        yield* mcp.setEnabled(ctx.params.name, ctx.payload.enabled).pipe(
          Effect.mapError((error) => new InvalidRequestError({ message: error.message })),
        )
        return true
      }))
      .handle("tui.session", Effect.fn(function* (ctx) {
        const id = ctx.params.sessionID
        const row = yield* db.select().from(SessionTable)
          .where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return yield* new SessionNotFoundError({ sessionID: id, message: "Session not found" })
        const info = legacyInfo(row)
        const todo = yield* SessionTodo.Service
        const snapshot = yield* Snapshot.Service
        const messages = yield* session.messages({ sessionID: id, order: "asc" })
          .pipe(Effect.mapError(() => new UnknownError({ message: "Unable to read session history" })))
        const assistants = messages.filter((message) => message.type === "assistant")
        const first = assistants.find((message) => message.snapshot?.start)?.snapshot?.start
        const last = assistants.findLast((message) => message.snapshot?.end)?.snapshot?.end
        const diff = first && last
          ? yield* snapshot.diff({ from: Snapshot.ID.make(first), to: Snapshot.ID.make(last) })
              .pipe(Effect.mapError(() => new UnknownError({ message: "Unable to read session changes" })))
          : []
        const pending = yield* db.select({ id: SessionInputTable.id, time: SessionInputTable.time_created, prompt: SessionInputTable.prompt })
          .from(SessionInputTable).where(and(eq(SessionInputTable.session_id, id), isNull(SessionInputTable.promoted_seq)))
          .orderBy(asc(SessionInputTable.admitted_seq)).limit(200).all().pipe(Effect.orDie)
        return { info, todo: yield* todo.get(id), pending, messageIDs: messages.map((message) => message.id),
          diff: diff.map(({ path, ...entry }) => ({ ...entry, file: path })) }
      }))
      .handle("tui.session.update", Effect.fn(function* (ctx) {
        return yield* administration.update({ sessionID: ctx.params.sessionID,
          title: ctx.payload.title, archived: ctx.payload.time?.archived }).pipe(
          Effect.catchTag("RunnerBusy", () => new ConflictError({ message: "Session is busy; wait before changing it" })),
          Effect.catchTag("SessionInputOrigin.UnavailableError", () => new UnknownError({ message: "Unable to change this session" })),
          Effect.catchTag("Session.AdministrationError", (error) => new InvalidRequestError({ message: error.message })),
        )
      }))
      .handle("tui.session.remove", Effect.fn(function* (ctx) {
        yield* administration.remove(ctx.params.sessionID).pipe(
          Effect.catchTag("RunnerBusy", () => new ConflictError({ message: "Session is busy; stop it before deleting it" })),
          Effect.catchTag("SessionInputOrigin.UnavailableError", () => new UnknownError({ message: "Unable to delete this session" })),
          Effect.catchTag("Session.AdministrationError", (error) => new InvalidRequestError({ message: error.message })),
        )
        return true
      }))
      .handle("tui.session.fork", Effect.fn(function* (ctx) {
        return yield* administration.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID }).pipe(
          Effect.catchTag("RunnerBusy", () => new ConflictError({ message: "Session is busy; wait before forking it" })),
          Effect.catchTag("SessionInputOrigin.UnavailableError", () => new ServiceUnavailableError({ service: "session.origin", message: "Remote-origin sessions cannot be forked with local execution rights" })),
          Effect.catchTag("Session.AdministrationError", (error) => new InvalidRequestError({ message: error.message })),
        )
      }))
  }),
)
