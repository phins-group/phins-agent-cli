export * as SessionManager from "./service"
export * from "../contracts/session/info"

import { DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "../contracts/session/info"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectRegistry } from "../workspace/projects/service"
import { Workspace as WorkspaceIdentity } from "../contracts/workspace/workspace"
import { CatalogModel } from "../inference/catalog/model"
import { Location } from "../workspace/location"
import { SessionMessage } from "./messages/service"
import { Prompt } from "../contracts/session/prompt"
import { EventBus } from "../runtime/events/bus"
import { Database } from "../storage/database"
import { SessionProjector } from "./projector"
import { SessionTable } from "../storage/tables/sessions"
import { Session as SessionSchema } from "../contracts/session/info"
import { AbsolutePath, PositiveInt, RelativePath } from "../shared/schema"
import { AgentRegistry } from "../agents/registry"
import { SessionV1 } from "../contracts/session/compat"
import { InstallationVersion } from "../runtime/version"
import { Slug } from "../shared/slug"
import { ProjectTable } from "../storage/tables/projects"
import path from "path"
import { fromRow } from "./info"
import { SessionStore } from "./store"
import * as VerificationHistory from "./verification/history"
import type { VerificationReceipt } from "../contracts/execution/verification-receipt"
import { SessionExecution } from "./run/execution"
import type * as SessionCommands from "./actions/commands"
import { MessageDecodeError, RunStateDecodeError } from "./errors"
import { SessionRunState } from "./run/state"
import { SessionEvent } from "../contracts/events/session"
import { SessionInput } from "./input/inbox"
import { SessionInputOrigin } from "./input/origin"
import { Snapshot } from "../workspace/repository/snapshot"
import { SessionRevert } from "./actions/revert"
import { Revert } from "../contracts/session/revert"

