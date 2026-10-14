export * as SessionOperations from "./operations"

import { LLM, LLMClient, type LLMError } from "../../inference/api"
import { eq } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Exit, Layer } from "effect"
import { AgentRegistry } from "../../agents/registry"
import { Config } from "../../settings/config"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { EventTable } from "../../storage/tables/events"
import { Location } from "../../workspace/location"
import { PermissionPolicy } from "../../security/permissions/service"
import { SkillRegistry } from "../../agents/skills/registry"
import { ToolRegistry } from "../../tools/registry"
import { SkillTool } from "../../tools/skill"
import { SessionCompaction } from "../context/compaction"
import { SessionEvent } from "../../contracts/events/session"
import { SessionHistory } from "../messages/history"
import { SessionInput } from "../input/inbox"
import { SessionInputOrigin } from "../input/origin"
import { SessionMessage } from "../messages/service"
import { Prompt } from "../../contracts/session/prompt"
import { OperationConflictError, OperationFailedError, OperationUnavailableError } from "./errors"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionStore } from "../store"
import { SessionContextEpochTable } from "../../storage/tables/sessions"
import { SessionRunnerModel } from "../run/model"
import type { MessageDecodeError } from "../errors"
import type { ToolOutputStore } from "../../tools/output-store"
import type { SessionManager } from "../service"

export type ShellInput = {
  readonly id?: EventBus.ID
  readonly sessionID: SessionSchema.ID
  readonly command: string
  readonly resume?: boolean
}

export type SkillInput = {
  readonly id?: EventBus.ID
  readonly sessionID: SessionSchema.ID
  readonly skill: string
  readonly resume?: boolean
}

export type CompactInput = {
  readonly sessionID: SessionSchema.ID
  readonly prompt?: Prompt
}

export { OperationConflictError as ConflictError, OperationFailedError as FailedError, OperationUnavailableError as UnavailableError } from "./errors"

export type Error =
  | OperationUnavailableError
  | OperationFailedError
  | OperationConflictError
  | MessageDecodeError
  | ToolOutputStore.Error
  | PermissionPolicy.Error
  | SessionManager.NotFoundError
  | SessionRunnerModel.Error
  | SessionCompaction.FailedError
  | LLMError
  | SessionInputOrigin.UnavailableError

export interface Interface {
  /** Returns false for a previously completed command; unknown outcomes are never replayed. */
  readonly shell: (input: ShellInput) => Effect.Effect<boolean, Error>
  readonly skill: (input: SkillInput) => Effect.Effect<void, Error>
  readonly compact: (input: CompactInput) => Effect.Effect<void, Error>
}

/** Location-local operations. SessionExecution supplies the single execution owner. */
export class Service extends Context.Service<Service, Interface>()("@phins/SessionOperations") {}

