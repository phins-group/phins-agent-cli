/** Existing headless CLI owns its work and cancels it on unconfirmed exit. */
import { readSessionSnapshot } from "@phins/engine/transport/client/connection"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { Commands } from "../commands"
import { CommandDispatcher } from "../dispatcher"
import { connectTarget } from "../../agent/session-target"
import { summarizeTools, type ToolEvidence } from "../../shared/coding-report"

export default CommandDispatcher.defineHandler(
  Commands.commands.ask,
  Effect.fn("cli.ask")(function* (input) {
    const text = input.message.join(" ")
    const id = Option.getOrElse(input.id, () => `msg_${randomUUID()}`)
    if (!text.trim())
      return yield* Effect.fail(new Error("Prompt text must not be empty"))
    if (!id.startsWith("msg_"))
      return yield* Effect.fail(new Error("--id must start with msg_"))
    const target = yield* connectTarget(
      {
        project: Option.getOrUndefined(input.project),
        session: Option.getOrUndefined(input.session),
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
      },
    )
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const sessionID = target.session.id
        process.stderr.write(
          JSON.stringify({ event: "prompt.submitting", sessionID, id }) + "\n",
        )
        const admitted = await target.client.v2.session.prompt(
          {
            sessionID,
            id,
            prompt: { text },
            delivery: "queue",
            resume: !input.recordOnly,
          },
          { signal, throwOnError: true },
        )
        if (input.recordOnly)
          return { sessionID, id, status: "accepted", admission: admitted.data }
        await target.client.v2.session.wait(
          { sessionID },
          { signal, throwOnError: true },
        )
        const { data } = await readSessionSnapshot(
          target.connection,
          { sessionID, limit: 200 },
          { signal },
        )
        if (data.runState && data.runState.status !== "idle")
          throw new Error(
            "Execution has not completed; inspect the session before retrying",
          )
        // Snapshot pages are newest-first; inspect this input's answers in
        // durable chronological order and stop before the next user input.
        const messages = [...data.messages.data].reverse()
        const index = messages.findIndex(
          (message) => message.id === id && message.type === "user",
        )
        if (index < 0)
          throw new Error(
            "Input outcome could not be confirmed; inspect the session before retrying",
          )
        const answer: string[] = []
        const tools: ToolEvidence[] = []
        const usage = { input: 0, output: 0, reasoning: 0 }
        let estimatedUSD: number | undefined
        for (const message of messages.slice(index + 1)) {
          if (message.type === "user") break
          if (message.type === "assistant") {
            if (message.error || !message.time.completed)
              throw new Error(
                "The recorded answer failed or is incomplete; inspect the session before retrying",
              )
            if (message.tokens) {
              usage.input += message.tokens.input
              usage.output += message.tokens.output
              usage.reasoning += message.tokens.reasoning
            }
            if (message.cost !== undefined) estimatedUSD = (estimatedUSD ?? 0) + message.cost
            for (const part of message.content) {
              if (part.type === "text") answer.push(part.text)
              if (part.type === "tool" && !part.provider?.executed) tools.push({ name: part.name,
                status: part.state.status,
                input: part.state.status === "pending" ? {} : part.state.input,
                output: part.state.status === "pending" ? {} : part.state.structured,
              })
            }
          }
        }
        if (!answer.length)
          throw new Error(
            "No completed answer was recorded; inspect the session before retrying",
          )
        const history = await target.client.v2.session.verificationHistory(
          { sessionID }, { signal, throwOnError: true },
        )
        const independentCheck = history.data.data.find((item) =>
          data.runState?.status === "idle" && item.time.requested >= data.runState.time.started &&
          item.time.completed !== undefined && item.time.completed <= data.runState.time.settled,
        )
        return { sessionID, id, status: "completed", text: answer.join("\n"),
          evidence: { ...summarizeTools(tools), independentCheck, usage, estimatedUSD,
            model: target.session.model, durationMs: data.runState?.status === "idle"
              ? data.runState.time.settled - data.runState.time.started : undefined } }
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error(
              "Node execution outcome is unknown; inspect the session before retrying",
            ),
    })
    yield* Effect.sync(() =>
      process.stdout.write(
        input.format === "json" || input.recordOnly
          ? JSON.stringify(result) + "\n"
          : result.text + "\n" + (result.evidence?.edits
            ? `Evidence: ${result.evidence.edits} edits; ${result.evidence.correctionAttempts} corrections; independent check ${result.evidence.independentCheck?.verdict ?? "unavailable"}; current filesystem freshness unverified.\n`
            : ""),
      ),
    )
  }),
)
