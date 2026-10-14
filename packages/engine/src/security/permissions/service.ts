export * as PermissionPolicy from "./service"

import {
  Context,
  Deferred,
  Effect as EffectRuntime,
  Layer,
  Schema,
} from "effect"
import { Permission } from "../../contracts/security/permission"
import { EventBus } from "../../runtime/events/bus"
import { Location } from "../../workspace/location"
import { AgentRegistry } from "../../agents/registry"
import { SessionManager } from "../../sessions/service"
import { SessionStore } from "../../sessions/store"
import { Wildcard } from "../../shared/wildcard"
import { PermissionSaved } from "./saved"
import { PermissionOrigin } from "./origin"
import * as Delegation from "./delegation"

export { Effect, Rule, Ruleset } from "../../contracts/security/permission"
const missingAgentPermissions: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "deny" },
]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentRegistry.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()(
  "PermissionV2.RejectedError",
  {},
) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()(
  "PermissionV2.CorrectedError",
  {
    feedback: Schema.String,
  },
) {}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()(
  "PermissionV2.DeniedError",
  {
    rules: Permission.Ruleset,
  },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "PermissionV2.NotFoundError",
  {
    requestID: ID,
  },
) {}

export class ReplyForbiddenError extends Schema.TaggedErrorClass<ReplyForbiddenError>()(
  "PermissionV2.ReplyForbiddenError",
  {
    requestID: ID,
    message: Schema.String,
  },
) {}

export type Error = DeniedError | RejectedError | CorrectedError

