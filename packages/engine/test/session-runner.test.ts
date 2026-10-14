import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  ProviderInternalReason,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "../src/inference/api"
import { RequestExecutor } from "../src/inference/request/api"
import * as OpenAIChat from "../src/inference/protocols/openai-chat"
import { Database } from "../src/storage/database"
import { EventBus } from "../src/runtime/events/bus"
import { PermissionPolicy } from "../src/security/permissions/service"
import { EventSequenceTable, EventTable } from "../src/storage/tables/events"
import { ProjectRegistry } from "../src/workspace/projects/service"
import { ProjectTable } from "../src/storage/tables/projects"
import { UserQuestions } from "../src/agents/questions"
import { AbsolutePath, RelativePath } from "../src/shared/schema"
import { SessionManager } from "../src/sessions/service"
import { LocationServiceRegistry } from "../src/runtime/services"
import { Snapshot } from "../src/workspace/repository/snapshot"
import { ContextSnapshotDecodeError } from "../src/sessions/errors"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionInput } from "../src/sessions/input/inbox"
import { SessionInputOrigin } from "../src/sessions/input/origin"
import { PermissionOrigin } from "../src/security/permissions/origin"
import { SessionMessage } from "../src/sessions/messages/service"
import { Prompt } from "../src/contracts/session/prompt"
import { SessionProjector } from "../src/sessions/projector"
import { SessionRunState } from "../src/sessions/run/state"
import { SessionExecution } from "../src/sessions/run/execution"
import { SessionRunCoordinator } from "../src/sessions/run/coordinator"
import { SessionRunner } from "../src/sessions/run/loop"
import * as SessionRunnerLLM from "../src/sessions/run/inference"
import { SessionRunnerModel } from "../src/sessions/run/model"
import { ToolRegistry } from "../src/tools/registry"
import { ToolOutputStore } from "../src/tools/output-store"
import { VerifierContainment } from "../src/verification/containment"
import { VerifierRegistry } from "../src/verification/registry"
import { VerificationSettlementPublisher } from "../src/runtime/events/verification-publisher"
import { ApplicationTools } from "../src/tools/application"
import { AgentRegistry } from "../src/agents/registry"
import { Config } from "../src/settings/config"
import { ConfigCompaction } from "../src/settings/compaction"
import { Tool } from "../src/tools/definition"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  VerificationLocationStateTable,
  VerificationReceiptTable,
} from "../src/storage/tables/sessions"
import { SessionVerification } from "../src/sessions/verification/service"
import { SessionVerificationRecovery } from "../src/sessions/verification/recovery"
import { SessionStore } from "../src/sessions/store"
import { SystemContext } from "../src/agents/context/system"
import { SystemContextRegistry } from "../src/agents/context/registry"
import { SkillGuidance } from "../src/agents/skills/guidance"
import { ReferenceGuidance } from "../src/agents/references/guidance"
import { CatalogModel } from "../src/inference/catalog/model"
import { Location } from "../src/workspace/location"
import { CatalogProvider } from "../src/inference/catalog/provider"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { inputOrigin } from "./fixture/session-input-origin"

const questions = UserQuestions.layer.pipe(Layer.provide(EventBus.defaultLayer))
const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
type AcquisitionFailure = {
  readonly error: LLMError
  readonly delayMs: number
  readonly retryAt: number
}
let acquisitionFailures: AcquisitionFailure[] = []
let beforeRetry: ((notice: RequestExecutor.RetryNotice) => Effect.Effect<void>) | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const stableSnapshot = Snapshot.ID.make("tree_stable")
let captureSnapshot: Snapshot.Interface["capture"] = () => Effect.succeed(stableSnapshot)
let captureVerificationSnapshot: Snapshot.Interface["captureVerification"] = () => Effect.succeed(stableSnapshot)
let captureObservationSnapshot: Snapshot.Interface["captureObservation"] = () => Effect.succeed(stableSnapshot)
let compareSnapshots: Snapshot.Interface["files"] = () => Effect.succeed([])
const snapshotLayer = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () => captureSnapshot(),
    captureVerification: () => captureVerificationSnapshot(),
    captureObservation: () => captureObservationSnapshot(),
    retain: () => Effect.void,
    files: (input) => compareSnapshots(input),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    materialize: () =>
      Effect.fail(
        new Snapshot.Error({
          operation: "materialize",
          message: "unused test materializer",
        }),
      ),
    materializeAt: () =>
      Effect.fail(
        new Snapshot.Error({
          operation: "materialize",
          message: "unused test materializer",
        }),
      ),
  }),
)
let selectTrustedVerifier: VerifierRegistry.Interface["select"] = () => Effect.succeed(undefined)
let executeContainedVerifier: VerifierContainment.Interface["execute"] = () =>
  Effect.fail(
    new VerifierContainment.Error({
      reason: "unavailable",
      message: "No verifier containment executor is available",
    }),
  )
const verifierRegistryLayer = Layer.succeed(
  VerifierRegistry.Registry,
  VerifierRegistry.Registry.of({
    select: (input) => selectTrustedVerifier(input),
  }),
)
const verifierContainmentLayer = Layer.succeed(
  VerifierContainment.Service,
  VerifierContainment.make((input) => executeContainedVerifier(input)),
)
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest, options?: RequestExecutor.ExecutionOptions) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      const gatedEvents = !streamGate
        ? events
        : Stream.unwrap(
            (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
              Effect.andThen(Deferred.await(streamGate)),
              Effect.as(events),
            ),
          )
      if (acquisitionFailures.length === 0) return gatedEvents
      return Stream.unwrap(
        Effect.gen(function* () {
          let retries = 0
          while (acquisitionFailures.length > 0) {
            const failure = acquisitionFailures.shift()!
            if (!failure.error.retryable || retries >= (options?.retryPolicy?.maxRetries ?? 0))
              return yield* Effect.fail(failure.error)
            const notice = {
              attempt: retries + 1,
              delayMs: failure.delayMs,
              retryAt: failure.retryAt,
              error: failure.error,
            }
            if (beforeRetry) yield* beforeRetry(notice)
            if (options?.onRetry) yield* options.onRetry(notice)
            retries++
            requests.push(request)
          }
          return gatedEvents
        }),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({
  id: "fake-model",
  provider: "fake",
  route: OpenAIChat.route,
})
const replacementModel = Model.make({
  id: "replacement",
  provider: "fake",
  route: OpenAIChat.route,
})
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permissionAssertions: PermissionPolicy.AssertInput[] = []
let assertPermission: PermissionPolicy.Interface["assert"] = () => Effect.void
const permission = Layer.succeed(
  PermissionPolicy.Service,
  PermissionPolicy.Service.of({
    assert: (input) =>
      Effect.sync(() => permissionAssertions.push(input)).pipe(Effect.andThen(assertPermission(input))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentRegistry.layer
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        parallel: true,
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        parallel: true,
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
).pipe(Layer.provide(registry))
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel)),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentRegistry.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(SystemContextRegistry.layer))
const location = Location.layer({
  directory: AbsolutePath.make("/project"),
}).pipe(Layer.provide(ProjectRegistry.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(snapshotLayer),
  Layer.provide(verifierRegistryLayer),
  Layer.provide(verifierContainmentLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(EventBus.defaultLayer),
  Layer.provide(VerificationSettlementPublisher.layer.pipe(Layer.provide(EventBus.defaultLayer))),
  Layer.provide(client),
  Layer.provide(permission),
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(referenceGuidance),
  Layer.provide(config),
)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionManager.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      awaitIdle: coordinator.awaitIdle,
      wait: coordinator.wait,
      shell: () => Effect.die("unused shell"),
      skill: () => Effect.die("unused skill"),
      command: () => Effect.die("unused command"),
      compact: () => Effect.die("unused compact"),
      resume: coordinator.run,
      scheduleResume: coordinator.schedule,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runner))
const sessions = SessionManager.layer.pipe(
  Layer.provide(LocationServiceRegistry.layer),
  Layer.provide(EventBus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(ProjectRegistry.defaultLayer),
  Layer.provide(execution),
)
const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    EventBus.defaultLayer,
    questions,
    SessionProjector.defaultLayer,
    SessionStore.defaultLayer,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    runner,
    execution,
    sessions,
  ),
)
const sessionID = SessionManager.ID.make("ses_runner_test")
const otherSessionID = SessionManager.ID.make("ses_runner_other")

