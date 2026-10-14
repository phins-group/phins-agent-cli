import { Context, DateTime, Effect, type Exit, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { InstallationVersion } from "../../runtime/version"
import { AbsolutePath } from "../../shared/schema"
import { Slug } from "../../shared/slug"
import { SessionV1 } from "../../contracts/session/compat"
import { SessionInputOrigin } from "../input/origin"
import { legacyInfo } from "../info"
import { SessionEvent } from "../../contracts/events/session"
import { SessionMessage } from "../messages/service"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionTable } from "../../storage/tables/sessions"
import { SessionStore } from "../store"
import { SessionRunLifecycle } from "../run/lifecycle"

export class Error extends Schema.TaggedErrorClass<Error>()(
  "Session.AdministrationError", { message: Schema.String },
) {}

type Failure = Error | SessionRunLifecycle.RunBusy | SessionInputOrigin.UnavailableError
export interface Interface {
  readonly update: (input: {
    sessionID: SessionSchema.ID; title?: string; archived?: number | null
  }) => Effect.Effect<SessionV1.SessionInfo, Failure>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, Failure>
  readonly fork: (input: {
    sessionID: SessionSchema.ID; messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionV1.SessionInfo, Failure>
}
export class Service extends Context.Service<Service, Interface>()("@phins/SessionAdministration") {}

/** Uses the execution owner's idle lock, never a second coordinator. */
export function make(input: {
  db: Database.Interface["db"]
  events: EventBus.Interface
  store: SessionStore.Interface
  exclusive: (id: SessionSchema.ID, work: Effect.Effect<void>) => Effect.Effect<void, SessionRunLifecycle.RunBusy>
}): Interface {
  const { db, events, store } = input
  const read = Effect.fnUntraced(function* (id: SessionSchema.ID) {
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
    if (!row) return yield* new Error({ message: "Session not found" })
    return legacyInfo(row)
  })
  const idle = <A, E>(id: SessionSchema.ID, work: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      let result: Exit.Exit<A, E> | undefined
      yield* input.exclusive(id, Effect.gen(function* () {
        result = yield* Effect.exit(work)
      }))
      if (!result) return yield* Effect.die("Session operation did not finish")
      return yield* result
    })
  return {
    update: (value) => idle(value.sessionID, Effect.gen(function* () {
      const info = yield* read(value.sessionID)
      const title = value.title?.trim()
      if (title !== undefined && !title) return yield* new Error({ message: "Session title cannot be empty" })
      const updated = { ...info, title: title ?? info.title,
        time: { ...info.time, updated: Date.now(),
          archived: value.archived === null ? undefined : value.archived ?? info.time.archived } }
      yield* events.publish(SessionV1.Event.Updated, { sessionID: info.id, info: updated },
        { location: { directory: AbsolutePath.make(info.directory), workspaceID: info.workspaceID } })
      return updated
    })),
    remove: (id) => idle(id, Effect.gen(function* () {
      const info = yield* read(id)
      yield* events.publish(SessionV1.Event.Deleted, { sessionID: id, info },
        { location: { directory: AbsolutePath.make(info.directory), workspaceID: info.workspaceID } })
    })),
    fork: (value) => idle(value.sessionID, Effect.gen(function* () {
      const source = yield* read(value.sessionID)
      yield* SessionInputOrigin.requireLocal(db, value.sessionID)
      const all = yield* store.messages({ sessionID: value.sessionID, order: "asc" })
        .pipe(Effect.mapError(() => new Error({ message: "Unable to read session history" })))
      const boundary = value.messageID ? all.findIndex((message) => message.id === value.messageID) : all.length
      if (boundary < 0) return yield* new Error({ message: "Message does not belong to this session" })
      const messages = all.slice(0, boundary)
      // Creation and history must commit atomically; never truncate a fork.
      if (messages.length > 255) return yield* new Error({ message: "This session is too long to fork atomically; choose an earlier message" })
      const id = SessionSchema.ID.create()
      const timestamp = yield* DateTime.now
      const now = DateTime.toEpochMillis(timestamp)
      const info = SessionV1.SessionInfo.make({
        ...source, id, slug: Slug.create(), version: InstallationVersion,
        title: `${source.title} (fork)`, parentID: undefined, share: undefined,
        summary: undefined, revert: undefined, metadata: source.metadata,
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      })
      const location = { directory: AbsolutePath.make(source.directory), workspaceID: source.workspaceID }
      yield* events.publishBatch([
        { definition: SessionV1.Event.Created, data: { sessionID: id, info }, options: { location } },
        ...messages.map((message) => ({
          definition: SessionEvent.MessageCopied,
          data: { sessionID: id, sourceSessionID: value.sessionID, timestamp,
            message: { ...message, id: SessionMessage.ID.create(),
              ...(message.type === "synthetic" ? { sessionID: id } : {}) } },
          options: { location },
        })),
      ])
      return info
    })),
  }
}

export * as SessionAdministration from "./administration"
