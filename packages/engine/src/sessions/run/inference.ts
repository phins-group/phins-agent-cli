/**
 * Durable LLM runner của Core session V2.
 *
 * Luồng F2-F7/7: đọc work/history, dựng context epoch và tool definitions,
 * stream một provider turn, persist events, settle tool rồi chạy continuation.
 * @module
 */
import { ToolAdmission } from "../../tools/admission"
import * as CodingWorkflow from "./coding-workflow"
import * as LocalVerification from "../../verification/local"
import * as LocalPolicy from "../../security/launcher-policy"
import { ProcessRunner } from "../../execution/process/runner"
import path from "node:path"
import { selectContext } from "../context/selection"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  LLMRequest,
  HttpOptions,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolResultValue,
} from "../../inference/api"
import { ExecutionBoundary, RequestExecutor } from "../../inference/request/api"
import { and, desc, eq } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Exit, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { isDeepStrictEqual } from "node:util"
import { AgentRegistry } from "../../agents/registry"
import { Config } from "../../settings/config"
import { Database } from "../../storage/database"
import { EventBus } from "../../runtime/events/bus"
import { EventSequenceTable } from "../../storage/tables/events"
import { Location } from "../../workspace/location"
import { CatalogModel } from "../../inference/catalog/model"
import { PermissionPolicy } from "../../security/permissions/service"
import { CatalogProvider } from "../../inference/catalog/provider"
import { UserQuestions } from "../../agents/questions"
import { SystemContext } from "../../agents/context/system"
import { SystemContextRegistry } from "../../agents/context/registry"
import { SkillGuidance } from "../../agents/skills/guidance"
import { ReferenceGuidance } from "../../agents/references/guidance"
import { ToolRegistry } from "../../tools/registry"
import { ToolOutputStore } from "../../tools/output-store"
import { VerifierContainment } from "../../verification/containment"
import { VerifierRegistry } from "../../verification/registry"
import { VerifierSettlementAdmission } from "../../verification/settlement-admission"
import { VerificationSettlementPublisher } from "../../runtime/events/verification-publisher"
import { SessionContextEpoch } from "../context/epoch"
import { SessionCompaction } from "../context/compaction"
import { SessionEvent } from "../../contracts/events/session"
import { SessionHistory } from "../messages/history"
import { SessionInput } from "../input/inbox"
import { SessionInputOrigin } from "../input/origin"
import * as SessionInputTurns from "../input/turns"
import { SessionMessage } from "../messages/service"
import { Session as SessionSchema } from "../../contracts/session/info"
import { SessionMessageTable, SessionTable } from "../../storage/tables/sessions"
import { SessionStore } from "../store"
import { SessionRunState } from "./state"
import { SessionVerification } from "../verification/service"
import { type RunError, Service } from "./loop"
import { SessionRunnerModel } from "./model"
import { boundedTerminalMessage, createLLMEventPublisher, MAX_TOOL_CALLS_PER_TURN } from "./events"
import { toLLMMessages } from "./messages"
import { Snapshot } from "../../workspace/repository/snapshot"
import { PermissionOrigin } from "../../security/permissions/origin"
import * as Delegation from "../../security/permissions/delegation"
import { NodeCommandRunner } from "../../execution/commands/runner"
import * as CommandProvider from "../../execution/commands/provider"
import { restoreContinuation } from "../../execution/control/restoration"
import * as RunBudget from "./budget"

const WORKSPACE_PROXY_ROUTE_PATH = /\/v2\/llm(?:\/|$)/
const SECURITY_SIGNAL_PATTERN = /\b(security|vulnerab|exploit|secret|credential|token|auth|permission)\b/i
const DOOM_LOOP_THRESHOLD = 3

type DoomLoopTail = {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly count: number
}

const normalizedToolInput = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const advanceDoomLoopTail = (
  tail: DoomLoopTail | undefined,
  input: {
    readonly name: string
    readonly value: unknown
    readonly local: boolean
  },
): DoomLoopTail | undefined => {
  if (!input.local) return undefined
  const value = normalizedToolInput(input.value)
  if (tail?.name === input.name && isDeepStrictEqual(tail.input, value))
    return { name: input.name, input: value, count: tail.count + 1 }
  return { name: input.name, input: value, count: 1 }
}

/** Rebuild the local-call tail from durable projected history after resume/replay. */
const doomLoopTailFromHistory = (messages: ReadonlyArray<SessionMessage.Message>) => {
  let tail: DoomLoopTail | undefined
  for (const message of messages) {
    if (message.type === "user" || message.type === "compaction") {
      tail = undefined
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (part.state.status === "pending" || part.provider?.executed === true) {
        tail = undefined
        continue
      }
      tail = advanceDoomLoopTail(tail, {
        name: part.name,
        value: part.state.input,
        local: true,
      })
    }
  }
  return tail
}

type VerifierObservation = {
  readonly selection?: VerifierRegistry.Selection
  readonly reason?: SessionVerification.MissingReason
}

type VerificationBoundaryProfile = "verification" | "observation" | "legacy"

const isWorkspaceProxyRequest = (request: LLMRequest) => {
  const baseURL = request.model.route.endpoint.baseURL
  if (!baseURL) return false
  try {
    return WORKSPACE_PROXY_ROUTE_PATH.test(new URL(baseURL).pathname)
  } catch {
    return WORKSPACE_PROXY_ROUTE_PATH.test(baseURL)
  }
}

const requestText = (request: LLMRequest) => {
  try {
    return JSON.stringify({
      system: request.system,
      messages: request.messages,
    })
  } catch {
    return ""
  }
}

const estimateRequestTokens = (request: LLMRequest) => {
  try {
    return Math.max(
      1,
      Math.ceil(
        JSON.stringify({
          system: request.system,
          messages: request.messages,
          tools: request.tools,
        }).length / 4,
      ),
    )
  } catch {
    return undefined
  }
}