const insertSession = (id: SessionManager.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: ProjectRegistry.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  acquisitionFailures = []
  beforeRetry = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  permissionAssertions.length = 0
  assertPermission = () => Effect.void
  captureSnapshot = () => Effect.succeed(stableSnapshot)
  captureVerificationSnapshot = () => Effect.succeed(stableSnapshot)
  captureObservationSnapshot = () => Effect.succeed(stableSnapshot)
  compareSnapshots = () => Effect.succeed([])
  selectTrustedVerifier = () => Effect.succeed(undefined)
  executeContainedVerifier = () =>
    Effect.fail(
      new VerifierContainment.Error({
        reason: "unavailable",
        message: "No verifier containment executor is available",
      }),
    )
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectRegistry.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const retryableProviderUnavailable = (message = "Provider temporarily unavailable") =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new ProviderInternalReason({
      message,
      status: 503,
      http: new HttpContext({
        request: new HttpRequestDetails({
          method: "POST",
          url: "https://provider.test/v1/chat?api_key=%3Credacted%3E",
          headers: { authorization: "<redacted>" },
        }),
        response: new HttpResponseDetails({
          status: 503,
          headers: { "retry-after": "0", "set-cookie": "<redacted>" },
        }),
        body: '{"api_key":"<redacted>"}',
        requestId: "req_retry_test",
      }),
    }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionManager.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const replaySessionProjection = (id: SessionManager.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventBus.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventBus.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: {
          type: "assistant",
          finish: "stop",
          content: [expectedContent],
        },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: {
          type: "assistant",
          finish: "stop",
          content: [expectedContent],
        },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = {
        type: "tool",
        id,
        state: { status: "pending", input: text },
      }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.toolInputEnd({ id, name: "echo" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: {
          type: "assistant",
          finish: "stop",
          content: [{ type: "tool", id, state: { status: "error" } }],
        },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: prompt }),
      resume: false,
    })
    const events = yield* EventBus.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventBus.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    const prompt = `Fail after ${kind}`
    const id = fragmentID(kind, "partial")
    const fixture = fragmentFixture(kind, id, ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: prompt }),
      resume: false,
    })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    const messages = yield* session.context(sessionID)
    expect(messages).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [
          kind === "tool input"
            ? {
                type: "tool",
                id,
                state: {
                  status: "error",
                  error: {
                    message: "Tool execution interrupted after provider failure: Provider unavailable",
                  },
                },
              }
            : fixture.expectedContent,
        ],
      },
    ])
    yield* replaySessionProjection(sessionID)
    expect(yield* session.context(sessionID)).toMatchObject(messages)
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionManager.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: prompt }),
      resume: false,
    })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? {
                type: "tool",
                id: fragmentID(kind, "interrupted"),
                state: { status: "error" },
              }
            : fixture.expectedContent,
        ],
      },
    ])
  })

const durableRunEvents = (id: SessionManager.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({
        seq: EventTable.seq,
        type: EventTable.type,
        data: EventTable.data,
      })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)).filter((event) => event.type.startsWith("session.next.run."))
  })

