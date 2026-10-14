import {
  LLMClient,
  LLMEvent,
  Model,
  type LLMError,
  type LLMRequest,
} from "../../src/inference/api"
import * as OpenAIChat from "../../src/inference/protocols/openai-chat"
import { Auth, type RequestExecutor } from "../../src/inference/request/api"
import { AgentRegistry } from "../../src/agents/registry"
import { Config } from "../../src/settings/config"
import { NodeCommandRunner } from "../../src/execution/commands/runner"
import { PermissionPolicy } from "../../src/security/permissions/service"
import { PermissionSaved } from "../../src/security/permissions/saved"
import { PermissionOrigin } from "../../src/security/permissions/origin"
import { ReferenceGuidance } from "../../src/agents/references/guidance"
import { SessionManager } from "../../src/sessions/service"
import { SessionStore } from "../../src/sessions/store"
import * as SessionRunnerLLM from "../../src/sessions/run/inference"
import { SessionRunnerModel } from "../../src/sessions/run/model"
import { SkillGuidance } from "../../src/agents/skills/guidance"
import { Snapshot } from "../../src/workspace/repository/snapshot"
import { SystemContext } from "../../src/agents/context/system"
import { SystemContextRegistry } from "../../src/agents/context/registry"
import { ToolOutputStore } from "../../src/tools/output-store"
import { ApplicationTools } from "../../src/tools/application"
import { ToolRegistry } from "../../src/tools/registry"
import { VerificationSettlementPublisher } from "../../src/runtime/events/verification-publisher"
import { VerifierContainment } from "../../src/verification/containment"
import { VerifierRegistry } from "../../src/verification/registry"
import { Effect, Layer, Stream } from "effect"
import * as control from "./node-control"

export const model = Model.make({
  id: "fixture",
  provider: "fixture",
  route: OpenAIChat.route.with({ auth: Auth.none }),
})
const agent = {
  ...AgentRegistry.Info.empty(AgentRegistry.defaultID),
  permissions: [{ action: "*", resource: "*", effect: "allow" as const }],
}
export const answer: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text" }),
  LLMEvent.textDelta({ id: "text", text: "fixture answer" }),
  LLMEvent.textEnd({ id: "text" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

export function fixture(budget?: NonNullable<Config.Info["run_budget"]>) {
  const requests: LLMRequest[] = []
  const scopes: ReadonlyArray<PermissionOrigin.Constraint>[] = []
  let reply: (
    request: LLMRequest,
    options?: RequestExecutor.ExecutionOptions,
  ) => Stream.Stream<LLMEvent, LLMError> = () => Stream.fromIterable(answer)
  let resolve: SessionRunnerModel.Interface["resolve"] = () =>
    Effect.succeed(model)
  let captures = 0
  let observation: Snapshot.Interface["captureObservation"] = () =>
    Effect.succeed(Snapshot.ID.make("fixture_tree"))
  const sessions = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      return Layer.mock(SessionManager.Service, {
        revert: {
          stage: () => Effect.die("unused"),
          clear: () => Effect.die("unused"),
          commit: () => Effect.die("unused"),
        },
        get: (sessionID) =>
          store
            .get(sessionID)
            .pipe(
              Effect.flatMap((session) =>
                session
                  ? Effect.succeed(session)
                  : Effect.fail(new SessionManager.NotFoundError({ sessionID })),
              ),
            ),
      })
    }),
  ).pipe(Layer.provideMerge(SessionStore.defaultLayer))
  const shared = Layer.mergeAll(
    control.layer,
    sessions,
    ApplicationTools.layer,
    SystemContextRegistry.layer,
    Layer.mock(AgentRegistry.Service, {
      select: () => Effect.succeed({ id: agent.id, info: agent }),
      resolve: () => Effect.succeed(agent),
    }),
    Layer.mock(Config.Service, { entries: () => Effect.succeed(budget
      ? [new Config.Document({ type: "document", info: new Config.Info({ run_budget: budget }) })] : []) }),
    Layer.mock(SkillGuidance.Service, {
      load: () => Effect.succeed(SystemContext.empty),
    }),
    Layer.mock(ReferenceGuidance.Service, {
      load: () => Effect.succeed(SystemContext.empty),
    }),
    Layer.mock(Snapshot.Service, {
      capture: () =>
        Effect.die(
          "Native execution must not use a legacy repository snapshot",
        ),
      captureObservation: () =>
        Effect.sync(() => {
          captures++
        }).pipe(Effect.andThen(Effect.suspend(observation))),
      files: () => Effect.succeed([]),
    }),
    Layer.mock(VerifierRegistry.Registry, {
      select: () =>
        Effect.die("native execution must not run an unqualified verifier"),
    }),
    Layer.mock(VerifierContainment.Service, {
      execute: () => Effect.die("unqualified verifier"),
    }),
    VerificationSettlementPublisher.layer.pipe(Layer.provide(control.layer)),
    Layer.mock(ToolOutputStore.Service, {
      bound: ({ output }) => Effect.succeed({ output, outputPaths: [] }),
    }),
    SessionRunnerModel.layerWith((session) => resolve(session)),
    Layer.mock(LLMClient.Service, {
      stream: (request, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            requests.push(request)
            scopes.push(yield* PermissionOrigin.capture)
            return reply(request, options)
          }),
        ),
    }),
  )
  const permissions = PermissionPolicy.layer.pipe(
    Layer.provideMerge(shared),
    Layer.provide(PermissionSaved.defaultLayer),
  )
  const registry = ToolRegistry.layer.pipe(Layer.provideMerge(permissions))
  const layer = SessionRunnerLLM.layer.pipe(Layer.provideMerge(registry))
  return {
    layer,
    requests,
    scopes,
    captures: () => captures,
    observation: (value: typeof observation) => {
      observation = value
    },
    reply: (value: typeof reply) => {
      reply = value
    },
    resolve: (value: typeof resolve) => {
      resolve = value
    },
    run: (
      node: Parameters<NodeCommandRunner.Interface["run"]>[0],
      target: NodeCommandRunner.Target,
    ) => NodeCommandRunner.Service.use((runner) => runner.run(node, target)),
  }
}