export function evaluate(
  action: string,
  resource: string,
  ...rulesets: Permission.Ruleset[]
): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          Wildcard.match(action, rule.action) &&
          Wildcard.match(resource, rule.resource),
      ) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (
    input: AssertInput,
  ) => EffectRuntime.Effect<AskResult, SessionManager.NotFoundError>
  readonly assert: (
    input: AssertInput,
  ) => EffectRuntime.Effect<void, Error | SessionManager.NotFoundError>
  readonly reply: (
    input: ReplyInput,
  ) => EffectRuntime.Effect<void, NotFoundError | ReplyForbiddenError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (
    sessionID: SessionManager.ID,
  ) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()(
  "@phins/v2/Permission",
) {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentRegistry.ID
  readonly deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
  readonly origin: ReadonlyArray<PermissionOrigin.Constraint>
  readonly delegation?: Delegation.Ceiling
  replying: boolean
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventBus.Service
    const location = yield* Location.Service
    const agents = yield* AgentRegistry.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(
        pending.values(),
        (item) => Deferred.fail(item.deferred, new RejectedError()),
        {
          discard: true,
        },
      ).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionManager.ID,
      agentID?: AgentRegistry.ID,
      origin: ReadonlyArray<PermissionOrigin.Constraint> = [],
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionManager.NotFoundError({ sessionID })
      if (
        origin.length &&
        (session.location.directory !== location.directory ||
          session.location.workspaceID !== location.workspaceID)
      )
        return missingAgentPermissions
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some(
        (resource) => evaluate(input.action, resource, rules).effect === "deny",
      )
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const originDenied = (input: AssertInput): Permission.Ruleset => [
      { action: input.action, resource: "*", effect: "deny" },
    ]

    const evaluateInput = EffectRuntime.fnUntraced(function* (
      input: AssertInput,
      origin: ReadonlyArray<PermissionOrigin.Constraint>,
    ) {
      const rules = yield* configured(input.sessionID, input.agent, origin)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map(
        (resource) => evaluate(input.action, resource, all).effect,
      )
      let effect: Permission.Effect = effects.includes("deny")
        ? "deny"
        : effects.includes("ask")
          ? "ask"
          : "allow"
      const ceiling = yield* Delegation.Current
      if (ceiling) {
        if (ceiling.sessionID !== input.sessionID || !(yield* ceiling.valid))
          return { effect: "deny" as const, rules: originDenied(input) }
        const inherited = input.resources.map((resource) =>
          evaluate(input.action, resource, [...ceiling.rules]).effect)
        if (inherited.includes("deny"))
          return { effect: "deny" as const, rules: [...ceiling.rules] }
        if (inherited.includes("ask") && effect === "allow") effect = "ask"
      }
      const session = yield* sessions.get(input.sessionID)
      // A Desktop-created session keeps its confirmation boundary when CLI
      // attaches to it. Project remembered grants cannot silently widen it.
      if (
        effect === "allow" &&
        session?.permissionMode === "confirm-writes" &&
        !["read", "glob", "grep", "list"].includes(input.action)
      )
        effect = "ask"
      if (!(yield* PermissionOrigin.permits(input, origin)))
        return { effect: "deny" as const, rules: originDenied(input) }
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (
      request: Request,
      agent: AgentRegistry.ID | undefined,
      origin: ReadonlyArray<PermissionOrigin.Constraint>,
    ) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<
            void,
            RejectedError | CorrectedError
          >()
          const delegation = yield* Delegation.Current
          const item = { request, agent, deferred, origin, delegation, replying: false }
          if (pending.has(request.id))
            return yield* EffectRuntime.die(
              `Duplicate pending permission ID: ${request.id}`,
            )
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(
              EffectRuntime.onError(() =>
                EffectRuntime.sync(() => pending.delete(request.id)),
              ),
            )
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (
      input: AssertInput,
    ) {
      const origin = yield* PermissionOrigin.capture
      const result = yield* evaluateInput(input, origin)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent, origin)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")(
      (input: AssertInput) =>
        EffectRuntime.uninterruptibleMask((restore) =>
          EffectRuntime.gen(function* () {
            const origin = yield* PermissionOrigin.capture
            const result = yield* origin.length
              ? restore(evaluateInput(input, origin))
              : evaluateInput(input, origin)
            if (result.effect === "deny") {
              return yield* new DeniedError({
                rules: relevant(input, result.rules),
              })
            }
            if (result.effect === "allow") return
            const item = yield* create(request(input), input.agent, origin)
            yield* restore(Deferred.await(item.deferred)).pipe(
              EffectRuntime.ensuring(
                EffectRuntime.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
            const ceiling = yield* Delegation.Current
            if (ceiling && (ceiling.sessionID !== input.sessionID || !(yield* restore(ceiling.valid))))
              return yield* new DeniedError({ rules: originDenied(input) })
            if (!origin.length) return
            yield* restore(
              EffectRuntime.gen(function* () {
                const rules = yield* configured(
                  input.sessionID,
                  input.agent,
                  origin,
                )
                if (denied(input, rules))
                  return yield* new DeniedError({
                    rules: relevant(input, rules),
                  })
                if (!(yield* PermissionOrigin.permits(input, origin)))
                  return yield* new DeniedError({ rules: originDenied(input) })
              }),
            )
          }),
        ),
    )

    const settleReply = EffectRuntime.fnUntraced(function* (
      input: ReplyInput,
      existing: Pending,
      restore: <A, E, R>(
        work: EffectRuntime.Effect<A, E, R>,
      ) => EffectRuntime.Effect<A, E, R>,
    ) {
      if (input.reply !== "reject" && existing.delegation) {
        if (input.reply === "always" || !(yield* restore(existing.delegation.valid)))
          return yield* new ReplyForbiddenError({ requestID: input.requestID,
            message: "Foreground subtask permissions are valid only for this parent run; approve once or reject",
          })
      }
      if (input.reply !== "reject" && existing.origin.length) {
        if (input.reply === "always")
          return yield* new ReplyForbiddenError({
            requestID: input.requestID,
            message:
              "Remote permissions cannot be remembered; approve this request only once",
          })
        const allowed = yield* restore(
          EffectRuntime.gen(function* () {
            const rules = yield* configured(
              existing.request.sessionID,
              existing.agent,
              existing.origin,
            ).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () =>
                EffectRuntime.succeed(missingAgentPermissions),
              ),
            )
            return (
              !denied(existing.request, rules) &&
              (yield* PermissionOrigin.permits(
                existing.request,
                existing.origin,
              ))
            )
          }),
        )
        if (!allowed)
          return yield* new ReplyForbiddenError({
            requestID: input.requestID,
            message:
              "The command's permission scope is no longer valid; reject this request",
          })
      }
      if (pending.get(input.requestID) !== existing)
        return yield* new NotFoundError({ requestID: input.requestID })
      yield* events.publish(Event.Replied, {
        sessionID: existing.request.sessionID,
        requestID: existing.request.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new CorrectedError({ feedback: input.message })
            : new RejectedError(),
        )
        pending.delete(input.requestID)
        if (existing.origin.length) return
        for (const [id, item] of pending) {
          if (
            item.origin.length ||
            item.request.sessionID !== existing.request.sessionID
          )
            continue
          yield* events.publish(Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
          pending.delete(id)
        }
        return
      }

      if (input.reply === "always" && existing.request.save?.length) {
        yield* saved.add({
          projectID: location.project.id,
          action: existing.request.action,
          resources: existing.request.save,
        })
      }
      yield* Deferred.succeed(existing.deferred, undefined)
      pending.delete(input.requestID)
      if (input.reply !== "always" || !existing.request.save?.length) return

      const rememberedRules = yield* savedRules()
      for (const [id, item] of pending) {
        if (item.origin.length) continue
        const input = { ...item.request }
        const rules = yield* configured(
          item.request.sessionID,
          item.agent,
        ).pipe(
          EffectRuntime.catchTag("Session.NotFoundError", () =>
            EffectRuntime.succeed(undefined),
          ),
        )
        if (!rules) continue
        if (denied(input, rules)) continue
        const effective = [...rules, ...rememberedRules]
        if (
          !item.request.resources.every(
            (resource) =>
              evaluate(item.request.action, resource, effective).effect ===
              "allow",
          )
        )
          continue
        yield* events.publish(Event.Replied, {
          sessionID: item.request.sessionID,
          requestID: item.request.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
        pending.delete(id)
      }
    })

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing)
            return yield* new NotFoundError({ requestID: input.requestID })
          if (!existing.origin.length)
            return yield* settleReply(input, existing, restore)
          if (existing.replying)
            return yield* new ReplyForbiddenError({
              requestID: input.requestID,
              message: "Another reply is already in progress for this request",
            })
          existing.replying = true
          return yield* settleReply(input, existing, restore).pipe(
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                existing.replying = false
              }),
            ),
          )
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (
      sessionID: SessionManager.ID,
    ) {
      return Array.from(pending.values(), (item) => item.request).filter(
        (request) => request.sessionID === sessionID,
      )
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(AgentRegistry.locationLayer),
)
