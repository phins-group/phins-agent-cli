/** Foreground delegation stays inside the local parent's execution owner. */
import { Context, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { AgentRegistry } from "../../agents/registry"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { PermissionOrigin } from "../../security/permissions/origin"
import * as Delegation from "../../security/permissions/delegation"
import { SessionV1 } from "../../contracts/session/compat"
import { SessionInput } from "../input/inbox"
import { SessionInputOrigin } from "../input/origin"
import { SessionMessage } from "../messages/service"
import { Prompt } from "../../contracts/session/prompt"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionStore } from "../store"
import { SessionTable } from "../../storage/tables/sessions"
import { legacyInfo } from "../info"
import { CatalogModel } from "../../inference/catalog/model"
import type { Permission } from "../../contracts/security/permission"

export class Failed extends Schema.TaggedErrorClass<Failed>()(
  "Subtask.Failed",
  {
    message: Schema.String,
  },
) {}

export interface Input {
  readonly parentID: SessionSchema.ID
  readonly key: string
  readonly prompt: string
  readonly description: string
  readonly agent: AgentRegistry.ID
  readonly rules: ReadonlyArray<Permission.Rule>
  readonly model?: CatalogModel.Ref
}

export interface Output {
  readonly sessionID: SessionSchema.ID
  readonly text: string
}

export interface Interface {
  readonly parentID: SessionSchema.ID
  readonly run: (input: Input) => Effect.Effect<Output, Failed>
}

/** Installed only by the current local coordinator, never from request input. */
export const Current = Context.Reference<Interface | undefined>(
  "@phins/ForegroundSubtask",
  { defaultValue: () => undefined },
)

export function make(options: {
  db: Database.Interface["db"]
  events: EventBus.Interface
  store: SessionStore.Interface
  run: (id: SessionSchema.ID) => Effect.Effect<void, unknown>
}) {
  const { db, events, store } = options
  return (parentID: SessionSchema.ID): Interface => {
    let count = 0
    return {
      parentID,
      run: Effect.fn("Subtask.run")(function* (input) {
        const parent = yield* store.get(parentID)
        if (
          !parent ||
          input.parentID !== parentID ||
          parent.parentID ||
          parent.location.scope === "chat-v1" ||
          (yield* PermissionOrigin.capture).length ||
          (yield* Delegation.Current)
        )
          return yield* new Failed({
            message: "Only a local root session can delegate a foreground task",
          })
        yield* SessionInputOrigin.requireLocal(db, parentID).pipe(
          Effect.mapError(
            () =>
              new Failed({
                message: "Remote sessions cannot delegate local work",
              }),
          ),
        )
        if (++count > 4)
          return yield* new Failed({
            message: "At most four foreground subtasks are allowed per run",
          })
        const id = SessionSchema.ID.make(
          `ses_task_${createHash("sha256")
            .update(JSON.stringify([parentID, input.key]))
            .digest("hex")}`,
        )
        if (yield* store.get(id))
          return yield* new Failed({
            message:
              "This subtask was already admitted; inspect its history instead of replaying it",
          })
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, parentID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new Failed({
            message: "Parent session no longer exists",
          })
        const now = Date.now()
        const source = legacyInfo(row)
        const info = SessionV1.SessionInfo.make({
          ...source,
          id,
          parentID,
          slug: id,
          title: input.description,
          agent: input.agent,
          model: input.model ?? source.model,
          share: undefined,
          revert: undefined,
          summary: undefined,
          metadata: parent.permissionMode
            ? { nodePermissionMode: parent.permissionMode }
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
        yield* events.publish(
          SessionV1.Event.Created,
          { sessionID: id, info },
          { location: parent.location },
        )
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.make(
            `msg_task_${createHash("sha256").update(id).digest("hex")}`,
          ),
          sessionID: id,
          prompt: Prompt.make({ text: input.prompt }),
          delivery: "queue",
        }).pipe(Effect.orDie)
        const run = Effect.gen(function* () {
          // Parent permissions are a ceiling; selecting a more powerful agent
          // cannot bypass deny or turn an ask into automatic permission.
          yield* Delegation.restrict(
            {
              sessionID: id,
              rules: input.rules,
              valid: SessionInputOrigin.requireLocal(db, parentID).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              ),
            },
            options.run(id),
          ).pipe(
            Effect.mapError(
              () =>
                new Failed({
                  message:
                    "Subtask did not complete; inspect its session history",
                }),
            ),
          )
        })
        yield* run
        const messages = yield* store
          .messages({ sessionID: id, order: "desc", limit: 100 })
          .pipe(Effect.orDie)
        const last = messages.find((message) => message.type === "assistant")
        if (!last || last.type !== "assistant" || last.error)
          return yield* new Failed({
            message:
              "Subtask has no successful response; inspect its session history",
          })
        const text = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        return { sessionID: id, text: text.slice(0, 32_000) }
      }),
    }
  }
}