const messageID = (id: EventBus.ID) => SessionMessage.ID.make(`msg_${id.slice(4)}`)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const events = yield* EventBus.Service
    const tools = yield* ToolRegistry.Service
    const agents = yield* AgentRegistry.Service
    const skills = yield* SkillRegistry.Service
    const permission = yield* PermissionPolicy.Service
    const db = (yield* Database.Service).db
    const models = yield* SessionRunnerModel.Service
    const llm = yield* LLMClient.Service
    const compaction = SessionCompaction.make({ events, llm, config: yield* (yield* Config.Service).entries() })
    const get = Effect.fn("SessionOperations.get")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      yield* SessionInputOrigin.requireLocal(db, sessionID)
      return session
    })

    return Service.of({
      shell: Effect.fn("SessionOperations.shell")(function* (input) {
        const session = yield* get(input.sessionID)
        const id = input.id ?? EventBus.ID.create()
        const recordedID = messageID(id)
        const recorded = yield* store.message(recordedID)
        if (recorded) {
          const shell = recorded.message
          if (recorded.sessionID !== input.sessionID || shell.type !== "shell" || shell.command !== input.command)
            return yield* new OperationConflictError({ id })
          if (!shell.time.completed)
            return yield* new OperationFailedError({
              operation: "shell",
              message: "Previous shell outcome is unknown; command was not replayed",
            })
          if (shell.error) return yield* new OperationFailedError({ operation: "shell", message: shell.error.message })
          return false
        }
        if (yield* SessionInput.find(db, recordedID)) return yield* new OperationConflictError({ id })
        const agent = yield* agents.select(session.agent)
        const materialized = yield* tools.materialize(
          agent.info?.permissions ?? [{ action: "*", resource: "*", effect: "deny" }],
        )
        if (!materialized.definitions.some((tool) => tool.name === "bash"))
          return yield* new OperationFailedError({
            operation: "shell",
            message: "Shell is not available for the selected agent",
          })
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* events
              .publish(
                SessionEvent.Shell.Started,
                {
                  sessionID: session.id,
                  messageID: recordedID,
                  callID: id,
                  command: input.command,
                  timestamp: yield* DateTime.now,
                },
                { id },
              )
              .pipe(
                Effect.catchDefect((defect) => {
                  if (!(defect instanceof EventBus.InvalidDurableEventError)) return Effect.die(defect)
                  return db
                    .select({ id: EventTable.id })
                    .from(EventTable)
                    .where(eq(EventTable.id, id))
                    .get()
                    .pipe(
                      Effect.orDie,
                      Effect.flatMap((stored) => (stored ? new OperationConflictError({ id }) : Effect.die(defect))),
                    )
                }),
              )
            const result = yield* restore(
              materialized
                .settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID: recordedID,
                  call: { type: "tool-call", id, name: "bash", input: { command: input.command } },
                })
                .pipe(
                  Effect.flatMap((settlement) =>
                    settlement.result.type === "error"
                      ? Effect.fail(new OperationFailedError({ operation: "shell", message: String(settlement.result.value) }))
                      : Effect.succeed(
                          settlement.result.type === "text"
                            ? String(settlement.result.value)
                            : JSON.stringify(settlement.result.value),
                        ),
                  ),
                ),
            ).pipe(Effect.exit)
            const error = Exit.isFailure(result)
              ? {
                  type: "unknown" as const,
                  message: Cause.hasInterruptsOnly(result.cause)
                    ? "Shell execution interrupted"
                    : String(Cause.squash(result.cause)),
                }
              : undefined
            const settled = yield* events
              .publish(SessionEvent.Shell.Ended, {
                sessionID: session.id,
                messageID: recordedID,
                callID: id,
                output: Exit.isSuccess(result) ? result.value : error!.message,
                ...(error ? { error } : {}),
                timestamp: yield* DateTime.now,
              })
              .pipe(Effect.exit)
            if (Exit.isFailure(result))
              return yield* Effect.failCause(
                Exit.isFailure(settled) ? Cause.combine(result.cause, settled.cause) : result.cause,
              )
            if (Exit.isFailure(settled)) return yield* Effect.failCause(settled.cause)
            return true
          }),
        )
      }),
      skill: Effect.fn("SessionOperations.skill")(function* (input) {
        const session = yield* get(input.sessionID)
        const id = input.id ?? EventBus.ID.create()
        const recordedID = messageID(id)
        const prefix = `Use skill ${JSON.stringify(input.skill)}.\n\n`
        const existing = yield* SessionInput.find(db, recordedID)
        if (existing) {
          if (
            existing.sessionID !== input.sessionID ||
            existing.delivery !== "steer" ||
            !existing.prompt.text.startsWith(prefix)
          )
            return yield* new OperationConflictError({ id })
          return
        }
        if (yield* store.message(recordedID)) return yield* new OperationConflictError({ id })
        const skill = (yield* skills.list()).find((item) => item.name === input.skill)
        if (!skill) return yield* new OperationFailedError({ operation: "skill", message: `Skill not found: ${input.skill}` })
        const agent = yield* agents.select(session.agent)
        yield* permission.assert({
          action: "skill",
          resources: [skill.name],
          save: [skill.name],
          sessionID: session.id,
          agent: agent.id,
        })
        const expected = {
          id: recordedID,
          sessionID: session.id,
          delivery: "steer",
          prompt: Prompt.make({ text: prefix + SkillTool.toModelOutput(skill, []) }),
        } as const
        const admitted = yield* SessionInput.admit(db, events, expected).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof SessionInput.InputLifecycleConflict ? new OperationConflictError({ id }) : Effect.die(defect),
          ),
        )
        if (!SessionInput.equivalent(admitted, expected)) return yield* new OperationConflictError({ id })
      }),
      compact: Effect.fn("SessionOperations.compact")(function* (input) {
        const session = yield* get(input.sessionID)
        const epoch = yield* db
          .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const entries = yield* SessionHistory.entriesForRunner(db, session.id, epoch?.baselineSeq ?? -1)
        if (entries.length > 0) {
          const model = yield* models.resolve(session)
          yield* compaction.compact({
            sessionID: session.id,
            entries,
            model,
            request: LLM.request({ model, messages: [], tools: [] }),
          })
        }
        if (input.prompt)
          yield* SessionInput.admit(db, events, {
            id: SessionMessage.ID.create(),
            sessionID: session.id,
            prompt: input.prompt,
            delivery: "steer",
          })
      }),
    })
  }),
)
