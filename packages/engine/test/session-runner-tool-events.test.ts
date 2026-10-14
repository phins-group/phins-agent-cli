import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "../src/inference/api"
import { EventBus } from "../src/runtime/events/bus"
import { SessionEvent } from "../src/contracts/events/session"
import { SessionMessage } from "../src/sessions/messages/service"
import { SessionManager } from "../src/sessions/service"
import { CatalogModel } from "../src/inference/catalog/model"
import { CatalogProvider } from "../src/inference/catalog/provider"
import {
  createLLMEventPublisher,
  MAX_TERMINAL_ERROR_BYTES,
  MAX_TOOL_CALLS_PER_TURN,
} from "../src/sessions/run/events"

const sessionID = SessionManager.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = (prices: CatalogModel.Info["cost"] = []) => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const batchSizes: number[] = []
  let batchDefect: unknown | undefined
  const publish: EventBus.Interface["publish"] = (definition, data) =>
    Effect.sync(() => {
      const event = {
        id: EventBus.ID.create(),
        type: definition.type,
        data,
      } as EventBus.Payload<typeof definition>
      published.push({
        type: definition.durable ? EventBus.versionedType(definition.type, definition.durable.version) : definition.type,
        data,
      })
      return event
    })
  const publishBatch: EventBus.Interface["publishBatch"] = (items) =>
    Effect.suspend(() => {
      batchSizes.push(items.length)
      return batchDefect === undefined
        ? Effect.forEach(items, (item) => publish(item.definition, item.data))
        : Effect.die(batchDefect)
    })
  const events = EventBus.Service.of({
    publish,
    publishBatch,
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    sessionDeltas: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    batchSizes,
    failBatchWith: (defect: unknown | undefined) => {
      batchDefect = defect
    },
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: CatalogModel.ID.make("model"),
        providerID: CatalogProvider.ID.make("provider"),
      },
    }, prices),
  }
}

const call = LLMEvent.toolCall({
  id: "call-image",
  name: "read",
  input: { path: "pixel.png" },
})
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
        name: "pixel.png",
      },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
        name: "pixel.png",
      },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
      },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
      },
    ],
    result: {
      type: "content",
      value: [
        {
          type: "file",
          uri: `data:image/png;base64,${base64}`,
          mime: "image/png",
        },
      ],
    },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop" })
})

test("atomic turn failure mutates publisher settlement state only after the batch commits", async () => {
  const { failBatchWith, published, publisher } = capture()
  const defect = new Error("terminal batch failed")
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolCall({
        id: "call-atomic",
        name: "echo",
        input: { text: "same" },
      }),
    ),
  )
  const beforeTerminal = published.length
  failBatchWith(defect)

  expect(
    await Effect.runPromise(
      publisher
        .failTurnAtomically({
          stepMessage: "Repeated call rejected",
          toolMessage: "Tool execution interrupted after turn rejection",
          rejected: {
            callID: "call-atomic",
            message: "Repeated call rejected",
            result: { type: "error", value: "Repeated call rejected" },
          },
        })
        .pipe(Effect.catchDefect(Effect.succeed)),
    ),
  ).toBe(defect)
  expect(publisher.hasActiveAssistant()).toBe(true)
  expect(published).toHaveLength(beforeTerminal)

  failBatchWith(undefined)
  await Effect.runPromise(
    publisher.failTurnAtomically({
      stepMessage: "Repeated call rejected",
      toolMessage: "Tool execution interrupted after turn rejection",
      rejected: {
        callID: "call-atomic",
        message: "Repeated call rejected",
        result: { type: "error", value: "Repeated call rejected" },
      },
    }),
  )

  expect(publisher.hasActiveAssistant()).toBe(false)
  expect(published.slice(beforeTerminal).map((event) => event.type)).toEqual([
    EventBus.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.durable!.version),
    EventBus.versionedType(SessionEvent.Step.Failed.type, SessionEvent.Step.Failed.durable!.version),
  ])
})

test("provider failure starts and fails an empty assistant in one retryable batch", async () => {
  const { batchSizes, failBatchWith, published, publisher } = capture()
  const defect = new Error("empty terminal batch failed")
  await Effect.runPromise(publisher.publish(LLMEvent.providerError({ message: "Provider unavailable" })))

  expect(publisher.hasProviderError()).toBe(true)
  expect(publisher.hasAssistantStarted()).toBe(false)
  expect(published).toEqual([])
  failBatchWith(defect)
  expect(
    await Effect.runPromise(
      publisher
        .failTurnAtomically({
          stepMessage: "Provider unavailable",
          toolMessage: "Tool execution interrupted after provider failure: Provider unavailable",
        })
        .pipe(Effect.catchDefect(Effect.succeed)),
    ),
  ).toBe(defect)
  expect(publisher.hasAssistantStarted()).toBe(false)
  expect(published).toEqual([])

  failBatchWith(undefined)
  await Effect.runPromise(
    publisher.failTurnAtomically({
      stepMessage: "Provider unavailable",
      toolMessage: "Tool execution interrupted after provider failure: Provider unavailable",
    }),
  )

  expect(batchSizes).toEqual([2, 2])
  expect(publisher.hasAssistantStarted()).toBe(true)
  expect(publisher.hasActiveAssistant()).toBe(false)
  expect(published.map((event) => event.type)).toEqual([
    EventBus.versionedType(SessionEvent.Step.Started.type, SessionEvent.Step.Started.durable!.version),
    EventBus.versionedType(SessionEvent.Step.Failed.type, SessionEvent.Step.Failed.durable!.version),
  ])
})