describe("SessionRunnerLLM", () => {
  it.effect("refuses bound input before recovery, snapshots, history promotion or a provider call", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const runner = yield* SessionRunner.Service
      const recorded = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: Prompt.make({ text: "Remote input" }),
        delivery: "steer",
        origin: inputOrigin(),
      })
      let snapshots = 0
      captureSnapshot =
        captureVerificationSnapshot =
        captureObservationSnapshot =
          () => {
            snapshots++
            return Effect.succeed(stableSnapshot)
          }
      for (const force of [false, true]) {
        expect(yield* runner.run({ sessionID, force }).pipe(Effect.flip)).toBeInstanceOf(
          SessionInputOrigin.UnavailableError,
        )
      }
      expect(requests).toEqual([])
      expect(snapshots).toBe(0)
      expect((yield* SessionInput.find(db, recorded.id))?.promotedSeq).toBeUndefined()
      expect(yield* durableRunEvents(sessionID)).toEqual([])
      expect(yield* (yield* SessionStore.Service).context(sessionID)).toEqual([])
    }),
  )

  it.effect("does not borrow local execution rights from a transient origin wrapper", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const runner = yield* SessionRunner.Service
      const error = yield* PermissionOrigin.restrict(
        {
          sessionID,
          rules: [{ action: "read", resource: "*", effect: "allow" }],
          valid: Effect.succeed(true),
        },
        runner.run({ sessionID, force: true }),
      ).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionInputOrigin.UnavailableError)
      expect(requests).toEqual([])
      expect(yield* durableRunEvents(sessionID)).toEqual([])
    }),
  )

  for (const stage of ["verification", "model", "snapshot"] as const)
    it.effect(`refuses a new provider attempt when remote input arrives during ${stage}`, () =>
      Effect.gen(function* () {
        yield* setup
        requests.length = 0
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const session = yield* SessionManager.Service
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Local first" }),
          resume: false,
        })
        const queued = yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Local queue" }),
          delivery: "queue",
          resume: false,
        })
        const remoteID = SessionMessage.ID.make("msg_remote_during_preparation")
        const record = SessionInput.admit(db, events, {
          id: remoteID,
          sessionID,
          prompt: Prompt.make({ text: "Record-only remote" }),
          delivery: "queue",
          origin: inputOrigin(),
        }).pipe(Effect.asVoid, Effect.orDie)
        if (stage === "verification") selectTrustedVerifier = () => record.pipe(Effect.as(undefined))
        if (stage === "model") modelResolveHook = record
        if (stage === "snapshot") captureSnapshot = () => record.pipe(Effect.as(stableSnapshot))
        expect(yield* (yield* SessionRunner.Service).run({ sessionID, force: true }).pipe(Effect.flip)).toBeInstanceOf(
          SessionInputOrigin.UnavailableError,
        )
        expect(requests).toEqual([])
        expect((yield* SessionInput.find(db, remoteID))?.promotedSeq).toBeUndefined()
        expect((yield* SessionInput.find(db, queued.id))?.promotedSeq).toBeUndefined()
        expect((yield* (yield* SessionStore.Service).runState(sessionID))?.status).toBe("terminal-failure")
      }),
    )

  it.effect("stops captured steer promotion before history or dispatch when remote provenance arrives", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const session = yield* SessionManager.Service
      const first = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First local" }),
        resume: false,
      })
      const second = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second local" }),
        resume: false,
      })
      const remoteID = SessionMessage.ID.make("msg_remote_during_promotion")
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type && (event as SessionEvent.Prompted).data.messageID === first.id
          ? SessionInput.admit(db, events, {
              id: remoteID,
              sessionID,
              prompt: Prompt.make({ text: "Record-only remote" }),
              delivery: "queue",
              origin: inputOrigin(),
            }).pipe(Effect.asVoid, Effect.orDie)
          : Effect.void,
      )
      expect(yield* (yield* SessionRunner.Service).run({ sessionID, force: true }).pipe(Effect.flip)).toBeInstanceOf(
        SessionInputOrigin.UnavailableError,
      )
      expect(requests).toEqual([])
      expect((yield* SessionInput.find(db, first.id))?.promotedSeq).toBeDefined()
      expect((yield* SessionInput.find(db, second.id))?.promotedSeq).toBeUndefined()
      expect((yield* SessionInput.find(db, remoteID))?.promotedSeq).toBeUndefined()
      expect(yield* (yield* SessionStore.Service).context(sessionID)).toMatchObject([
        { type: "user", text: "First local" },
      ])
    }),
  )

  it.effect("keeps post-selection local steers out of the current request and ahead of queued input", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const session = yield* SessionManager.Service
      const first = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First local" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queued local" }),
        delivery: "queue",
        resume: false,
      })
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type && (event as SessionEvent.Prompted).data.messageID === first.id
          ? SessionInput.admit(db, events, {
              id: SessionMessage.ID.make("msg_post_selection_steer"),
              sessionID,
              prompt: Prompt.make({ text: "Late steer" }),
              delivery: "steer",
            }).pipe(Effect.asVoid, Effect.orDie)
          : Effect.void,
      )
      yield* (yield* SessionRunner.Service).run({ sessionID, force: true })
      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["First local"])
      expect(userTexts(requests[1]!)).toEqual(["First local", "Late steer"])
      expect(userTexts(requests[2]!)).toEqual(["First local", "Late steer", "Queued local"])
    }),
  )

  for (const next of ["queue", "tool continuation"] as const)
    it.effect(`does not interrupt the started local stream but blocks ${next} after remote admission`, () =>
      Effect.gen(function* () {
        yield* setup
        requests.length = 0
        const { db } = yield* Database.Service
        const events = yield* EventBus.Service
        const session = yield* SessionManager.Service
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Started local" }),
          resume: false,
        })
        if (next === "queue")
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Queued local" }),
            delivery: "queue",
            resume: false,
          })
        response =
          next === "queue"
            ? fragmentFixture("text", "late-remote", ["Local finished"]).completeEvents
            : [
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.toolCall({
                  id: "call-local-before-remote",
                  name: "echo",
                  input: { text: "Local tool" },
                }),
                LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                LLMEvent.finish({ reason: "tool-calls" }),
              ]
        streamGate = yield* Deferred.make<void>()
        streamStarted = yield* Deferred.make<void>()
        const fiber = yield* (yield* SessionRunner.Service)
          .run({ sessionID, force: true })
          .pipe(Effect.flip, Effect.forkChild)
        yield* Deferred.await(streamStarted)
        const remote = yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.make("msg_remote_while_streaming"),
          sessionID,
          prompt: Prompt.make({ text: "Record-only remote" }),
          delivery: "queue",
          origin: inputOrigin(),
        })
        expect((yield* (yield* SessionStore.Service).runState(sessionID))?.status).toBe("busy")
        expect(requests).toHaveLength(1)
        yield* Deferred.succeed(streamGate, undefined)
        expect(yield* Fiber.join(fiber)).toBeInstanceOf(SessionInputOrigin.UnavailableError)
        streamGate = undefined
        streamStarted = undefined
        expect(requests).toHaveLength(1)
        expect(userTexts(requests[0]!)).toEqual(["Started local"])
        expect((yield* SessionInput.find(db, remote.id))?.promotedSeq).toBeUndefined()
        if (next === "tool continuation")
          expect(yield* session.context(sessionID)).toMatchObject([
            { type: "user", text: "Started local" },
            {
              type: "assistant",
              content: [{ type: "tool", state: { status: "completed" } }],
            },
          ])
        else
          expect(yield* session.context(sessionID)).toMatchObject([
            { type: "user", text: "Started local" },
            { type: "assistant", finish: "stop" },
          ])
      }),
    )

  it.effect("publishes ordered run retry lifecycle events and settles idle", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Retry once" }),
        resume: false,
      })
      acquisitionFailures = [
        {
          error: retryableProviderUnavailable(),
          delayMs: 25,
          retryAt: 12_345,
        },
      ]
      response = fragmentFixture("text", "text-run-retry", ["Recovered"]).completeEvents

      yield* session.resume(sessionID)

      const events = yield* durableRunEvents(sessionID)
      expect(events.map((event) => event.type)).toEqual([
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Retried.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
      ])
      const runID = events[0]?.data.runID
      expect(events[1]?.data).toMatchObject({
        sessionID,
        runID,
        attempt: 1,
        nextRetryAt: 12_345,
        error: {
          message: "Provider temporarily unavailable",
          statusCode: 503,
          isRetryable: true,
          responseHeaders: { "retry-after": "0", "set-cookie": "<redacted>" },
          responseBody: '{"api_key":"<redacted>"}',
          metadata: { requestId: "req_retry_test" },
        },
      })
      expect(events[2]?.data).toMatchObject({
        runID,
        outcome: { type: "idle" },
      })
      expect(yield* store.runState(sessionID)).toMatchObject({
        runID,
        status: "idle",
      })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("bounds acquisition retries to two and settles terminal failure", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Exhaust retries" }),
        resume: false,
      })
      acquisitionFailures = [
        {
          error: retryableProviderUnavailable("attempt one"),
          delayMs: 0,
          retryAt: 100,
        },
        {
          error: retryableProviderUnavailable("attempt two"),
          delayMs: 0,
          retryAt: 200,
        },
        {
          error: retryableProviderUnavailable("attempt three"),
          delayMs: 0,
          retryAt: 300,
        },
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(3)
      const events = yield* durableRunEvents(sessionID)
      expect(events.map((event) => event.type)).toEqual([
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Retried.type, 1),
        EventBus.versionedType(SessionEvent.Run.Retried.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
      ])
      expect(events.slice(1, 3).map((event) => event.data.attempt)).toEqual([1, 2])
      expect(events.at(-1)?.data).toMatchObject({
        outcome: {
          type: "terminal-failure",
          error: { type: "unknown", message: "attempt three" },
        },
      })
      expect(yield* store.runState(sessionID)).toMatchObject({
        status: "terminal-failure",
        error: { type: "unknown", message: "attempt three" },
      })
    }),
  )

  it.effect("bounds durable retry and terminal run errors on UTF-8 boundaries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Bound durable run errors" }),
        resume: false,
      })
      const oversized = "🙂".repeat(8_000)
      acquisitionFailures = [
        {
          error: retryableProviderUnavailable(oversized),
          delayMs: 0,
          retryAt: 100,
        },
        {
          error: retryableProviderUnavailable(oversized),
          delayMs: 0,
          retryAt: 200,
        },
        {
          error: retryableProviderUnavailable(oversized),
          delayMs: 0,
          retryAt: 300,
        },
      ]

      yield* session.resume(sessionID).pipe(Effect.exit)

      const events = yield* durableRunEvents(sessionID)
      const messages = events.flatMap((event) => {
        const data = event.data as {
          error?: { message?: string }
          outcome?: { error?: { message?: string } }
        }
        return [data.error?.message, data.outcome?.error?.message].filter(
          (value): value is string => value !== undefined,
        )
      })
      expect(messages).toHaveLength(3)
      expect(messages.every((message) => Buffer.byteLength(message, "utf8") <= 16 * 1024)).toBe(true)
      expect(messages.every((message) => message.endsWith("…[truncated]"))).toBe(true)
    }),
  )

  it.effect("stops before the next acquisition when retry publication loses its run CAS", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      const eventService = yield* EventBus.Service
      const replacementRunID = SessionRunState.ID.create()
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Replace active retry" }),
        resume: false,
      })
      acquisitionFailures = [{ error: retryableProviderUnavailable(), delayMs: 0, retryAt: 100 }]
      beforeRetry = () =>
        Effect.gen(function* () {
          const active = yield* store.runState(sessionID).pipe(Effect.orDie)
          if (!active || (active.status !== "busy" && active.status !== "retrying"))
            return yield* Effect.die("Expected an active run before retry")
          const now = yield* DateTime.now
          const timestamp = DateTime.makeUnsafe(
            Math.max(DateTime.toEpochMillis(now), DateTime.toEpochMillis(active.time.started)),
          )
          yield* eventService.publishBatch([
            {
              definition: SessionEvent.Run.Settled,
              data: {
                sessionID,
                runID: active.runID,
                timestamp,
                outcome: { type: "interrupted" },
              },
            },
            {
              definition: SessionEvent.Run.Started,
              data: { sessionID, runID: replacementRunID, timestamp },
            },
          ])
        })

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.filter(Cause.isDieReason)).toHaveLength(2)
        expect(Cause.pretty(exit.cause)).toContain("stale-run")
      }
      expect(requests).toHaveLength(1)
      expect(yield* store.runState(sessionID)).toMatchObject({
        runID: replacementRunID,
        status: "busy",
      })
      expect((yield* durableRunEvents(sessionID)).map((event) => event.type)).toEqual([
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
      ])
    }),
  )

  it.effect("settles an interrupted drain after cancellation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      const started = yield* Deferred.make<void>()
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt this run" }),
        resume: false,
      })
      responseStream = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never))
      const runner = yield* SessionRunner.Service
      const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      yield* Deferred.await(started)

      yield* Fiber.interrupt(fiber)

      expect(yield* store.runState(sessionID)).toMatchObject({
        status: "interrupted",
      })
      const events = yield* durableRunEvents(sessionID)
      expect(events.map((event) => event.type)).toEqual([
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
      ])
      expect(events[1]?.data).toMatchObject({
        outcome: { type: "interrupted" },
      })
    }),
  )

  it.effect("atomically interrupts an active run before starting its replacement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const store = yield* SessionStore.Service
      const eventService = yield* EventBus.Service
      const oldRunID = SessionRunState.ID.create()
      yield* eventService.publish(SessionEvent.Run.Started, {
        sessionID,
        runID: oldRunID,
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Resume abandoned run" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-replacement-run", ["Done"]).completeEvents

      yield* session.resume(sessionID)

      const events = yield* durableRunEvents(sessionID)
      expect(events.map((event) => event.type)).toEqual([
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
        EventBus.versionedType(SessionEvent.Run.Started.type, 1),
        EventBus.versionedType(SessionEvent.Run.Settled.type, 1),
      ])
      expect(events[1]?.seq + 1).toBe(events[2]?.seq)
      expect(events[1]?.data).toMatchObject({
        runID: oldRunID,
        outcome: { type: "interrupted" },
      })
      const replacementRunID = events[2]?.data.runID
      expect(replacementRunID).not.toBe(oldRunID)
      expect(events[3]?.data).toMatchObject({
        runID: replacementRunID,
        outcome: { type: "idle" },
      })
      expect(yield* store.runState(sessionID)).toMatchObject({
        runID: replacementRunID,
        status: "idle",
      })
    }),
  )

  it.effect("recovers an idle session before the no-work early return", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const activeLocation = yield* Location.Service
      const sessionRunner = yield* SessionRunner.Service
      const key = SessionVerification.locationKey(activeLocation)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: key,
        snapshot: Snapshot.ID.make("tree_idle_recovery"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      yield* db
        .update(VerificationLocationStateTable)
        .set({
          mutation_epoch: prepared.mutationEpoch + 1,
          snapshot: "tree_idle_advanced",
        })
        .where(eq(VerificationLocationStateTable.location_key, key))
        .run()
        .pipe(Effect.orDie)
      let registryCalls = 0
      selectTrustedVerifier = () =>
        Effect.sync(() => {
          registryCalls++
          return undefined
        })
      requests.length = 0

      yield* sessionRunner.run({ sessionID, force: false })

      expect(requests).toHaveLength(0)
      expect(registryCalls).toBe(0)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "stale",
        checks: [],
      })
    }),
  )

  it.effect("does not mint recovery authority from an owner row after handoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const activeLocation = yield* Location.Service
      const sessionRunner = yield* SessionRunner.Service
      const key = SessionVerification.locationKey(activeLocation)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: key,
        snapshot: Snapshot.ID.make("tree_stale_runner_recovery"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      yield* db
        .update(VerificationLocationStateTable)
        .set({
          mutation_epoch: prepared.mutationEpoch + 1,
          snapshot: "tree_stale_runner_advanced",
        })
        .where(eq(VerificationLocationStateTable.location_key, key))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ owner_id: "wrk_new_owner", owner_generation: 7 })
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      requests.length = 0

      yield* sessionRunner.run({ sessionID, force: false })

      expect(requests).toHaveLength(0)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: null,
        checks: [],
      })
    }),
  )

  it.effect("does not continue to the model when recovery notification is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventBus.Service
      const activeLocation = yield* Location.Service
      const sessionRunner = yield* SessionRunner.Service
      const key = SessionVerification.locationKey(activeLocation)
      const prepared = yield* SessionVerificationRecovery.prepareRequest(db, {
        sessionID,
        locationKey: key,
        snapshot: Snapshot.ID.make("tree_idle_interrupt"),
      })
      yield* SessionVerificationRecovery.publishPreparedRequest(db, events, prepared, sessionID)
      yield* db
        .update(VerificationLocationStateTable)
        .set({
          mutation_epoch: prepared.mutationEpoch + 1,
          snapshot: "tree_idle_interrupt_advanced",
        })
        .where(eq(VerificationLocationStateTable.location_key, key))
        .run()
        .pipe(Effect.orDie)
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionEvent.VerificationSettled.type ? Effect.interrupt : Effect.void,
      )
      requests.length = 0

      const exit = yield* sessionRunner.run({ sessionID, force: false }).pipe(Effect.exit)
      yield* unsubscribe

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(requests).toHaveLength(0)
      expect(yield* db.select().from(VerificationReceiptTable).get().pipe(Effect.orDie)).toMatchObject({
        verdict: "stale",
        checks: [],
      })
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionManager.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Use application context" }),
        resume: false,
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-application",
            name: "application_context",
            input: { query: "hello" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentRegistry.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run automatically" }),
      })
      yield* (yield* SessionExecution.Service).awaitIdle

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(
        requests[0]?.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "First" }),
      })
      yield* (yield* SessionExecution.Service).awaitIdle

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentRegistry.Service
      yield* agent.transform((editor) =>
        editor.update(AgentRegistry.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentRegistry.Service
      yield* agent.transform((editor) => {
        editor.update(AgentRegistry.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentRegistry.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentRegistry.ID.make("reviewer"))
      })
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({
        type: "assistant",
        agent: "reviewer",
      })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentRegistry.Service
      yield* agent.transform((editor) =>
        editor.update(AgentRegistry.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({
        type: "assistant",
        agent: "reviewer",
      })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      skillBaselines.set(AgentRegistry.ID.make("build"), "Build skills")
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentRegistry.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
        ["Initial context\n\nBuild skills"],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      skillBaselines.set(AgentRegistry.ID.make("build"), "Build skills")
      skillBaselines.set(AgentRegistry.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: {
              id: CatalogModel.ID.make("replacement"),
              providerID: CatalogProvider.ID.make("fake"),
            },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([["Initial context"]])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: {
          id: CatalogModel.ID.make("replacement"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Third" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fourth" }),
        resume: false,
      })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: {
          id: CatalogModel.ID.make("replacement"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      systemUnavailable = true
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Third" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Third" }),
        resume: false,
      })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("## Goal")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Goal\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the task",
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Goal\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<previous-summary>\n## Goal\n- Preserve the task\n</previous-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the updated task",
      })
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({
          message: "prompt too long",
          classification: "context-overflow",
        }),
      ]).pipe(Stream.concat(Stream.never))
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      yield* session.resume(sessionID).pipe(Effect.timeout("2 seconds"))

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Goal")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Goal\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({
          message: "prompt too long",
          classification: "context-overflow",
        }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
        },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.providerError({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        ],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
        },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.providerError({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        ],
        fragmentFixture("text", "text-summary", ["## Goal\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First" }),
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Third" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Initial context"])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning, tool events and priced usage without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Object.assign(Model.make(Model.input(model)), {
        cost: [{ input: 2, output: 6, cache: { read: 0.5, write: 3 } }],
      })
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Use tools" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({
          id: "call-error",
          name: "write",
          text: '{"path":"README.md"}',
        }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({
          id: "call-error",
          name: "write",
          input: { path: "README.md" },
          providerExecuted: true,
        }),
        LLMEvent.toolError({
          id: "call-error",
          name: "write",
          message: "Denied",
        }),
        LLMEvent.toolResult({
          id: "call-error",
          name: "write",
          result: { type: "error", value: "Denied" },
        }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              {
                type: "file",
                uri: "data:image/png;base64,aGVsbG8=",
                mime: "image/png",
                name: "hello.png",
              },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          cost: 0.000041,
          tokens: {
            input: 8,
            output: 3,
            reasoning: 1,
            cache: { read: 2, write: 0 },
          },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: {
                executed: true,
                metadata: { fake: { source: "provider" } },
              },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  {
                    type: "file",
                    mime: "image/png",
                    uri: "data:image/png;base64,aGVsbG8=",
                    name: "hello.png",
                  },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Echo this" }),
        resume: false,
      })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-echo",
            name: "echo",
            input: { text: "hello" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", id: "text-final", text: "Done" }],
        },
      ])
    }),
  )

  it.effect("gates the third identical local call from replayed history and re-gates the fourth", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Repeat only with approval" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-repeat-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-repeat-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["same", "same"])
      expect(permissionAssertions).toHaveLength(0)
      yield* replaySessionProjection(sessionID)

      requests.length = 0
      const asked = yield* Deferred.make<PermissionPolicy.AssertInput>()
      const approved = yield* Deferred.make<void>()
      const askedAgain = yield* Deferred.make<PermissionPolicy.AssertInput>()
      const approvedAgain = yield* Deferred.make<void>()
      let assertionIndex = 0
      assertPermission = (input) => {
        if (assertionIndex++ === 0) return Deferred.succeed(asked, input).pipe(Effect.andThen(Deferred.await(approved)))
        return Deferred.succeed(askedAgain, input).pipe(Effect.andThen(Deferred.await(approvedAgain)))
      }
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-repeat-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-repeat-4",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const assertion = yield* Deferred.await(asked)
      const pending = yield* session.context(sessionID)
      const guarded = pending.findLast((message) => message.type === "assistant")

      expect(executions).toEqual(["same", "same"])
      expect(guarded).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-repeat-3",
            state: { status: "running", input: { text: "same" } },
          },
        ],
      })
      expect(assertion).toMatchObject({
        action: "doom_loop",
        resources: ["echo"],
        save: ["echo"],
        sessionID,
        metadata: {
          tool: "echo",
          input: { text: "same" },
          repeatCount: 3,
        },
        source: {
          type: "tool",
          messageID: guarded?.id,
          callID: "call-repeat-3",
        },
      })

      yield* Deferred.succeed(approved, undefined)
      const fourthAssertion = yield* Deferred.await(askedAgain)

      expect(executions).toEqual(["same", "same", "same"])
      expect(fourthAssertion).toMatchObject({
        action: "doom_loop",
        resources: ["echo"],
        metadata: {
          tool: "echo",
          input: { text: "same" },
          repeatCount: 4,
        },
        source: {
          type: "tool",
          callID: "call-repeat-4",
        },
      })

      yield* Deferred.succeed(approvedAgain, undefined)
      yield* Fiber.join(run)

      expect(executions).toEqual(["same", "same", "same", "same"])
      expect(requests).toHaveLength(3)
      expect(permissionAssertions.map((input) => input.metadata?.repeatCount)).toEqual([3, 4])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Repeat only with approval" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-repeat-1",
              state: { status: "completed" },
            },
            {
              type: "tool",
              id: "call-repeat-2",
              state: { status: "completed" },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-repeat-3",
              state: { status: "completed" },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-repeat-4",
              state: { status: "completed" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("interrupts a repeated call awaiting doom-loop permission without executing it", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt repeated permission" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-interrupt-repeat-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-interrupt-repeat-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["same", "same"])

      const asked = yield* Deferred.make<PermissionPolicy.AssertInput>()
      const held = yield* Deferred.make<void>()
      assertPermission = (input) => Deferred.succeed(asked, input).pipe(Effect.andThen(Deferred.await(held)))
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-interrupt-repeat-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const assertion = yield* Deferred.await(asked)
      expect(assertion.metadata?.repeatCount).toBe(3)
      expect(executions).toEqual(["same", "same"])

      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(executions).toEqual(["same", "same"])

      const messages = yield* session.context(sessionID)
      expect(messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "Provider turn interrupted" },
        content: [
          {
            type: "tool",
            id: "call-interrupt-repeat-3",
            state: {
              status: "error",
              error: { message: "Tool execution interrupted" },
            },
          },
        ],
      })

      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("resets the repeated-call streak after a new user prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First repeated task" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-reset-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-reset-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["same", "same"])

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue after user feedback" }),
        resume: false,
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-reset-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(permissionAssertions).toHaveLength(0)
      expect(executions).toEqual(["same", "same", "same"])
      expect(userTexts(requests[0]!)).toEqual(["First repeated task", "Continue after user feedback"])
    }),
  )

  it.effect("terminalizes a rejected repeated call and ignores later provider tool events", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Stop a repeated failure" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-reject-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-reject-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["same", "same"])

      requests.length = 0
      assertPermission = () => Effect.fail(new PermissionPolicy.RejectedError())
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-reject-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-reject-4",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      const calls = messages.flatMap((message) =>
        message.type === "assistant" ? message.content.flatMap((part) => (part.type === "tool" ? [part.id] : [])) : [],
      )
      expect(executions).toEqual(["same", "same"])
      expect(requests).toHaveLength(1)
      expect(permissionAssertions).toHaveLength(1)
      expect(calls).toEqual(["call-reject-1", "call-reject-2", "call-reject-3"])
      expect(messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "Repeated identical tool call rejected: echo" },
        content: [
          {
            type: "tool",
            id: "call-reject-3",
            state: {
              status: "error",
              error: {
                message: "Repeated identical tool call rejected: echo",
              },
            },
          },
        ],
      })

      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("cancels an in-flight tool before atomically terminalizing a rejected repeated call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Reject while an earlier repeated tool is still running",
        }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hung-doom-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["same"])

      requests.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      assertPermission = () =>
        Deferred.await(toolExecutionsStarted!).pipe(Effect.andThen(Effect.fail(new PermissionPolicy.RejectedError())))
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hung-doom-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-hung-doom-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-hung-doom-4",
            name: "echo",
            input: { text: "later" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID).pipe(Effect.timeout("2 seconds"))

      expect(activeToolExecutions).toBe(0)
      expect(executions).toEqual(["same", "same"])
      expect(requests).toHaveLength(1)
      expect(permissionAssertions).toHaveLength(1)
      const messages = yield* session.context(sessionID)
      const calls = messages.flatMap((message) =>
        message.type === "assistant" ? message.content.flatMap((part) => (part.type === "tool" ? [part.id] : [])) : [],
      )
      expect(calls).toEqual(["call-hung-doom-1", "call-hung-doom-2", "call-hung-doom-3"])
      expect(messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "Repeated identical tool call rejected: echo" },
        content: [
          {
            type: "tool",
            id: "call-hung-doom-2",
            state: {
              status: "error",
              error: {
                message: "Tool execution interrupted after turn rejection",
              },
            },
          },
          {
            type: "tool",
            id: "call-hung-doom-3",
            state: {
              status: "error",
              error: {
                message: "Repeated identical tool call rejected: echo",
              },
            },
          },
        ],
      })

      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("commits a blocked turn before propagating a concurrent stream interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Interrupt while terminalizing a repeated call",
        }),
        resume: false,
      })

      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-interrupt-doom-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)

      const flushEntered = yield* Deferred.make<void>()
      const releaseFlush = yield* Deferred.make<void>()
      let interceptFlush = true
      yield* events.project(SessionEvent.Text.Ended, (event) => {
        if (!interceptFlush || event.data.sessionID !== sessionID || event.data.textID !== "text-interrupt-doom")
          return Effect.void
        return Effect.sync(() => {
          interceptFlush = false
        }).pipe(Effect.andThen(Deferred.succeed(flushEntered, undefined)), Effect.andThen(Deferred.await(releaseFlush)))
      })

      requests.length = 0
      assertPermission = () => Effect.fail(new PermissionPolicy.RejectedError())
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-interrupt-doom" }),
          LLMEvent.textDelta({ id: "text-interrupt-doom", text: "partial" }),
          LLMEvent.toolCall({
            id: "call-interrupt-doom-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-interrupt-doom-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(flushEntered).pipe(Effect.timeout("2 seconds"))
      const interrupt = yield* session.interrupt(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseFlush, undefined)
      yield* Fiber.join(interrupt).pipe(Effect.timeout("2 seconds"))
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      const messages = yield* session.context(sessionID)
      const latest = messages.at(-1)
      expect(latest).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "Repeated identical tool call rejected: echo" },
        content: [
          { type: "text", id: "text-interrupt-doom", text: "partial" },
          { type: "tool", id: "call-interrupt-doom-2" },
          {
            type: "tool",
            id: "call-interrupt-doom-3",
            state: {
              status: "error",
              error: {
                message: "Repeated identical tool call rejected: echo",
              },
            },
          },
        ],
      })
      const activeCalls =
        latest?.type === "assistant"
          ? latest.content.filter(
              (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
            )
          : []
      expect(activeCalls).toEqual([])

      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("rolls back the whole rejected doom-loop terminal batch when the final projector fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Rollback a repeated failure" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-atomic-1",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-atomic-2",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["same", "same"])

      const defect = new Error("fail after step failure projection")
      const observedTerminalEvents = new Array<string>()
      yield* events.project(SessionEvent.Step.Failed, () => Effect.die(defect))
      yield* events.listen((event) =>
        event.type === SessionEvent.Tool.Failed.type || event.type === SessionEvent.Step.Failed.type
          ? Effect.sync(() => observedTerminalEvents.push(event.type))
          : Effect.void,
      )
      assertPermission = () => Effect.fail(new PermissionPolicy.RejectedError())
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-atomic-3",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.toolCall({
            id: "call-atomic-4",
            name: "echo",
            input: { text: "same" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)

      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const terminalTypes = new Set([
        EventBus.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.durable!.version),
        EventBus.versionedType(SessionEvent.Step.Failed.type, SessionEvent.Step.Failed.durable!.version),
      ])
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const assistant = (yield* session.context(sessionID)).findLast((message) => message.type === "assistant")

      expect(rows.filter((row) => terminalTypes.has(row.type))).toEqual([])
      expect(sequence?.seq).toBe(rows.at(-1)?.seq)
      expect(observedTerminalEvents).toEqual([])
      expect(assistant).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-atomic-3",
            state: { status: "running", input: { text: "same" } },
          },
        ],
      })
    }),
  )

  it.effect("does not record a shadow receipt when strict snapshots show no net change", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const comparisons: Snapshot.CompareInput[] = []
      compareSnapshots = (input) =>
        Effect.sync(() => {
          comparisons.push(input)
          return []
        })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Read without changing files" }),
        resume: false,
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-read-only",
            name: "echo",
            input: { text: "read" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-read-only", ["Done"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(comparisons).toContainEqual({
        from: stableSnapshot,
        to: stableSnapshot,
      })
      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("records missing from a strict scoped mutation that legacy ignore filtering misses", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const ids = ["turn-start", "turn-end"].map((id) => Snapshot.ID.make(id))
      const observationIDs = ["observation-start", "observation-end"].map((id) => Snapshot.ID.make(id))
      let legacyComparisons = 0
      let observationCaptures = 0
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () =>
        Effect.sync(() => {
          observationCaptures++
          return observationIDs.shift()
        })
      compareSnapshots = (input) =>
        Effect.sync(() => {
          if (input.from === "drain-start" && input.to === "drain-end") legacyComparisons++
          return []
        })
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Change a tracked file hidden by current ignore rules",
        }),
        resume: false,
      })
      response = fragmentFixture("text", "text-strict-missing", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(observationCaptures).toBe(2)
      expect(legacyComparisons).toBe(0)
      expect(ids).toHaveLength(0)
      expect(observationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "observation-end",
        verifier: null,
        verdict: "missing",
        reason: "No trusted verifier selected in shadow mode",
      })
    }),
  )

  it.effect("does not mix a strict scoped start with a legacy fallback end", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const ids = ["turn-start", "turn-end"].map((id) => Snapshot.ID.make(id))
      const observationIDs: Array<Snapshot.ID | undefined> = [Snapshot.ID.make("observation-start"), undefined]
      let legacyDrainComparisons = 0
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () => Effect.sync(() => observationIDs.shift())
      compareSnapshots = (input) =>
        Effect.sync(() => {
          if (input.from === "observation-start") legacyDrainComparisons++
          return [RelativePath.make("changed.ts")]
        })
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Change files while strict end capture is unavailable",
        }),
        resume: false,
      })
      response = fragmentFixture("text", "text-strict-end-unavailable", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      expect(ids).toHaveLength(0)
      expect(observationIDs).toHaveLength(0)
      expect(legacyDrainComparisons).toBe(0)
      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("triggers a pinned verifier from strict full-root boundary IDs after the model settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "runner-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "--filter", "@phins/core", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"a".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
        {
          kind: "signed-policy",
          authorityID: "runner-policy",
          keyID: `sha256:${"b".repeat(64)}`,
          revision: 7,
          policyDigest: `sha256:${"c".repeat(64)}`,
        },
      )
      let registryCalls = 0
      let captureCalls = 0
      let verificationCaptureCalls = 0
      let containmentCalls = 0
      let legacyDrainComparisons = 0
      selectTrustedVerifier = ({ projectID, projectRoot }) =>
        Effect.sync(() => {
          registryCalls++
          expect(projectID).toBe(ProjectRegistry.ID.global)
          expect(projectRoot).toBe(AbsolutePath.make("/project"))
          expect(requests).toHaveLength(registryCalls === 1 ? 0 : 1)
          return selection
        })
      const ids = ["turn-start", "turn-end"].map((id) => Snapshot.ID.make(id))
      const verificationIDs = ["verification-start", "drain-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () =>
        Effect.sync(() => {
          captureCalls++
          if (captureCalls === 1) {
            expect(registryCalls).toBe(1)
            expect(requests).toHaveLength(0)
          }
          return ids.shift()
        })
      captureVerificationSnapshot = () =>
        Effect.sync(() => {
          verificationCaptureCalls++
          return verificationIDs.shift()
        })
      compareSnapshots = (input) =>
        Effect.sync(() => {
          if (input.from === "drain-start" && input.to === "drain-end") legacyDrainComparisons++
          return []
        })
      executeContainedVerifier = (input) =>
        Effect.sync(() => {
          containmentCalls++
          expect(requests).toHaveLength(1)
          expect(input.selection).toEqual(selection)
          expect(Object.isFrozen(input.selection)).toBe(true)
          expect(input.subject.projectID).toBe(ProjectRegistry.ID.global)
          expect(input.subject.locationKey).toMatch(/^loc_[0-9a-f]{64}$/)
          expect(input.subject.snapshot).toBe(Snapshot.ID.make("drain-end"))
          return {
            executor: selection.plan.executor,
            subject: input.subject,
            status: "passed" as const,
            exitCode: 0,
            durationMs: 9,
            stdout: "ok",
            stderr: "",
            summary: "runner verifier passed",
            outputTruncated: false,
          }
        })
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change files and verify" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-verified", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(registryCalls).toBe(2)
      expect(containmentCalls).toBe(1)
      expect(captureCalls).toBe(2)
      expect(verificationCaptureCalls).toBe(3)
      expect(legacyDrainComparisons).toBe(0)
      expect(ids).toHaveLength(0)
      expect(verificationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verifier: selection.verifier,
        verdict: "passed",
        checks: [{ id: "unit", status: "passed", exitCode: 0 }],
      })
    }),
  )

  it.effect("fails closed when the complete verifier subject cannot be captured", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "strict-capture-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"d".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
        {
          kind: "signed-policy",
          authorityID: "strict-capture-policy",
          keyID: `sha256:${"e".repeat(64)}`,
          revision: 1,
          policyDigest: `sha256:${"f".repeat(64)}`,
        },
      )
      let registryCalls = 0
      let containmentCalls = 0
      selectTrustedVerifier = () =>
        Effect.sync(() => {
          registryCalls++
          return selection
        })
      executeContainedVerifier = () =>
        Effect.sync(() => {
          containmentCalls++
          throw new Error("verifier must not launch without an exact subject")
        })
      const ids: Array<Snapshot.ID | undefined> = [
        Snapshot.ID.make("turn-start"),
        Snapshot.ID.make("turn-end"),
        Snapshot.ID.make("drain-end"),
      ]
      const verificationIDs: Array<Snapshot.ID | undefined> = [Snapshot.ID.make("verification-start"), undefined]
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureVerificationSnapshot = () => Effect.sync(() => verificationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Change files when exact capture is unavailable",
        }),
        resume: false,
      })
      response = fragmentFixture("text", "text-strict-capture-unavailable", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(registryCalls).toBe(1)
      expect(containmentCalls).toBe(0)
      expect(ids).toHaveLength(0)
      expect(verificationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verifier: null,
        verdict: "missing",
        checks: [],
        reason: "Unable to capture complete verifier subject",
      })
    }),
  )

  it.effect("does not execute a verifier whose authorization expires during the drain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "expiring-runner-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"d".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
        {
          kind: "signed-policy",
          authorityID: "runner-policy",
          keyID: `sha256:${"e".repeat(64)}`,
          revision: 8,
          policyDigest: `sha256:${"f".repeat(64)}`,
        },
      )
      let registryCalls = 0
      let containmentCalls = 0
      selectTrustedVerifier = () => {
        registryCalls++
        return registryCalls === 1 ? Effect.succeed(selection) : Effect.die("signed verifier policy expired")
      }
      executeContainedVerifier = (input) =>
        Effect.sync(() => {
          containmentCalls++
          return {
            executor: selection.plan.executor,
            subject: input.subject,
            status: "passed" as const,
            exitCode: 0,
            durationMs: 1,
            outputTruncated: false,
          }
        })
      const ids = ["turn-start", "turn-end"].map((id) => Snapshot.ID.make(id))
      const verificationIDs = ["verification-start", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureVerificationSnapshot = () => Effect.sync(() => verificationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change files near policy expiry" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-expired-verifier", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(registryCalls).toBe(2)
      expect(containmentCalls).toBe(0)
      expect(ids).toHaveLength(0)
      expect(verificationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verifier: null,
        verdict: "missing",
        checks: [],
        reason: "Trusted verifier authorization was not valid at verification admission",
      })
    }),
  )

  it.effect("rejects a non-canonical registry selection before model execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "runner-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"a".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
      )
      selectTrustedVerifier = () =>
        Effect.succeed({
          ...selection,
          verifier: {
            ...selection.verifier,
            digest: `sha256:${"b".repeat(64)}`,
          },
        } as VerifierRegistry.Selection)
      let containmentCalls = 0
      executeContainedVerifier = (input) =>
        Effect.sync(() => {
          containmentCalls++
          return {
            executor: selection.plan.executor,
            subject: input.subject,
            status: "passed" as const,
            exitCode: 0,
            durationMs: 1,
            outputTruncated: false,
          }
        })
      const ids = ["drain-start", "turn-start", "turn-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      const observationIDs = ["observation-start", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () => Effect.sync(() => observationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Reject forged verifier" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-forged-verifier", ["Changed"]).completeEvents

      yield* session.resume(sessionID)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(requests).toHaveLength(1)
      expect(containmentCalls).toBe(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        verdict: "missing",
        verifier: null,
        checks: [],
        reason: "Trusted verifier registry returned a non-canonical selection",
      })
    }),
  )

  it.effect("records one terminal shadow receipt across continuation and queue", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "queue-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"c".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
      )
      let registryCalls = 0
      let containmentCalls = 0
      selectTrustedVerifier = () =>
        Effect.sync(() => {
          registryCalls++
          return selection
        })
      executeContainedVerifier = (input) =>
        Effect.sync(() => {
          containmentCalls++
          expect(requests).toHaveLength(3)
          expect(input.selection).toEqual(selection)
          expect(input.subject.snapshot).toBe(Snapshot.ID.make("drain-end"))
          return {
            executor: selection.plan.executor,
            subject: input.subject,
            status: "passed" as const,
            exitCode: 0,
            durationMs: 4,
            outputTruncated: false,
          }
        })
      const ids = [
        "drain-start",
        "turn-1-start",
        "turn-1-end",
        "turn-2-start",
        "turn-2-end",
        "turn-3-start",
        "turn-3-end",
        "drain-end",
      ].map((id) => Snapshot.ID.make(id))
      const verificationIDs = ["verification-start", "drain-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureVerificationSnapshot = () => Effect.sync(() => verificationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change files" }),
        resume: false,
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-change",
            name: "echo",
            input: { text: "change" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-change-final", ["Changed"]).completeEvents,
        fragmentFixture("text", "text-queue-final", ["Queued"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      const observedAfterRequests: number[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionEvent.VerificationRequested.type
          ? Effect.sync(() => observedAfterRequests.push(requests.length))
          : Effect.void,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queued follow-up" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      yield* unsubscribe

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      const finalAssistant = (yield* session.context(sessionID))
        .filter((message) => message.type === "assistant")
        .at(-1)
      expect(requests).toHaveLength(3)
      expect(observedAfterRequests).toEqual([3])
      expect(registryCalls).toBe(2)
      expect(containmentCalls).toBe(1)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        assistant_message_id: finalAssistant?.id,
        subject_snapshot: "drain-end",
        verifier: selection.verifier,
        verdict: "passed",
      })
    }),
  )

  it.effect("does not record mutate-then-revert as a net mutation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const ids = [
        "drain-boundary",
        "turn-1-start",
        "turn-1-mutated",
        "turn-2-start",
        "drain-boundary",
        "drain-boundary",
      ].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      compareSnapshots = (input) => Effect.succeed(input.from === input.to ? [] : [RelativePath.make("changed.ts")])
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change and restore files" }),
        resume: false,
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-change-revert",
            name: "echo",
            input: { text: "change then revert" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-reverted", ["Restored"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("does not invent a receipt when boundary snapshots are unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      captureSnapshot = () => Effect.succeed(undefined)
      captureObservationSnapshot = () => Effect.succeed(undefined)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change without snapshots" }),
        resume: false,
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-no-snapshot",
            name: "echo",
            input: { text: "change" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-no-snapshot", ["Done"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("does not invent a receipt when the legacy fallback comparison fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const ids = ["drain-start", "turn-start", "turn-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () => Effect.succeed(undefined)
      compareSnapshots = (input) =>
        input.from === "drain-start"
          ? Effect.fail(
              new Snapshot.Error({
                operation: "files",
                message: "comparison unavailable",
              }),
            )
          : Effect.succeed([])
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Observe an unavailable comparison" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-comparison-failed", ["Done"]).completeEvents

      yield* session.resume(sessionID)

      expect(yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("records a terminal receipt when the provider fails after a mutating tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const failure = providerUnavailable()
      const ids = ["turn-start"].map((id) => Snapshot.ID.make(id))
      const observationIDs = ["observation-start", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () => Effect.sync(() => observationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      executions.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Mutate before provider failure" }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-failure",
            name: "echo",
            input: { text: "mutate" },
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(executions).toEqual(["mutate"])
      expect(ids).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verdict: "missing",
      })
    }),
  )

  it.effect("preserves a provider failure when selected verification is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const failure = providerUnavailable()
      const selection = VerifierRegistry.pin(
        {
          id: "failure-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"d".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
      )
      selectTrustedVerifier = () => Effect.succeed(selection)
      executeContainedVerifier = () => Effect.interrupt
      const ids = ["turn-start"].map((id) => Snapshot.ID.make(id))
      const verificationIDs = ["verification-start", "drain-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureVerificationSnapshot = () => Effect.sync(() => verificationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      executions.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Mutate before provider and verifier failure",
        }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-double-failure",
            name: "echo",
            input: { text: "mutate" },
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(executions).toEqual(["mutate"])
      expect(ids).toHaveLength(0)
      expect(verificationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verdict: "error",
        reason: "Verifier containment execution was interrupted",
      })
    }),
  )

  it.effect("interrupts contained verification on external cancellation and settles before returning", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const selection = VerifierRegistry.pin(
        {
          id: "cancelled-verifier-tests",
          version: "1",
          source: "policy",
          check: {
            id: "unit",
            argv: ["pnpm", "test"],
            cwd: ".",
            timeoutMs: 120_000,
            maxOutputBytes: 16_384,
          },
          executor: {
            id: "sandbox-test-double",
            version: "1",
            bundleDigest: `sha256:${"a".repeat(64)}`,
          },
          containment: {
            subject: "snapshot-copy",
            filesystem: "read-only",
            network: "network-deny",
            environment: "sanitized-env",
          },
        },
        {
          projectID: ProjectRegistry.ID.global,
          projectRoot: AbsolutePath.make("/project"),
        },
        {
          kind: "signed-policy",
          authorityID: "runner-policy",
          keyID: `sha256:${"b".repeat(64)}`,
          revision: 9,
          policyDigest: `sha256:${"c".repeat(64)}`,
        },
      )
      const verificationStarted = yield* Deferred.make<void>()
      let registryCalls = 0
      selectTrustedVerifier = () =>
        Effect.sync(() => {
          registryCalls++
          return selection
        })
      executeContainedVerifier = () =>
        Deferred.succeed(verificationStarted, undefined).pipe(Effect.andThen(Effect.never))
      const ids = ["turn-start", "turn-end"].map((id) => Snapshot.ID.make(id))
      const verificationIDs = ["verification-start", "drain-end", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureVerificationSnapshot = () => Effect.sync(() => verificationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Change files before verifier cancellation",
        }),
        resume: false,
      })
      response = fragmentFixture("text", "text-cancelled-verifier", ["Changed"]).completeEvents

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(verificationStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(registryCalls).toBe(2)
      expect(ids).toHaveLength(0)
      expect(verificationIDs).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verifier: selection.verifier,
        verdict: "error",
        reason: "Verifier containment execution was interrupted",
      })
    }),
  )

  it.effect("records a terminal receipt before propagating interruption after mutation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      const ids = ["turn-start"].map((id) => Snapshot.ID.make(id))
      const observationIDs = ["observation-start", "drain-end"].map((id) => Snapshot.ID.make(id))
      captureSnapshot = () => Effect.sync(() => ids.shift())
      captureObservationSnapshot = () => Effect.sync(() => observationIDs.shift())
      compareSnapshots = (input) =>
        Effect.succeed(
          input.from === "drain-start" && input.to === "drain-end" ? [RelativePath.make("changed.ts")] : [],
        )
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      requests.length = 0
      executions.length = 0
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Mutate before interruption" }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-interrupt",
            name: "echo",
            input: { text: "mutate" },
          }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)

      const receipts = yield* db.select().from(VerificationReceiptTable).all().pipe(Effect.orDie)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(executions).toEqual(["mutate"])
      expect(ids).toHaveLength(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        subject_snapshot: "drain-end",
        verdict: "missing",
      })
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Echo this" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-echo",
            name: "echo",
            input: { text: "hello" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: {
          id: CatalogModel.ID.make("replacement"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Think first" }),
        resume: false,
      })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({
          id: "reasoning-anthropic",
          text: "Signed thought",
        }),
        LLMEvent.reasoningEnd({
          id: "reasoning-anthropic",
          providerMetadata: { anthropic: { signature: "sig_1" } },
        }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: {
            openai: { itemId: "rs_1", reasoningEncryptedContent: null },
          },
        }),
        LLMEvent.reasoningDelta({
          id: "reasoning-openai",
          text: "Encrypted thought",
        }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "encrypted-state",
            },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Signed thought",
              providerMetadata: { anthropic: { signature: "sig_1" } },
            },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: {
                openai: {
                  itemId: "rs_1",
                  reasoningEncryptedContent: "encrypted-state",
                },
              },
            },
          ],
        },
      ])

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        {
          type: "reasoning",
          text: "Signed thought",
          providerMetadata: { anthropic: { signature: "sig_1" } },
        },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "encrypted-state",
            },
          },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Search first" }),
        resume: false,
      })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: {
            anthropic: { blockType: "web_search_tool_result" },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue" }),
        resume: false,
      })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: {
            anthropic: { blockType: "web_search_tool_result" },
          },
        },
      ])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Echo five times" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({
            id: `call-echo-${index}`,
            name: "echo",
            input: { text: `${index}` },
          }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("allows repeated provider-local call IDs when their inputs differ", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Echo three distinct values" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "tool_0",
            name: "echo",
            input: { text: "first" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "tool_0",
            name: "echo",
            input: { text: "second" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "tool_0",
            name: "echo",
            input: { text: "third" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second", "third"])
      expect(requests).toHaveLength(4)
      expect(permissionAssertions).toHaveLength(0)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo three distinct values" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "first" },
                content: [{ type: "text", text: "first" }],
              },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "third" },
                content: [{ type: "text", text: "third" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo three distinct values" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "first" },
                content: [{ type: "text", text: "first" }],
              },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "third" },
                content: [{ type: "text", text: "third" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run once" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", id: "text-once", text: "Once" }],
        },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Change direction" }),
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-echo",
            name: "echo",
            input: { text: "hello" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt current work" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt current work" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue first" }),
        delivery: "queue",
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue second" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start steering" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue first" }),
        delivery: "queue",
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue second" }),
        delivery: "queue",
      })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer before next queued input" }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Also steer before next queued input" }),
      })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "First steer" }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Second steer" }),
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Start working" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover with this" }),
      })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* (yield* SessionExecution.Service).awaitIdle

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: {
          id: CatalogModel.ID.make("fake-model"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution interrupted",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: {
          id: CatalogModel.ID.make("fake-model"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: {
          executed: true,
          metadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        {
          type: "tool-result",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          result: { type: "error" },
        },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: {
          id: CatalogModel.ID.make("fake-model"),
          providerID: CatalogProvider.ID.make("fake"),
        },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-pending-interrupted",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover promoted input" }),
        resume: false,
      })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run first" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherSessionID,
        prompt: Prompt.make({ text: "Run second" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      streamStarted = yield* Deferred.make<void>()
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionManager.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionManager.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Retry after failure" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Call missing" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: {
                status: "error",
                error: { message: "Unknown tool: missing" },
              },
            },
          ],
        },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", id: "text-after-error", text: "Recovered" }],
        },
      ])
    }),
  )

  it.effect("propagates unexpected local tool defects operationally", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Call defect" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe("unexpected tool defect")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution failed: unexpected tool defect",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("cancels sibling tools before publishing a tool-defect terminal batch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Cancel sibling after defect" }),
        resume: false,
      })

      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      let activeAtStepFailure = -1
      yield* events.listen((event) =>
        event.type === SessionEvent.Step.Failed.type
          ? Effect.sync(() => {
              activeAtStepFailure = activeToolExecutions
            })
          : Effect.void,
      )
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-blocked-sibling",
            name: "echo",
            input: { text: "blocked" },
          }),
        ]),
        Stream.unwrap(
          Deferred.await(toolExecutionsStarted).pipe(
            Effect.as(
              Stream.fromIterable([
                LLMEvent.toolCall({
                  id: "call-defect-sibling",
                  name: "defect",
                  input: {},
                }),
                LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                LLMEvent.finish({ reason: "tool-calls" }),
              ]),
            ),
          ),
        ),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe("unexpected tool defect")
      expect(activeToolExecutions).toBe(0)
      expect(activeAtStepFailure).toBe(0)
      toolExecutionGate = undefined
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Cancel sibling after defect" },
        {
          type: "assistant",
          finish: "error",
          content: [
            {
              type: "tool",
              id: "call-blocked-sibling",
              state: { status: "error" },
            },
            {
              type: "tool",
              id: "call-defect-sibling",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* UserQuestions.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Ask then stop" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-question",
            name: "question",
            input: {},
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "Provider turn interrupted" },
          content: [
            {
              type: "tool",
              id: "call-question",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution interrupted",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("cancels a blocked local tool before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Cancel before failing" }),
        resume: false,
      })
      const failure = providerUnavailable()
      const executionCount = executions.length
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-failure",
            name: "echo",
            input: { text: "blocked" },
          }),
        ]),
        Stream.unwrap(Deferred.await(toolExecutionsStarted).pipe(Effect.as(Stream.fail(failure)))),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.timeout("2 seconds"), Effect.flip)).toBe(failure)
      expect(activeToolExecutions).toBe(0)
      expect(executions.slice(executionCount)).toEqual(["blocked"])
      toolExecutionGate = undefined

      const messages = yield* session.context(sessionID)
      expect(messages).toMatchObject([
        { type: "user", text: "Cancel before failing" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [
            {
              type: "tool",
              id: "call-before-failure",
              state: {
                status: "error",
                error: {
                  message: "Tool execution interrupted after provider failure: Provider unavailable",
                },
              },
            },
          ],
        },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt blocked tool" }),
        resume: false,
      })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-interrupt",
            name: "echo",
            input: { text: "blocked" },
          }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution interrupted",
                },
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error" },
            },
          ],
        },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt provider" }),
        resume: false,
      })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt tool settlement" }),
        resume: false,
      })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-await-interrupt",
          name: "echo",
          input: { text: "blocked" },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution interrupted",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues tool execution without a fixed agent step cap", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run every required tool" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        ...Array.from({ length: 13 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: `call-unbounded-${index}`,
            name: "echo",
            input: { text: String(index) },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(14)
      expect(requests.every((request) => request.toolChoice === undefined)).toBe(true)
      expect(requests.every((request) => request.tools.length > 0)).toBe(true)
      expect(executions).toEqual(Array.from({ length: 13 }, (_, index) => String(index)))
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail durably" }),
        resume: false,
      })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
        },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail before step" }),
        resume: false,
      })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
        },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail after output" }),
        resume: false,
      })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({
          message: "prompt too long",
          classification: "context-overflow",
        }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail raw stream durably" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
        },
      ])
    }),
  )

  it.effect("preserves the provider cause when atomic terminal projection also fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const providerFailure = providerUnavailable()
      const projectorDefect = new Error("terminal projector failed")
      yield* events.project(SessionEvent.Step.Failed, () => Effect.die(projectorDefect))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Preserve both terminal causes" }),
        resume: false,
      })
      responseStream = Stream.fail(providerFailure)

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      expect(exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === providerFailure)).toBe(
        true,
      )
      expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === projectorDefect)).toBe(
        true,
      )
    }),
  )

  it.effect("rolls back every provider-error terminal event when the final projector fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      const events = yield* EventBus.Service
      const { db } = yield* Database.Service
      const defect = new Error("fail provider-error terminal projection")
      const observedTerminalEvents = new Array<string>()
      yield* events.project(SessionEvent.Step.Failed, () => Effect.die(defect))
      yield* events.listen((event) =>
        event.type === SessionEvent.Tool.Failed.type || event.type === SessionEvent.Step.Failed.type
          ? Effect.sync(() => observedTerminalEvents.push(event.type))
          : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Rollback provider failure" }),
        resume: false,
      })

      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 2
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-provider-atomic-1",
            name: "echo",
            input: { text: "one" },
          }),
          LLMEvent.toolCall({
            id: "call-provider-atomic-2",
            name: "echo",
            input: { text: "two" },
          }),
        ]),
        Stream.unwrap(
          Deferred.await(toolExecutionsStarted).pipe(
            Effect.as(
              Stream.make(LLMEvent.providerError({ message: "Provider unavailable" })).pipe(
                Stream.concat(Stream.never),
              ),
            ),
          ),
        ),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      expect(activeToolExecutions).toBe(0)
      toolExecutionGate = undefined

      const terminalTypes = new Set([
        EventBus.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.durable!.version),
        EventBus.versionedType(SessionEvent.Step.Failed.type, SessionEvent.Step.Failed.durable!.version),
      ])
      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const assistant = (yield* session.context(sessionID)).findLast((message) => message.type === "assistant")

      expect(rows.filter((row) => terminalTypes.has(row.type))).toEqual([])
      expect(sequence?.seq).toBe(rows.at(-1)?.seq)
      expect(observedTerminalEvents).toEqual([])
      expect(assistant).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-provider-atomic-1",
            state: { status: "running" },
          },
          {
            type: "tool",
            id: "call-provider-atomic-2",
            state: { status: "running" },
          },
        ],
      })
    }),
  )

  it.effect("cancels a blocked local tool after a provider error event", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-before-provider-error",
            name: "echo",
            input: { text: "blocked" },
          }),
        ]),
        Stream.unwrap(
          Deferred.await(toolExecutionsStarted).pipe(
            Effect.as(
              Stream.make(LLMEvent.providerError({ message: "Provider unavailable" })).pipe(
                Stream.concat(Stream.never),
              ),
            ),
          ),
        ),
      )

      yield* session.resume(sessionID).pipe(Effect.timeout("2 seconds"))

      expect(activeToolExecutions).toBe(0)
      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["blocked"])
      toolExecutionGate = undefined
      const messages = yield* session.context(sessionID)
      expect(messages).toMatchObject([
        { type: "user", text: "Do not continue failed provider" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [
            {
              type: "tool",
              id: "call-before-provider-error",
              state: {
                status: "error",
                error: {
                  message: "Tool execution interrupted after provider failure: Provider unavailable",
                },
              },
            },
          ],
        },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool durably" }),
        resume: false,
      })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "Provider unavailable" },
          content: [
            {
              type: "tool",
              id: "call-hosted-provider-error",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool at EOF" }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        {
          type: "assistant",
          finish: "error",
          error: {
            message: "Provider stream ended without a step settlement",
          },
          content: [
            {
              type: "tool",
              id: "call-hosted-eof",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [
            {
              type: "tool",
              id: "call-hosted-raw-failure",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Two blocks" }),
        resume: false,
      })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Call provider tool" }),
        resume: false,
      })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({
          id: "call-parsed",
          name: "web_search",
          text: '{"query":"hello"}',
        }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({
          id: "call-parsed",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-parsed",
              state: { status: "error", input: { query: "hello" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionManager.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      const defect = "Tool input delta before start: call-1"
      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      const messages = yield* session.context(sessionID)
      expect(messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "Provider stream failed unexpectedly" },
      })
      expect(JSON.stringify(messages)).not.toContain(defect)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject(messages)
    }),
  )
})