const inferWorkspaceRoutingPhase = (input: { readonly agent: AgentRegistry.Selection; readonly toolCount: number }) => {
  const name = `${input.agent.id} ${input.agent.info?.mode ?? ""} ${input.agent.info?.system ?? ""}`.toLowerCase()
  if (name.includes("compact")) return "compact"
  if (name.includes("security")) return "security"
  if (name.includes("audit")) return "audit"
  if (name.includes("review")) return "review"
  if (name.includes("plan")) return "plan"
  if (input.toolCount > 0) return "code"
  return "chat"
}

const withWorkspaceRoutingMetadata = (
  request: LLMRequest,
  input: {
    readonly session: SessionSchema.Info
    readonly agent: AgentRegistry.Selection
    readonly contextSize: number
    readonly toolCount: number
  },
) => {
  if (!isWorkspaceProxyRequest(request)) return request
  const phase = inferWorkspaceRoutingPhase({
    agent: input.agent,
    toolCount: input.toolCount,
  })
  const contextEstimateTokens = estimateRequestTokens(request)
  const securitySensitive = SECURITY_SIGNAL_PATTERN.test(requestText(request))
  const routing = {
    phase,
    agent: String(input.agent.id),
    agentMode: input.agent.info?.mode,
    taskSignals: {
      messageCount: input.contextSize,
      toolCount: input.toolCount,
      contextEstimateTokens,
      securitySensitive,
    },
    policyHints: {
      requireTools: input.toolCount > 0,
      requireLargeContext: typeof contextEstimateTokens === "number" && contextEstimateTokens >= 48_000,
      deepAudit: phase === "audit" || phase === "review" || phase === "security",
    },
  }
  return LLMRequest.update(request, {
    metadata: {
      ...request.metadata,
      phins: {
        ...(request.metadata?.phins && typeof request.metadata.phins === "object" ? request.metadata.phins : {}),
        ...routing,
        sessionId: input.session.id,
      },
    },
    http: new HttpOptions({
      body: {
        ...request.http?.body,
        metadata: {
          ...(request.http?.body?.metadata && typeof request.http.body.metadata === "object"
            ? request.http.body.metadata
            : {}),
          phins: routing,
        },
        phase: routing.phase,
        taskSignals: routing.taskSignals,
        policyHints: routing.policyHints,
        sessionId: input.session.id,
      },
      headers: request.http?.headers,
      query: request.http?.query,
    }),
  })
}

