/** Local named commands execute once under the existing session coordinator. */
import { Cause, DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { AgentRegistry } from "../../agents/registry"
import { CommandRegistry } from "../../agents/commands"
import { Config } from "../../settings/config"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { Location } from "../../workspace/location"
import { CatalogModel } from "../../inference/catalog/model"
import { PermissionPolicy } from "../../security/permissions/service"
import { SessionCommandTable } from "../../storage/tables/commands"
import { SessionEvent } from "../../contracts/events/session"
import { SessionInput } from "../input/inbox"
import { SessionInputOrigin } from "../input/origin"
import { SessionMessage } from "../messages/service"
import { SessionOperations } from "./operations"
import { OperationFailedError } from "./errors"
import { Prompt } from "../../contracts/session/prompt"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionStore } from "../store"
import { SessionRunnerModel } from "../run/model"
import * as Subtasks from "../run/subtasks"
import { expand } from "./command-template"
import * as RunBudget from "../run/budget"

export interface Input {
  readonly id: SessionMessage.ID
  readonly sessionID: SessionSchema.ID
  readonly command: string
  readonly arguments?: string
  readonly files?: Prompt["files"]
  readonly resume?: boolean
  readonly agent?: AgentRegistry.ID
  readonly model?: CatalogModel.Ref
}