export { OperationUnavailableError } from "./actions/errors"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceIdentity.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectRegistry.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([
  ListDirectoryInput,
  ListProjectInput,
  ListAllInput,
])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentRegistry.ID
  title?: string
  permissionMode?: "confirm-writes"
  model?: CatalogModel.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "Session.NotFoundError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export {
  ContextSnapshotDecodeError,
  MessageDecodeError,
  RunStateDecodeError,
} from "./errors"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()(
  "Session.PromptConflictError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

export class SnapshotLimitError extends Schema.TaggedErrorClass<SnapshotLimitError>()(
  "Session.SnapshotLimitError",
  {
    message: Schema.String,
  },
) {}

/** Persisted projections only; token deltas and process-local pending are not included. */
export type DurableSnapshot = {
  readonly session: SessionSchema.Info
  readonly messages: SessionMessage.Message[]
  readonly runState: SessionRunState.State | undefined
  readonly after: number
  readonly hasMore: boolean
}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | RunStateDecodeError
  | SnapshotLimitError
  | SessionExecution.OperationError
  | PromptConflictError

export interface Interface {
  readonly command: (input: SessionCommands.Input) => Effect.Effect<void, SessionExecution.OperationError>
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly snapshot: (input: {
    readonly sessionID: SessionSchema.ID
    readonly limit?: number
  }) => Effect.Effect<
    DurableSnapshot,
    | NotFoundError
    | MessageDecodeError
    | RunStateDecodeError
    | SnapshotLimitError
  >
  readonly verificationHistory: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    VerificationReceipt.HistoryItem[],
    NotFoundError | VerificationHistory.DecodeError
  >
  readonly runState: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    SessionRunState.State | undefined,
    NotFoundError | RunStateDecodeError
  >
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<
    SessionMessage.Message[],
    NotFoundError | MessageDecodeError
  >
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined, MessageDecodeError>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    SessionMessage.Message[],
    NotFoundError | MessageDecodeError
  >
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: CatalogModel.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    NotFoundError | PromptConflictError | SessionInputOrigin.UnavailableError
  >
  readonly shell: (input: {
    id?: EventBus.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SessionExecution.OperationError>
  readonly skill: (input: {
    id?: EventBus.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SessionExecution.OperationError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<void, NotFoundError | SessionExecution.OperationError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | SessionExecution.Error>
  /** Acknowledges a process-local scheduling request, not durable completion. */
  readonly scheduleResume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | SessionInputOrigin.UnavailableError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      Revert.State,
      | NotFoundError
      | MessageNotFoundError
      | Snapshot.Error
      | SessionInputOrigin.UnavailableError
    >
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<
      void,
      NotFoundError | Snapshot.Error | SessionInputOrigin.UnavailableError
    >
    readonly commit: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<
      void,
      NotFoundError | SessionInputOrigin.UnavailableError
    >
  }
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/Session",
) {}

export const layer = Layer.unwrap(
  Effect.promise(() => import("../runtime/services")).pipe(
    Effect.map(({ LocationServiceRegistry }) =>
      Layer.effect(
        Service,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const db = database.db
          const events = yield* EventBus.Service
          const projects = yield* ProjectRegistry.Service
          const execution = yield* SessionExecution.Service
          const store = yield* SessionStore.Service
          const locations = yield* LocationServiceRegistry
          const isDurableSessionEvent = Schema.is(SessionEvent.Durable)

          const result = Service.of({
            verificationHistory: Effect.fn("V2Session.verificationHistory")(
              function* (sessionID) {
                const recorded = yield* store.get(sessionID)
                if (!recorded) return yield* new NotFoundError({ sessionID })
                return yield* VerificationHistory.list(db, sessionID)
              },
            ),
            create: Effect.fn("V2Session.create")(function* (input) {
              const sessionID = input.id ?? SessionSchema.ID.create()
              if (
                sessionID.startsWith("ses_webchat_") &&
                input.location.scope !== "chat-v1"
              )
                return yield* Effect.die(
                  "General chat cannot be created as a project session",
                )
              const recorded = yield* store.get(sessionID)
              if (recorded) return recorded
              const project =
                input.location.scope === "chat-v1"
                  ? (yield* Effect.promise(
                      () => import("./run/chat-scope"),
                    )).project(input.location.directory)
                  : yield* projects.resolve(input.location.directory)
              yield* db
                .insert(ProjectTable)
                .values({
                  id: project.id,
                  worktree: project.directory,
                  vcs: project.vcs?.type,
                  sandboxes: [],
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              const now = Date.now()
              const info = SessionV1.SessionInfo.make({
                id: sessionID,
                slug: Slug.create(),
                version: InstallationVersion,
                projectID: project.id,
                directory: input.location.directory,
                path: path
                  .relative(project.directory, input.location.directory)
                  .replaceAll("\\", "/"),
                workspaceID: input.location.workspaceID
                  ? WorkspaceIdentity.ID.make(input.location.workspaceID)
                  : undefined,
                title:
                  input.title ?? `New session - ${new Date(now).toISOString()}`,
                metadata:
                  input.permissionMode || input.location.scope
                    ? {
                        ...(input.permissionMode
                          ? { nodePermissionMode: input.permissionMode }
                          : {}),
                        ...(input.location.scope
                          ? { runtimeScope: input.location.scope }
                          : {}),
                      }
                    : undefined,
                agent: input.agent,
                model: input.model
                  ? {
                      id: CatalogModel.ID.make(input.model.id),
                      providerID: input.model.providerID,
                      variant: input.model.variant,
                    }
                  : undefined,
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                time: { created: now, updated: now },
              })
              const projected = yield* events
                .publish(
                  SessionV1.Event.Created,
                  { sessionID, info },
                  { location: input.location },
                )
                .pipe(
                  Effect.as({ type: "created" } as const),
                  Effect.catchDefect((defect) => {
                    if (
                      !(
                        defect instanceof
                        SessionProjector.SessionAlreadyProjected
                      )
                    ) {
                      return Effect.die(defect)
                    }
                    // Concurrent creation lost the projection race. The existing Session identity wins.
                    return store
                      .get(sessionID)
                      .pipe(
                        Effect.flatMap((session) =>
                          session
                            ? Effect.succeed({
                                type: "existing",
                                session,
                              } as const)
                            : Effect.die(defect),
                        ),
                      )
                  }),
                )
              if (projected.type === "existing") return projected.session
              // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
              return yield* result.get(sessionID).pipe(Effect.orDie)
            }),
            get: Effect.fn("V2Session.get")(function* (sessionID) {
              const session = yield* store.get(sessionID)
              if (!session) return yield* new NotFoundError({ sessionID })
              return session
            }),
            snapshot: Effect.fn("V2Session.snapshot")(function* (input) {
              const limit = input.limit ?? 20
              if (!Number.isInteger(limit) || limit < 1 || limit > 200)
                return yield* new SnapshotLimitError({
                  message: "Snapshot limit must be an integer from 1 to 200",
                })
              // Projections and the event head must describe the same committed
              // state. Separate reads can skip an intervening event at attach.
              return yield* db
                .transaction(() =>
                  Effect.gen(function* () {
                    const info = yield* result.get(input.sessionID)
                    const after = yield* EventBus.latestSequence(
                      db,
                      input.sessionID,
                    )
                    const messages = yield* store.messages({
                      sessionID: input.sessionID,
                      order: "desc",
                      limit: limit + 1,
                    })
                    const runState = yield* store.runState(input.sessionID)
                    return {
                      session: info,
                      messages: messages.slice(0, limit),
                      runState,
                      after,
                      hasMore: messages.length > limit,
                    }
                  }),
                )
                .pipe(Effect.catchTag("SqlError", Effect.die))
            }),
            list: Effect.fn("V2Session.list")(function* (input = {}) {
              const direction = input.anchor?.direction ?? "next"
              const requestedOrder = input.order ?? "desc"
              const order =
                direction === "previous"
                  ? requestedOrder === "asc"
                    ? "desc"
                    : "asc"
                  : requestedOrder
              const sortColumn = SessionTable.time_created
              const conditions: SQL[] = []
              if ("directory" in input)
                conditions.push(eq(SessionTable.directory, input.directory))
              if (input.workspaceID)
                conditions.push(
                  eq(SessionTable.workspace_id, input.workspaceID),
                )
              if ("project" in input)
                conditions.push(eq(SessionTable.project_id, input.project))
              if (input.search)
                conditions.push(like(SessionTable.title, `%${input.search}%`))
              if (input.anchor) {
                conditions.push(
                  order === "asc"
                    ? or(
                        gt(sortColumn, input.anchor.time),
                        and(
                          eq(sortColumn, input.anchor.time),
                          gt(SessionTable.id, input.anchor.id),
                        ),
                      )!
                    : or(
                        lt(sortColumn, input.anchor.time),
                        and(
                          eq(sortColumn, input.anchor.time),
                          lt(SessionTable.id, input.anchor.id),
                        ),
                      )!,
                )
              }
              const query = db
                .select()
                .from(SessionTable)
                .where(conditions.length > 0 ? and(...conditions) : undefined)
                .orderBy(
                  order === "asc" ? asc(sortColumn) : desc(sortColumn),
                  order === "asc"
                    ? asc(SessionTable.id)
                    : desc(SessionTable.id),
                )
              const rows = yield* (
                input.limit === undefined
                  ? query.all()
                  : query.limit(input.limit).all()
              ).pipe(Effect.orDie)
              return (direction === "previous" ? rows.toReversed() : rows).map(
                (row) => fromRow(row),
              )
            }),
            messages: Effect.fn("V2Session.messages")(function* (input) {
              yield* result.get(input.sessionID)
              return yield* store.messages(input)
            }),
            runState: Effect.fn("V2Session.runState")(function* (sessionID) {
              yield* result.get(sessionID)
              return yield* store.runState(sessionID)
            }),
            message: Effect.fn("V2Session.message")(function* (input) {
              const stored = yield* store.message(input.messageID)
              return stored?.sessionID === input.sessionID
                ? stored.message
                : undefined
            }),
            context: Effect.fn("V2Session.context")(function* (sessionID) {
              yield* result.get(sessionID)
              return yield* store.context(sessionID)
            }),
            events: (input) =>
              Stream.unwrap(
                result
                  .get(input.sessionID)
                  .pipe(
                    Effect.as(
                      events.durable({
                        aggregateID: input.sessionID,
                        after: input.after,
                      }),
                    ),
                  ),
              ).pipe(
                Stream.filter((event): event is SessionEvent.DurableEvent =>
                  isDurableSessionEvent(event),
                ),
              ),
            prompt: Effect.fn("V2Session.prompt")((input) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* result.get(input.sessionID)
                  const messageID = input.id ?? SessionMessage.ID.create()
                  const delivery = input.delivery ?? "steer"
                  const expected = {
                    sessionID: input.sessionID,
                    messageID,
                    prompt: input.prompt,
                    delivery,
                  }
                  const admitted = yield* SessionInput.admit(db, events, {
                    id: messageID,
                    sessionID: input.sessionID,
                    prompt: input.prompt,
                    delivery,
                  }).pipe(
                    Effect.catchDefect((defect) =>
                      defect instanceof SessionInput.InputLifecycleConflict
                        ? new PromptConflictError({
                            sessionID: input.sessionID,
                            messageID,
                          })
                        : Effect.die(defect),
                    ),
                  )
                  if (!SessionInput.equivalent(admitted, expected))
                    return yield* new PromptConflictError({
                      sessionID: input.sessionID,
                      messageID,
                    })
                  if (input.resume !== false)
                    yield* execution.wake(admitted.sessionID)
                  return admitted
                }),
              ),
            ),
            shell: Effect.fn("V2Session.shell")(function* (input) {
              yield* result.get(input.sessionID)
              yield* SessionInputOrigin.requireLocal(db, input.sessionID)
              yield* execution.shell(input)
            }),
            command: Effect.fn("V2Session.command")(function* (input) {
              yield* result.get(input.sessionID)
              yield* SessionInputOrigin.requireLocal(db, input.sessionID)
              yield* execution.command(input)
            }),
            skill: Effect.fn("V2Session.skill")(function* (input) {
              yield* result.get(input.sessionID)
              yield* SessionInputOrigin.requireLocal(db, input.sessionID)
              yield* execution.skill(input)
            }),
            switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
              yield* result.get(input.sessionID)
              yield* events.publish(SessionEvent.AgentSwitched, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                agent: input.agent,
              })
            }),
            switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
              yield* result.get(input.sessionID)
              yield* events.publish(SessionEvent.ModelSwitched, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                model: input.model,
              })
            }),
            compact: Effect.fn("V2Session.compact")(function* (input) {
              yield* result.get(input.sessionID)
              yield* SessionInputOrigin.requireLocal(db, input.sessionID)
              yield* execution.compact(input)
            }),
            wait: Effect.fn("V2Session.wait")(function* (sessionID) {
              yield* result.get(sessionID)
              yield* execution.wait(sessionID)
            }),
            resume: Effect.fn("V2Session.resume")(function* (sessionID) {
              yield* result.get(sessionID)
              yield* SessionInputOrigin.requireLocalRun(db, sessionID)
              yield* execution.resume(sessionID)
            }),
            scheduleResume: Effect.fn("V2Session.scheduleResume")(
              function* (sessionID) {
                yield* result.get(sessionID)
                yield* SessionInputOrigin.requireLocalRun(db, sessionID)
                yield* execution.scheduleResume(sessionID)
              },
            ),
            interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
              Effect.uninterruptible(execution.interrupt(sessionID)),
            ),
            revert: {
              stage: Effect.fn("V2Session.revert.stage")(function* (input) {
                const session = yield* result.get(input.sessionID)
                yield* SessionInputOrigin.requireLocal(db, input.sessionID)
                return yield* SessionRevert.stage({
                  session,
                  messageID: input.messageID,
                  files: input.files,
                }).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.provideService(EventBus.Service, events),
                  Effect.provide(locations.get(session.location)),
                )
              }),
              clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
                const session = yield* result.get(sessionID)
                yield* SessionInputOrigin.requireLocal(db, sessionID)
                yield* SessionRevert.clear(session).pipe(
                  Effect.provideService(EventBus.Service, events),
                  Effect.provide(locations.get(session.location)),
                )
              }),
              commit: Effect.fn("V2Session.revert.commit")(
                function* (sessionID) {
                  const session = yield* result.get(sessionID)
                  yield* SessionInputOrigin.requireLocal(db, sessionID)
                  yield* SessionRevert.commit(session).pipe(
                    Effect.provideService(EventBus.Service, events),
                  )
                },
              ),
            },
          })

          return result
        }),
      ),
    ),
  ),
)

export const defaultLayer = layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.promise(() => import("../runtime/services")).pipe(
        Effect.map((m) => m.LocationServiceRegistry.layer),
      ),
    ),
  ),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventBus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectRegistry.defaultLayer),
  Layer.orDie,
)