/**
 * Local drains and native commands share turns, tools and durable settlement.
 * Local drains may promote queued/steered inputs; a native run stays bound to
 * one authenticated input/run and rechecks its ceiling at effect boundaries.
 * Client detach never owns interruption. Transport retries are acquisition-only;
 * uncertain tool side effects are terminalized, never automatically replayed.
 * Capability qualification and consumer cutover are tracked in node-service.md.
 */

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* EventBus.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentRegistry.Service
    const tools = yield* ToolRegistry.Service
    const permission = yield* PermissionPolicy.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const verifierRegistry = yield* VerifierRegistry.Registry
    const verifierContainment = yield* VerifierContainment.Service
    const appProcess = Option.getOrUndefined(yield* Effect.serviceOption(ProcessRunner.Service))
    const verificationSettlements = yield* VerificationSettlementPublisher.Service
    const verifierSettlementAdmission = Option.getOrUndefined(
      yield* Effect.serviceOption(VerifierSettlementAdmission.Service),
    )
    const db = (yield* Database.Service).db
    const verifierRoot = SessionVerification.selectionRoot(location)
    // Private, fiber-local authority: public local resume never enters it.
    const NativeOwner = Context.Reference<
      { readonly target: NodeCommandRunner.Target; readonly check: Effect.Effect<void> } | undefined
    >("@phins/SessionRunner/NativeOwner", { defaultValue: () => undefined })
    const checkNative = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, runID: SessionRunState.ID) {
      const owner = yield* NativeOwner
      if (!owner) return
      if (owner.target.sessionID !== sessionID || owner.target.runID !== runID)
        return yield* Effect.die(new SessionInputOrigin.UnavailableError({ sessionID }))
      yield* owner.check
    })
    const authorizeTurn = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, runID: SessionRunState.ID) {
      if (yield* NativeOwner) return yield* checkNative(sessionID, runID)
      yield* SessionInputOrigin.requireLocalRun(db, sessionID)
    })
    const compaction = SessionCompaction.make({
      events,
      llm: {
        stream: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const owner = yield* NativeOwner
              const budget = yield* RunBudget.Active
              yield* Effect.sync(() => budget?.attempt(request))
              if (owner) {
                yield* owner.check
                yield* CommandProvider.check(owner.target.sessionID, request).pipe(Effect.orDie)
              }
              return llm.stream(request).pipe(Stream.tap((event) => Effect.sync(() => budget?.observe(event))))
            }),
          ),
      },
      config: yield* config.entries(),
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const prepareIndependentCheck = Effect.fn("SessionRunner.prepareIndependentCheck")(function* (
      sessionID: SessionSchema.ID,
      checkOwner: Effect.Effect<void>,
    ) {
      if (!LocalVerification.enabled) return undefined
      if (process.platform !== "darwin")
        return yield* Effect.die(new Error("Independent local checks are qualified only on macOS"))
      yield* checkOwner
      const startSnapshot = yield* snapshots.captureVerification()
      if (!startSnapshot) return yield* Effect.die(new Error("Independent checks require a capturable Git repository"))
      const rootIdentity = yield* VerifierRegistry.inspectProjectRoot(verifierRoot).pipe(Effect.orDie)
      const commands = LocalPolicy.commands()
      const selection = LocalVerification.select(location, commands)
      return Effect.gen(function* () {
        yield* checkOwner
        const workflow = yield* CodingWorkflow.Active
        yield* Effect.sync(() => workflow?.finish())
        const endSnapshot = yield* snapshots.captureVerification()
        if (!endSnapshot) return yield* Effect.die(new Error("Independent check snapshot is unavailable"))
        if (startSnapshot === endSnapshot) return
        const changed = yield* snapshots.files({ from: startSnapshot, to: endSnapshot }).pipe(Effect.orDie)
        const protectedPaths = LocalPolicy.protectedPaths(location.project.directory)
        if (changed.some((file) => protectedPaths.some((protectedPath) =>
          LocalPolicy.inside(protectedPath, path.resolve(location.project.directory, file)))))
          return yield* Effect.die(new Error("Protected verification input changed during the task"))
        const session = yield* getSession(sessionID)
        const agent = yield* agents.select(session.agent)
        // Launcher selection never expands the current owner's command grants.
        const authorize = Effect.gen(function* () {
          yield* checkOwner
          yield* VerifierRegistry.revalidateProjectRoot(rootIdentity)
          for (const command of commands)
            yield* permission.assert({ action: "bash", resources: [command], sessionID, agent: agent.id,
              metadata: { purpose: "independent-verification" } })
          yield* checkOwner
        })
        if (!appProcess) return yield* Effect.die(new Error("Independent check process executor is unavailable"))
        const containment = LocalVerification.make({ selection, snapshots, process: appProcess, authorize })
        const recorded = yield* SessionVerification.record(db, events, {
          sessionID, location, snapshot: endSnapshot, selection, containment,
          captureSnapshot: snapshots.captureVerification,
        }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, verificationSettlements))
        if (recorded?.verdict !== "passed")
          return yield* Effect.die(new Error(`Independent checks did not pass: ${recorded?.verdict ?? "unavailable"}`))
      })
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      let batch = new Array<EventBus.PublishBatchItem>()
      const flush = Effect.fnUntraced(function* () {
        if (batch.length === 0) return
        yield* events.publishBatch(batch)
        batch = []
      })
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          batch.push({
            definition: SessionEvent.Tool.Failed,
            data: {
              sessionID,
              timestamp: yield* DateTime.now,
              assistantMessageID: message.id,
              callID: tool.id,
              error: { type: "unknown", message: "Tool execution interrupted" },
              provider: { executed: tool.provider?.executed === true },
            },
          })
          if (batch.length === EventBus.MAX_ATOMIC_BATCH_EVENTS) yield* flush()
        }
      }
      yield* flush()
    })

    const observeVerification = Effect.fn("SessionRunner.observeVerification")(function* (
      sessionID: SessionSchema.ID,
      profile: VerificationBoundaryProfile,
      startSnapshot: Snapshot.ID | undefined,
      endSnapshot: Snapshot.ID | undefined,
      verifier: VerifierObservation,
      fallbackEndSnapshot: Snapshot.ID | undefined,
    ) {
      let observationSnapshot = endSnapshot ?? fallbackEndSnapshot
      let admittedVerifier = verifier
      if (profile === "verification") {
        if (!startSnapshot || !endSnapshot) {
          admittedVerifier = {
            reason: "Unable to capture complete verifier subject",
          }
        } else {
          // Exact full-root tree IDs are content-addressed. Comparing the IDs
          // directly avoids every legacy location/ignore/diff configuration.
          if (startSnapshot === endSnapshot) return
          admittedVerifier = yield* revalidateVerifier(verifier)
        }
      } else if (profile === "observation") {
        if (!startSnapshot || !endSnapshot) {
          yield* Effect.logWarning("Strict verification observation unavailable", {
            reason: !startSnapshot ? "strict-location-start-unavailable" : "strict-location-end-unavailable",
            sessionID,
          })
          return
        }
        // These trees contain only the active Location, so direct identity
        // comparison detects cross-boundary renames without observing siblings.
        if (startSnapshot === endSnapshot) return
      } else {
        if (!startSnapshot || !endSnapshot) {
          yield* Effect.logWarning("Verification shadow observation unavailable", {
            reason: !startSnapshot ? "drain-start-snapshot-unavailable" : "drain-end-snapshot-unavailable",
            sessionID,
          })
          return undefined
        }
        const files = yield* snapshots.files({ from: startSnapshot, to: endSnapshot }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Verification shadow observation unavailable", {
              cause,
              reason: "snapshot-comparison-failed",
              sessionID,
            }).pipe(Effect.as(undefined)),
          ),
        )
        if (!files || files.length === 0) return
      }
      if (!observationSnapshot) {
        yield* Effect.logWarning("Verification shadow observation unavailable", {
          reason: "drain-end-subject-unavailable",
          sessionID,
        })
        return
      }
      const assistant = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      yield* SessionVerification.record(db, events, {
        sessionID,
        location,
        snapshot: observationSnapshot,
        assistantMessageID: assistant?.id,
        selection: admittedVerifier.selection,
        reason: admittedVerifier.reason,
        containment: verifierContainment,
        captureSnapshot: snapshots.captureVerification,
        ...(verifierSettlementAdmission ? { settlementAdmission: verifierSettlementAdmission } : {}),
      }).pipe(Effect.provideService(VerificationSettlementPublisher.Service, verificationSettlements))
    })

    const selectVerifier = Effect.fn("SessionRunner.selectVerifier")(function* () {
      const selected = yield* Effect.suspend(() =>
        verifierRegistry.select({
          projectID: location.project.id,
          projectRoot: verifierRoot,
        }),
      ).pipe(Effect.exit)
      if (selected._tag === "Failure") {
        if (Cause.hasInterrupts(selected.cause)) return yield* Effect.failCause(selected.cause)
        yield* Effect.logError("Trusted verifier selection failed", {
          projectID: location.project.id,
        })
        return {
          reason: "Trusted verifier registry selection failed",
        } satisfies VerifierObservation
      }
      const selection = selected.value
      if (!selection) return {} satisfies VerifierObservation

      const canonical = yield* Effect.gen(function* () {
        const identity = selection.projectRootIdentity
        if (identity) {
          const current = yield* VerifierRegistry.inspectProjectRoot(verifierRoot)
          if (!isDeepStrictEqual(current, identity))
            return yield* Effect.fail(
              new VerifierRegistry.ProjectRootIdentityError(
                "Trusted verifier project root identity changed during selection",
              ),
            )
        }
        return VerifierRegistry.pin(
          selection.plan,
          {
            projectID: location.project.id,
            projectRoot: identity ? selection.projectRoot : verifierRoot,
            ...(identity ? { projectRootIdentity: identity } : {}),
          },
          selection.verifier.provenance,
        )
      }).pipe(Effect.exit)
      if (canonical._tag === "Failure" || !isDeepStrictEqual(canonical.value, selection)) {
        yield* Effect.logError("Trusted verifier registry returned a non-canonical selection", {
          projectID: location.project.id,
        })
        return {
          reason: "Trusted verifier registry returned a non-canonical selection",
        } satisfies VerifierObservation
      }
      return { selection: canonical.value } satisfies VerifierObservation
    })

    const revalidateVerifier = Effect.fn("SessionRunner.revalidateVerifier")(function* (verifier: VerifierObservation) {
      if (!verifier.selection) return verifier
      const selected = yield* Effect.suspend(() =>
        verifierRegistry.select({
          projectID: location.project.id,
          projectRoot: verifierRoot,
        }),
      ).pipe(Effect.exit)
      if (selected._tag === "Failure") {
        if (Cause.hasInterrupts(selected.cause)) return yield* Effect.failCause(selected.cause)
        yield* Effect.logError("Trusted verifier authorization revalidation failed", {
          projectID: location.project.id,
        })
        return {
          reason: "Trusted verifier authorization was not valid at verification admission",
        } satisfies VerifierObservation
      }
      if (!selected.value || !isDeepStrictEqual(selected.value, verifier.selection)) {
        yield* Effect.logError("Trusted verifier authorization changed before verification admission", {
          projectID: location.project.id,
        })
        return {
          reason: "Trusted verifier authorization was not valid at verification admission",
        } satisfies VerifierObservation
      }
      return verifier
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejectedOnly = (cause: Cause.Cause<unknown>) =>
      cause.reasons.length > 0 &&
      cause.reasons.every((reason) => Cause.isDieReason(reason) && reason.defect instanceof UserQuestions.RejectedError)

    const failAfterTerminalization = <E, E2, R>(
      sourceCause: Cause.Cause<E>,
      terminalization: Effect.Effect<unknown, E2, R>,
    ) =>
      terminalization.pipe(
        Effect.exit,
        Effect.flatMap((terminal) =>
          Effect.failCause(terminal._tag === "Failure" ? Cause.combine(sourceCause, terminal.cause) : sourceCause),
        ),
      )

    const retryError = (error: LLMError): SessionEvent.RetryError => {
      const reason = error.reason
      const http = "http" in reason ? reason.http : undefined
      const statusCode =
        http?.response?.status ?? ("status" in reason && typeof reason.status === "number" ? reason.status : undefined)
      const metadata = {
        ...(http?.requestId === undefined ? {} : { requestId: http.requestId }),
        ...(http?.bodyTruncated === true ? { responseBodyTruncated: "true" } : {}),
      }
      return {
        message: boundedTerminalMessage(reason.message),
        isRetryable: error.retryable,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(http?.response === undefined ? {} : { responseHeaders: { ...http.response.headers } }),
        ...(http?.body === undefined ? {} : { responseBody: boundedTerminalMessage(http.body) }),
        ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      }
    }

    const terminalFailure = (cause: Cause.Cause<unknown>): SessionRunState.TerminalFailureOutcome => {
      const failure = Cause.squash(cause)
      return {
        type: "terminal-failure",
        error: {
          type: "unknown",
          message: boundedTerminalMessage(
            failure instanceof LLMError
              ? failure.reason.message
              : failure instanceof Error
                ? failure.message
                : String(failure),
          ),
        },
      }
    }

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | {
          readonly _tag: "ContinueAfterOverflowCompaction"
          readonly step: number
        }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({
        _tag: "ContinueAfterOverflowCompaction",
        step,
      })

    const transitionFromCause = (cause: Cause.Cause<unknown>) => {
      if (cause.reasons.length !== 1) return undefined
      const [reason] = cause.reasons
      return Cause.isDieReason(reason) && reason.defect instanceof TurnTransitionError ? reason.defect : undefined
    }

    const loadSystemContext = (agent: AgentRegistry.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    /** Chạy đúng một provider attempt trong location/session ownership hiện tại. */
    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      runID: SessionRunState.ID,
      retryState: { attempt: number },
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      yield* authorizeTurn(sessionID, runID)
      // F2/7: xác nhận session vẫn thuộc location trước khi đọc hoặc ghi event.
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      yield* checkNative(sessionID, runID)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        // Native loops may continue the same input, never drain another input.
        if (yield* NativeOwner) return yield* Effect.die(new SessionInputOrigin.UnavailableError({ sessionID }))
        const cutoff = yield* EventBus.latestSequence(db, session.id)
        const pending = yield* SessionInputTurns.pending(session.id, cutoff).pipe(
          Effect.provideService(Database.Service, { db }),
          Effect.orDie,
        )
        const boundary = pending.findIndex((turn) => turn.source !== "local")
        const turns = boundary === -1 ? pending : pending.slice(0, boundary)
        let promoted = 0
        // Keep the local steer-first/FIFO policy, but pin every promotion to
        // captured IDs. The plan itself never supplies execution authority.
        if (promotion === "queue") {
          const queued = turns.find((turn) => turn.delivery === "queue" && turn.source === "local")
          if (queued) promoted += yield* SessionInput.promoteSelected(db, events, session.id, queued)
        }
        for (const turn of turns)
          if (turn.delivery === "steer") promoted += yield* SessionInput.promoteSelected(db, events, session.id, turn)
        if (promoted > 0) currentStep = 1
      }
      // F3-F4/7: context epoch, model, history và tool definitions tạo request.
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
      yield* authorizeTurn(session.id, runID)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      let doomLoopTail = doomLoopTailFromHistory(context)
      let turnBlocked:
        | {
            readonly message: string
            readonly rejected?: {
              readonly callID: string
              readonly result: ToolResultValue
            }
          }
        | undefined
      const toolMaterialization = yield* tools.materialize(agent.info?.permissions)
      const native = (yield* NativeOwner) !== undefined
      const constrained = native || (yield* Delegation.Current) !== undefined
      const definitions =
        toolMaterialization?.definitions.filter(
          (tool) => !constrained || toolMaterialization.originAware?.(tool.name) === true,
        ) ?? []
      const admitTool = ToolAdmission.make()
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const coding = yield* CodingWorkflow.Active
      const baseRequest = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline, coding?.instruction()]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: selectContext(toLLMMessages(context, model)).messages,
        tools: definitions,
      })
      const request = withWorkspaceRoutingMetadata(baseRequest, {
        session,
        agent,
        contextSize: context.length,
        toolCount: definitions.length,
      })
      yield* authorizeTurn(session.id, runID)
      if (native) yield* CommandProvider.check(sessionID, request).pipe(Effect.orDie)
      if (
        yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries,
          model,
          request,
        })
      )
        return yield* Effect.die(continueAfterCompaction(currentStep))
      yield* checkNative(session.id, runID)
      const startSnapshot = yield* native ? snapshots.captureObservation() : snapshots.capture()
      yield* authorizeTurn(session.id, runID)
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: CatalogModel.ID.make(model.id),
          providerID: CatalogProvider.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      }, model.cost)
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let providerFailureMessage: string | undefined
      // F5-F6/7: mỗi event được persist tuần tự; tool execute có thể chạy song song.
      const budget = yield* RunBudget.Active
      yield* Effect.sync(() => budget?.attempt(request))
      const providerStream = llm
        .stream(request, {
          retryPolicy: RequestExecutor.RetryPolicy.default,
          onRetry: (notice) =>
            Effect.sync(() => budget?.attempt(request)).pipe(
              Effect.andThen(checkNative(session.id, runID)),
              Effect.andThen(
                events
                  .publish(SessionEvent.Run.Retried, {
                    sessionID: session.id,
                    runID,
                    attempt: ++retryState.attempt,
                    nextRetryAt: DateTime.makeUnsafe(notice.retryAt),
                    error: retryError(notice.error),
                  })
                  .pipe(Effect.asVoid),
              ),
            ),
        })
        .pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => budget?.observe(event))
              if (overflowFailure || publisher.hasProviderError() || turnBlocked) return
              // Persisting progress is bookkeeping, not another provider call.
              // Check tool admission here; the watchdog handles open streams.
              if (event.type === "tool-call") yield* checkNative(session.id, runID)
              if (constrained && "providerExecuted" in event && event.providerExecuted === true)
                return yield* Effect.die(new SessionInputOrigin.UnavailableError({ sessionID }))
              if (LLMEvent.is.providerError(event)) {
                providerFailureMessage = event.message
                if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                  overflowFailure = event
                  return
                }
              }
              if (
                (event.type === "tool-input-start" || event.type === "tool-call") &&
                !publisher.canRegisterTool(event.id)
              ) {
                turnBlocked = {
                  message: `Provider exceeded the ${MAX_TOOL_CALLS_PER_TURN} tool-call limit for one turn`,
                }
                return
              }
              yield* publish(event)
              if (event.type !== "tool-call") return
              doomLoopTail = advanceDoomLoopTail(doomLoopTail, {
                name: event.name,
                value: event.input,
                local: event.providerExecuted !== true,
              })
              if (event.providerExecuted) return
              if (!toolMaterialization) {
                yield* withPublication(publisher.failUnsettledTools("Tools are not available for this agent"))
                return
              }
              if (constrained && toolMaterialization.originAware?.(event.name) !== true) {
                yield* publish(
                  LLMEvent.toolResult({
                    id: event.id,
                    name: event.name,
                    result: { type: "error", value: "Tool is not available for permission-constrained execution" },
                  }),
                )
                needsContinuation = true
                return
              }
              const assistantMessageID = yield* publisher.assistantMessageID(event.id)
              if (doomLoopTail && doomLoopTail.count >= DOOM_LOOP_THRESHOLD) {
                const blocked = yield* permission
                  .assert({
                    action: "doom_loop",
                    resources: [event.name],
                    save: [event.name],
                    sessionID: session.id,
                    agent: agent.id,
                    metadata: {
                      tool: event.name,
                      input: doomLoopTail.input,
                      repeatCount: doomLoopTail.count,
                    },
                    source: {
                      type: "tool",
                      messageID: assistantMessageID,
                      callID: event.id,
                    },
                  })
                  .pipe(
                    Effect.as<string | undefined>(undefined),
                    Effect.catch((error) => {
                      if (error instanceof PermissionPolicy.CorrectedError)
                        return Effect.succeed(`Repeated identical tool call rejected: ${error.feedback}`)
                      if (error instanceof PermissionPolicy.DeniedError)
                        return Effect.succeed(`Repeated identical tool call denied: ${event.name}`)
                      if (error instanceof PermissionPolicy.RejectedError)
                        return Effect.succeed(`Repeated identical tool call rejected: ${event.name}`)
                      return Effect.die(error)
                    }),
                  )
                if (blocked) {
                  turnBlocked = {
                    message: blocked,
                    rejected: {
                      callID: event.id,
                      result: { type: "error", value: blocked },
                    },
                  }
                  return
                }
              }
              // F7/7: local tool result tạo điều kiện cho provider continuation.
              needsContinuation = true
              yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  admitTool(
                    checkNative(session.id, runID).pipe(
                      Effect.andThen(
                        Effect.suspend(() => {
                          const blocked = coding?.before(event)
                          if (blocked) return Effect.succeed({ result: { type: "error" as const, value: blocked } })
                          return toolMaterialization.settle({
                            sessionID: session.id,
                            agent: agent.id,
                            assistantMessageID,
                            call: event,
                          }).pipe(Effect.tap((settled) => Effect.sync(() => coding?.observe(event, settled.result, settled.output?.structured))))
                        }),
                      ),
                    ),
                    toolMaterialization.parallel?.(event.name),
                  ),
                ).pipe(
                  Effect.flatMap((settlement) =>
                    publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result: settlement.result,
                        output: settlement.output,
                      }),
                      settlement.outputPaths ?? [],
                    ),
                  ),
                ),
              ).pipe(FiberSet.run(toolFibers))
            }),
          ),
          Stream.takeUntil(
            () => turnBlocked !== undefined || overflowFailure !== undefined || publisher.hasProviderError(),
          ),
          Stream.runDrain,
          Effect.ensuring(withPublication(publisher.flush())),
        )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(
              recoverOverflow({
                sessionID: session.id,
                entries,
                model,
                request,
              }).pipe(Effect.tap(() => checkNative(session.id, runID))),
            ))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          if (turnBlocked) {
            yield* FiberSet.clear(toolFibers)
            const terminalization = withPublication(
              publisher.failTurnAtomically({
                stepMessage: turnBlocked.message,
                toolMessage: "Tool execution interrupted after turn rejection",
                ...(turnBlocked.rejected === undefined
                  ? {}
                  : {
                      rejected: {
                        ...turnBlocked.rejected,
                        message: turnBlocked.message,
                      },
                    }),
              }),
            )
            if (stream._tag === "Failure") return yield* failAfterTerminalization(stream.cause, terminalization)
            yield* terminalization
            return { needsContinuation: false, step: currentStep }
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (stream._tag === "Failure" && llmFailure && !publisher.hasProviderError()) {
            yield* FiberSet.clear(toolFibers)
            return yield* failAfterTerminalization(
              stream.cause,
              withPublication(
                publisher.failTurnAtomically({
                  stepMessage: llmFailure.reason.message,
                  toolMessage: `Tool execution interrupted after provider failure: ${llmFailure.reason.message}`,
                }),
              ),
            )
          }
          if (publisher.hasProviderError()) {
            yield* FiberSet.clear(toolFibers)
            const stepMessage = providerFailureMessage ?? "Provider failed"
            const terminalization = withPublication(
              publisher.failTurnAtomically({
                stepMessage,
                toolMessage: providerFailureMessage
                  ? `Tool execution interrupted after provider failure: ${providerFailureMessage}`
                  : "Tool execution interrupted after provider failure",
              }),
            )
            if (stream._tag === "Failure") return yield* failAfterTerminalization(stream.cause, terminalization)
            yield* terminalization
            return { needsContinuation: false, step: currentStep }
          }
          if (stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause)) {
            yield* FiberSet.clear(toolFibers)
            return yield* failAfterTerminalization(
              stream.cause,
              withPublication(
                publisher.failTurnAtomically({
                  stepMessage: "Provider stream failed unexpectedly",
                  toolMessage: "Tool execution interrupted after unexpected provider stream failure",
                }),
              ),
            )
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) {
            yield* FiberSet.clear(toolFibers)
            if (publisher.hasAssistantStarted())
              return yield* failAfterTerminalization(
                stream.cause,
                withPublication(
                  publisher.failTurnAtomically({
                    stepMessage: "Provider turn interrupted",
                    toolMessage: "Tool execution interrupted",
                  }),
                ),
              )
            return yield* Effect.failCause(stream.cause)
          }
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejectedOnly(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            return yield* failAfterTerminalization(
              Cause.interrupt(),
              withPublication(
                publisher.failTurnAtomically({
                  stepMessage: "Provider turn interrupted",
                  toolMessage: "Tool execution interrupted",
                }),
              ),
            )
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            return yield* failAfterTerminalization(
              settled.cause,
              withPublication(
                publisher.failTurnAtomically({
                  stepMessage: "Provider turn interrupted",
                  toolMessage: "Tool execution interrupted",
                }),
              ),
            )
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            return yield* failAfterTerminalization(
              settled.cause,
              withPublication(
                publisher.failTurnAtomically({
                  stepMessage: `Tool execution failed: ${message}`,
                  toolMessage: `Tool execution failed: ${message}`,
                }),
              ),
            )
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement) {
            yield* checkNative(session.id, runID)
            const endSnapshot = yield* native ? snapshots.captureObservation() : snapshots.capture()
            yield* checkNative(session.id, runID)
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              publisher.endTurnAtomically({
                finish: stepSettlement.finish,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
                unresolvedToolMessage: "Provider did not return a tool result",
              }),
            )
          } else if (publisher.hasAssistantStarted()) {
            yield* withPublication(
              publisher.failTurnAtomically({
                stepMessage: "Provider stream ended without a step settlement",
                toolMessage: "Provider did not return a tool result",
              }),
            )
            return { needsContinuation: false, step: currentStep }
          }
          return {
            needsContinuation,
            step: currentStep,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      runID: SessionRunState.ID,
      retryState: { attempt: number },
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (sessionID, runID, retryState, promotion, step) {
        return yield* runTurnAttempt(sessionID, runID, retryState, promotion, step).pipe(
          Effect.catchCause(
            Effect.fnUntraced(function* (cause) {
              const transition = transitionFromCause(cause)
              if (!transition) return yield* Effect.failCause(cause)
              if (transition.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                runID,
                retryState,
                undefined,
                transition.transition.step,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, runID, retryState, promotion, step) {
      return yield* runTurnAttempt(sessionID, runID, retryState, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchCause(
          Effect.fnUntraced(function* (cause) {
            const transition = transitionFromCause(cause)
            if (!transition) return yield* Effect.failCause(cause)
            yield* Effect.yieldNow
            if (transition.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(
                sessionID,
                runID,
                retryState,
                undefined,
                transition.transition.step,
              )
            return yield* runTurn(sessionID, runID, retryState, undefined, transition.transition.step)
          }),
        ),
      )
    })

    const hasLocalPending = (sessionID: SessionSchema.ID, delivery: SessionInput.Delivery) =>
      SessionInputTurns.pending(sessionID).pipe(
        Effect.provideService(Database.Service, { db }), Effect.orDie,
        Effect.map((turns) => {
          for (const turn of turns) {
            if (turn.source !== "local") return false
            if (turn.delivery === delivery) return true
          }
          return false
        }),
      )

    /**
     * Drain steer trước queue; trong mỗi input, lặp provider turn đến khi mọi
     * local tool result đã được model tiêu thụ hoặc step kết thúc.
     */
    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      yield* SessionInputOrigin.requireLocalRun(db, input.sessionID)
      const recoveryOwner = yield* db
        .select({
          ownerID: EventSequenceTable.owner_id,
          ownerGeneration: EventSequenceTable.owner_generation,
          projectID: SessionTable.project_id,
          workspaceID: SessionTable.workspace_id,
        })
        .from(SessionTable)
        .innerJoin(EventSequenceTable, eq(EventSequenceTable.aggregate_id, SessionTable.id))
        .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const processWorkspaceID = location.workspaceID ?? undefined
      const sessionWorkspaceID = recoveryOwner?.workspaceID ?? undefined
      const ownerID = recoveryOwner?.ownerID ?? undefined
      const ownsRecoveryLocation =
        recoveryOwner !== undefined &&
        recoveryOwner.projectID === location.project.id &&
        sessionWorkspaceID === processWorkspaceID &&
        (processWorkspaceID
          ? ownerID === undefined || ownerID === processWorkspaceID
          : ownerID === undefined || ownerID === recoveryOwner.projectID)
      if (ownsRecoveryLocation) {
        yield* SessionVerification.recoverPendingForSession(db, events, {
          sessionID: input.sessionID,
          ownerID,
          ownerGeneration: recoveryOwner.ownerGeneration,
        }).pipe(
          Effect.provideService(VerificationSettlementPublisher.Service, verificationSettlements),
          Effect.tap((result) =>
            result.failures > 0
              ? Effect.logWarning("Verification recovery left pending work for a later retry", {
                  failures: result.failures,
                  sessionID: input.sessionID,
                })
              : Effect.void,
          ),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () =>
              Effect.logError("Verification recovery scan failed", {
                sessionID: input.sessionID,
              }),
          ),
        )
      }
      const hasSteer = yield* hasLocalPending(input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* hasLocalPending(input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const runID = SessionRunState.ID.create()
          const previous = yield* store.runState(input.sessionID).pipe(Effect.orDie)
          const now = yield* DateTime.now
          const startedAt =
            previous?.status === "busy" || previous?.status === "retrying"
              ? DateTime.makeUnsafe(
                  Math.max(DateTime.toEpochMillis(now), DateTime.toEpochMillis(previous.time.started)),
                )
              : now
          yield* SessionInputOrigin.requireLocalRun(db, input.sessionID)
          if (previous?.status === "busy" || previous?.status === "retrying") {
            yield* events.publishBatch([
              {
                definition: SessionEvent.Run.Settled,
                data: {
                  sessionID: input.sessionID,
                  runID: previous.runID,
                  timestamp: startedAt,
                  outcome: { type: "interrupted" },
                },
              },
              {
                definition: SessionEvent.Run.Started,
                data: {
                  sessionID: input.sessionID,
                  runID,
                  timestamp: startedAt,
                },
              },
            ])
          } else {
            yield* events.publish(SessionEvent.Run.Started, {
              sessionID: input.sessionID,
              runID,
              timestamp: startedAt,
            })
          }

          const eligibleDrain = Effect.gen(function* () {
            yield* SessionInputOrigin.requireLocalRun(db, input.sessionID)
            // Pin trusted verifier identity after the run is durable and before
            // any drain-owned mutation or model call.
            const independentCheck = yield* prepareIndependentCheck(input.sessionID,
              SessionInputOrigin.requireLocalRun(db, input.sessionID).pipe(Effect.orDie))
            const verifier = independentCheck ? {} : yield* selectVerifier()
            let boundaryProfile: VerificationBoundaryProfile
            let startSnapshot: Snapshot.ID | undefined
            if (independentCheck) {
              boundaryProfile = "observation"
            } else if (verifier.selection) {
              boundaryProfile = "verification"
              startSnapshot = yield* snapshots.captureVerification()
            } else {
              const observation = yield* snapshots.captureObservation()
              if (observation) {
                boundaryProfile = "observation"
                startSnapshot = observation
              } else {
                boundaryProfile = "legacy"
                startSnapshot = yield* snapshots.capture()
              }
            }
            const drain = Effect.gen(function* () {
              const retryState = { attempt: 0 }
              yield* SessionInputOrigin.requireLocalRun(db, input.sessionID)
              yield* failInterruptedTools(input.sessionID)
              let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
              let shouldRun = input.force || hasSteer || hasQueue
              while (shouldRun) {
                let needsContinuation = true
                let step = 1
                while (needsContinuation) {
                  const result = yield* runTurn(input.sessionID, runID, retryState, promotion, step)
                  needsContinuation = result.needsContinuation
                  step = result.step + 1
                  promotion = "steer"
                  if (!needsContinuation)
                    needsContinuation = yield* hasLocalPending(input.sessionID, "steer")
                }
                shouldRun = yield* hasLocalPending(input.sessionID, "queue")
                promotion = shouldRun ? "queue" : undefined
              }
            })
            if (independentCheck) return yield* drain.pipe(Effect.andThen(independentCheck))
            return yield* Effect.onExitPrimitive(drain, (drainExit) => {
              const observation = Effect.gen(function* () {
                const endSnapshot =
                  boundaryProfile === "verification"
                    ? yield* snapshots.captureVerification()
                    : boundaryProfile === "observation"
                      ? yield* snapshots.captureObservation()
                      : yield* snapshots.capture()
                const fallbackEndSnapshot =
                  boundaryProfile === "verification" && !endSnapshot ? yield* snapshots.capture() : undefined
                yield* observeVerification(
                  input.sessionID,
                  boundaryProfile,
                  startSnapshot,
                  endSnapshot,
                  verifier,
                  fallbackEndSnapshot,
                )
              }).pipe(
                Effect.exit,
                Effect.flatMap((observationExit) => {
                  if (Exit.isSuccess(observationExit)) return Effect.void
                  if (!Cause.hasInterrupts(observationExit.cause))
                    return Effect.logError("Verification shadow recording failed", {
                      cause: observationExit.cause,
                      sessionID: input.sessionID,
                    })
                  if (Exit.isFailure(drainExit))
                    return Effect.logWarning("Verification interruption did not replace the failed drain", {
                      sessionID: input.sessionID,
                    })
                  return Effect.failCause(observationExit.cause)
                }),
              )
              // An already-interrupted drain still receives its terminal shadow
              // receipt. Otherwise observation remains externally cancellable, and
              // SessionVerification masks only its durable settlement sections.
              return Exit.isFailure(drainExit) && Cause.hasInterrupts(drainExit.cause)
                ? observation
                : Effect.interruptible(observation)
            })
          })

          const budget = (yield* RunBudget.Active) ?? RunBudget.createRunBudget(Config.latest(yield* config.entries(), "run_budget"))
          const drainExit = yield* restore(CodingWorkflow.wrap(eligibleDrain).pipe(
            Effect.provideService(RunBudget.Active, budget),
            Effect.timeoutOrElse({ duration: budget.remainingDurationMs(),
              orElse: () => Effect.die(new RunBudget.RunBudgetExceeded("time")) }),
          )).pipe(Effect.exit)
          const outcome: SessionRunState.Outcome = Exit.isSuccess(drainExit)
            ? { type: "idle" }
            : Cause.hasInterruptsOnly(drainExit.cause)
              ? { type: "interrupted" }
              : terminalFailure(drainExit.cause)
          const settledNow = yield* DateTime.now
          const settledAt = DateTime.makeUnsafe(
            Math.max(DateTime.toEpochMillis(startedAt), DateTime.toEpochMillis(settledNow)),
          )
          const settlementExit = yield* events
            .publish(SessionEvent.Run.Settled, {
              sessionID: input.sessionID,
              runID,
              timestamp: settledAt,
              outcome,
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(drainExit)) {
            if (Exit.isFailure(settlementExit))
              return yield* Effect.failCause(Cause.combine(drainExit.cause, settlementExit.cause))
            return yield* Effect.failCause(drainExit.cause)
          }
          if (Exit.isFailure(settlementExit)) return yield* Effect.failCause(settlementExit.cause)
          return drainExit.value
        }),
      )
    })

    const runCommand: NodeCommandRunner.Interface["run"] = Effect.fn("SessionRunner.runCommand")(function* (
      node,
      value,
    ) {
      const parsed = Schema.decodeUnknownExit(NodeCommandRunner.Target, { onExcessProperty: "error" })(value)
      if (parsed._tag === "Failure" || (yield* PermissionOrigin.capture).length > 0)
        return yield* new SessionInputOrigin.UnavailableError({ sessionID: value.sessionID })
      const target = Object.freeze({ ...parsed.value })
      const state = yield* SessionRunState.load(db, target.sessionID).pipe(
        Effect.mapError(() => new SessionInputOrigin.UnavailableError({ sessionID: target.sessionID })),
      )
      if (
        state?.runID !== target.runID ||
        state.inputID !== target.messageID ||
        (state.status !== "busy" && state.status !== "retrying")
      )
        return yield* new SessionInputOrigin.UnavailableError({ sessionID: target.sessionID })

      const work = Effect.gen(function* () {
        const constraint = yield* restoreContinuation(node, target).pipe(
          Effect.provideService(Database.Service, { db }),
          Effect.provideService(Location.Service, location),
        )
        const check = constraint.valid.pipe(
          Effect.flatMap((valid) =>
            valid ? Effect.void : Effect.die(new SessionInputOrigin.UnavailableError({ sessionID: target.sessionID })),
          ),
        )
        const drain = Effect.gen(function* () {
          yield* check
          const independentCheck = yield* prepareIndependentCheck(target.sessionID, check)
          const startSnapshot = independentCheck ? undefined : yield* snapshots.captureObservation()
          yield* check
          // Recovery only terminalizes uncertain tools; it never replays their side effects.
          yield* failInterruptedTools(target.sessionID)
          const retryState = { attempt: state.status === "retrying" ? state.attempt : 0 }
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            yield* check
            const turn = yield* runTurn(target.sessionID, target.runID, retryState, undefined, step)
            needsContinuation = turn.needsContinuation
            step = turn.step + 1
          }
          yield* check
          const endSnapshot = independentCheck ? undefined : yield* snapshots.captureObservation()
          yield* check
          if (independentCheck) yield* independentCheck
          else yield* observeVerification(target.sessionID, "observation", startSnapshot, endSnapshot, {}, undefined)
          yield* check
        })
        return yield* PermissionOrigin.restrict(
          constraint,
          ExecutionBoundary.restrict(
            {
              attempt: check,
              request: (request) =>
                check.pipe(Effect.andThen(CommandProvider.check(target.sessionID, request).pipe(Effect.orDie))),
            },
            Effect.raceFirst(drain, Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(check)))).pipe(
              Effect.provideService(NativeOwner, { target, check }),
            ),
          ),
        )
      })
      const budget = RunBudget.createRunBudget(Config.latest(yield* config.entries(), "run_budget"))
      const exit = yield* CodingWorkflow.wrap(work).pipe(
        Effect.provideService(RunBudget.Active, budget),
        Effect.timeoutOrElse({ duration: budget.remainingDurationMs(),
          orElse: () => Effect.die(new RunBudget.RunBudgetExceeded("time")) }), Effect.interruptible, Effect.exit,
      )
      const outcome: SessionRunState.Outcome = Exit.isSuccess(exit)
        ? { type: "idle" }
        : Cause.hasInterruptsOnly(exit.cause)
          ? { type: "interrupted" }
          : terminalFailure(exit.cause)
      const timestamp = DateTime.makeUnsafe(
        Math.max(DateTime.toEpochMillis(state.time.started), DateTime.toEpochMillis(yield* DateTime.now)),
      )
      const settlement = events
        .publish(SessionEvent.Run.Settled, {
          sessionID: target.sessionID,
          runID: target.runID,
          timestamp,
          outcome,
        })
        .pipe(Effect.asVoid)
      if (Exit.isFailure(exit)) return yield* failAfterTerminalization(exit.cause, settlement)
      yield* settlement
    }, Effect.uninterruptible)

    return Context.make(Service, Service.of({ run })).pipe(
      Context.add(NodeCommandRunner.Service, NodeCommandRunner.Service.of({ run: runCommand })),
    )
  }),
)

export const defaultLayer = layer