test("hosted tool cleanup and successful step settlement commit atomically", async () => {
  const { batchSizes, failBatchWith, published, publisher } = capture()
  const defect = new Error("completion batch failed")
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolCall({
        id: "call-hosted-atomic",
        name: "web_search",
        input: { query: "effect" },
        providerExecuted: true,
      }),
    ),
  )
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "tool-calls" })))
  const beforeTerminal = published.length
  const settlement = publisher.stepSettlement()!
  failBatchWith(defect)

  expect(
    await Effect.runPromise(
      publisher
        .endTurnAtomically({
          ...settlement,
          unresolvedToolMessage: "Provider did not return a tool result",
        })
        .pipe(Effect.catchDefect(Effect.succeed)),
    ),
  ).toBe(defect)
  expect(published).toHaveLength(beforeTerminal)

  failBatchWith(undefined)
  await Effect.runPromise(
    publisher.endTurnAtomically({
      ...settlement,
      unresolvedToolMessage: "Provider did not return a tool result",
    }),
  )

  expect(batchSizes).toEqual([2, 2])
  expect(published.slice(beforeTerminal).map((event) => event.type)).toEqual([
    EventBus.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.durable!.version),
    EventBus.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable!.version),
  ])
})

test("successful step settlement also closes partial tool input atomically", async () => {
  const { batchSizes, published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolInputStart({ id: "call-partial-atomic", name: "read" })),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolInputDelta({ id: "call-partial-atomic", name: "read", text: '{"path":' }),
    ),
  )
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))
  const beforeTerminal = published.length

  await Effect.runPromise(
    publisher.endTurnAtomically({
      ...publisher.stepSettlement()!,
      unresolvedToolMessage: "💥".repeat(MAX_TERMINAL_ERROR_BYTES),
    }),
  )

  expect(batchSizes).toEqual([2])
  const terminal = published.slice(beforeTerminal)
  expect(terminal.map((event) => event.type)).toEqual([
    EventBus.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.durable!.version),
    EventBus.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable!.version),
  ])
  const toolFailure = terminal[0]!.data as { readonly error: { readonly message: string } }
  expect(Buffer.byteLength(toolFailure.error.message, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_BYTES)
  expect(toolFailure.error.message.endsWith("…[truncated]")).toBe(true)
})

test("tool-call ceiling keeps atomic turn failure within the batch bound", async () => {
  const { batchSizes, published, publisher } = capture()
  for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index++) {
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.toolCall({
          id: `call-boundary-${index}`,
          name: "echo",
          input: { index },
        }),
      ),
    )
  }

  expect(publisher.canRegisterTool(`call-boundary-${MAX_TOOL_CALLS_PER_TURN - 1}`)).toBe(true)
  expect(publisher.canRegisterTool("call-over-limit")).toBe(false)
  const beforeRejectedRegistration = published.length
  const defect = await Effect.runPromise(
    publisher
      .publish(
        LLMEvent.toolCall({
          id: "call-over-limit",
          name: "echo",
          input: {},
        }),
      )
      .pipe(Effect.as<unknown>(undefined), Effect.catchDefect(Effect.succeed)),
  )
  expect(String(defect)).toContain(`${MAX_TOOL_CALLS_PER_TURN} tool-call limit`)
  expect(published).toHaveLength(beforeRejectedRegistration)

  const terminalStart = published.length
  const oversizedMessage = "💥".repeat(MAX_TERMINAL_ERROR_BYTES)
  await Effect.runPromise(
    publisher.failTurnAtomically({
      stepMessage: oversizedMessage,
      toolMessage: oversizedMessage,
    }),
  )
  expect(batchSizes).toEqual([EventBus.MAX_ATOMIC_BATCH_EVENTS])
  const terminal = published.slice(terminalStart)
  for (const event of terminal) {
    const error = (event.data as { readonly error: { readonly message: string } }).error
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_BYTES)
    expect(error.message.endsWith("…[truncated]")).toBe(true)
  }
  expect(Buffer.byteLength(JSON.stringify(terminal), "utf8")).toBeLessThan(5 * 1024 * 1024)
})

test("turn settlement persists billed usage and cost exactly once across a failed commit", async () => {
  const { publisher, published, failBatchWith } = capture([
    { input: 2, output: 6, cache: { read: 0.5, write: 3 } },
  ])
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: {
    inputTokens: 1500, outputTokens: 500, reasoningTokens: 200,
    cacheReadInputTokens: 400, cacheWriteInputTokens: 100,
  } })))
  const settlement = { ...publisher.stepSettlement()!, unresolvedToolMessage: "No result" }
  failBatchWith("fixture commit failure")
  await expect(Effect.runPromise(publisher.endTurnAtomically(settlement))).rejects.toBeDefined()
  expect(published).toHaveLength(0)
  failBatchWith(undefined)
  await Effect.runPromise(publisher.endTurnAtomically(settlement))
  await Effect.runPromise(publisher.endTurnAtomically(settlement))
  const ended = published.filter((event) => event.type ===
    EventBus.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable!.version))
  expect(ended).toHaveLength(1)
  expect(ended[0]!.data).toMatchObject({ cost: 0.0055,
    tokens: { input: 1000, output: 300, reasoning: 200, cache: { read: 400, write: 100 } } })
  expect(published[0]!.data).not.toHaveProperty("cost")
})