const fail = (message: string) =>
  new OperationFailedError({ operation: "command", message })
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const run = Effect.fn("SessionCommands.run")(function* (input: Input) {
  const store = yield* SessionStore.Service
  const { db } = yield* Database.Service
  const events = yield* EventBus.Service
  const location = yield* Location.Service
  const session = yield* store.get(input.sessionID)
  if (
    !session ||
    session.location.scope === "chat-v1" ||
    session.location.directory !== location.directory ||
    session.location.workspaceID !== location.workspaceID
  )
    return yield* fail("Command session does not belong to this project")
  yield* SessionInputOrigin.requireLocal(db, session.id)
  if (
    !input.command ||
    input.command.length > 128 ||
    (input.arguments?.length ?? 0) > 32000
  )
    return yield* fail("Command name or arguments exceed the supported limit")
  const command = yield* (yield* CommandRegistry.Service).get(input.command)
  if (!command || command.template.length > 64_000)
    return yield* fail("Command is unavailable or too large")
  const agents = yield* AgentRegistry.Service
  const parent = yield* agents.resolve(input.agent ?? session.agent)
  const target = yield* agents.resolve(
    command.agent ?? input.agent ?? session.agent,
  )
  if (!parent || !target || target.hidden)
    return yield* fail("Command agent is unavailable")
  const subtask =
    command.subtask === true ||
    (target.mode === "subagent" && command.subtask !== false)
  let text = expand(command.template, input.arguments ?? "")
  const matches = [...text.matchAll(/!`([^`]+)`/g)]
  if (matches.length > 8)
    return yield* fail(
      "At most eight shell substitutions are supported per command",
    )
  if (input.resume === false && (subtask || matches.length))
    return yield* fail(
      "Record-only mode cannot execute shell substitutions or subtasks",
    )
  if (subtask && input.files?.length)
    return yield* fail(
      "Subtask commands currently accept text only; no file was sent",
    )
  const model = command.model ?? target.model ?? input.model ?? session.model
  if (input.resume !== false)
    yield* (yield* SessionRunnerModel.Service).resolve({
      ...session,
      agent: target.id,
      model,
    })
  const signature = hash({ input, command, directory: location.directory })
  const previous = yield* db
    .select()
    .from(SessionCommandTable)
    .where(eq(SessionCommandTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (previous) {
    if (previous.session_id !== session.id || previous.signature !== signature)
      return yield* fail(
        "Command identity was already used with different input",
      )
    if (previous.status === "completed") return
    return yield* fail(
      "Previous command outcome is incomplete or uncertain; inspect history before starting a new command",
    )
  }
  if (
    (yield* SessionInput.find(db, input.id)) ||
    (yield* store.message(input.id))
  )
    return yield* fail("Command identity is already used by a session message")
  const operations = yield* SessionOperations.Service
  const permission = yield* PermissionPolicy.Service
  const subtasks = yield* Subtasks.Current
  const budget = (yield* RunBudget.Active) ?? RunBudget.createRunBudget(
    Config.latest(yield* (yield* Config.Service).entries(), "run_budget"),
  )
  if (subtask && (!subtasks || subtasks.parentID !== session.id))
    return yield* fail("Foreground subtask execution is unavailable")
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fresh = yield* db
        .insert(SessionCommandTable)
        .values({
          id: input.id,
          session_id: session.id,
          signature,
          status: "invoked",
          time_updated: Date.now(),
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!fresh)
        return yield* fail(
          "Command was already admitted; no execution was repeated",
        )
      const result = yield* restore(
        Effect.gen(function* () {
          if (subtask)
            yield* permission.assert({
              action: "task",
              resources: [target.id],
              save: [target.id],
              sessionID: session.id,
              agent: parent.id,
              source: { type: "tool", messageID: input.id, callID: input.id },
            })
          const agent = subtask ? parent.id : target.id
          if (agent !== session.agent)
            yield* events.publish(SessionEvent.AgentSwitched, {
              sessionID: session.id,
              messageID: SessionMessage.ID.make(
                `msg_command_agent_${hash(input.id)}`,
              ),
              agent,
              timestamp: yield* DateTime.now,
            })
          const parentModel = subtask ? (input.model ?? session.model) : model
          if (parentModel)
            yield* events.publish(SessionEvent.ModelSwitched, {
              sessionID: session.id,
              messageID: SessionMessage.ID.make(
                `msg_command_model_${hash(input.id)}`,
              ),
              model: parentModel,
              timestamp: yield* DateTime.now,
            })
          const outputs: string[] = []
          for (const [index, match] of matches.entries()) {
            const id = EventBus.ID.make(
              `evt_command_shell_${hash([input.id, index])}`,
            )
            yield* operations.shell({
              id,
              sessionID: session.id,
              command: match[1]!,
              resume: false,
            })
            const record = yield* store.message(
              SessionMessage.ID.make(`msg_${id.slice(4)}`),
            )
            if (
              record?.message.type !== "shell" ||
              !record.message.time.completed ||
              record.message.error
            )
              return yield* fail("Shell substitution did not complete")
            if (record.message.output.length > 32_000)
              return yield* fail(
                "Shell substitution output exceeds 32,000 UTF-16 code units; inspect the recorded shell result",
              )
            outputs.push(record.message.output)
          }
          let index = 0
          text = text.replace(/!`([^`]+)`/g, () => outputs[index++]!)
          if (text.length > 64_000)
            return yield* fail(
              "Expanded command exceeds 64,000 UTF-16 code units",
            )
          if (subtask) {
            const result = yield* subtasks!
              .run({
                parentID: session.id,
                key: input.id,
                prompt: text,
                description: command.description ?? command.name,
                agent: target.id,
                rules: parent.permissions,
                model,
              })
              .pipe(Effect.mapError((error) => fail(error.message)))
            text = `Command /${command.name}\n\n${text}\n\nSubtask ${result.sessionID} completed:\n${result.text}`
          }
          if (text.length > 64_000)
            return yield* fail(
              "Final command prompt exceeds 64,000 UTF-16 code units; inspect the subtask history",
            )
          yield* SessionInput.admit(db, events, {
            id: input.id,
            sessionID: session.id,
            prompt: Prompt.make({ text, files: input.files }),
            delivery: "queue",
          }).pipe(Effect.orDie)
        }).pipe(
          Effect.provideService(RunBudget.Active, budget),
          Effect.timeoutOrElse({
            duration: budget.remainingDurationMs(),
            orElse: () => Effect.die(new RunBudget.RunBudgetExceeded("time")),
          }),
        ),
      ).pipe(Effect.exit)
      yield* db
        .update(SessionCommandTable)
        .set({
          time_updated: Date.now(),
          status: Exit.isSuccess(result)
            ? "completed"
            : Cause.hasInterrupts(result.cause)
              ? "unknown"
              : "failed",
        })
        .where(eq(SessionCommandTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
    }),
  )
})
