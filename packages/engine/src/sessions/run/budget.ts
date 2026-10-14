/** Finite work per explicit run; estimates are safety limits, not billing data. */
import { Context } from "effect"
import type { LLMEvent, LLMRequest } from "../../inference/api"

export const defaults = {
  max_turns: 100,
  max_tokens: 1_000_000,
  max_duration_ms: 30 * 60_000,
}
export type Limits = typeof defaults

export class RunBudgetExceeded extends Error {
  constructor(reason: "turns" | "tokens" | "time") {
    super(
      `Agent stopped: ${reason} budget reached. Review the result before explicitly continuing.`,
    )
    this.name = "AgentRunBudgetExceeded"
  }
}

export function createRunBudget(limits: Partial<Limits> = {}) {
  const config = { ...defaults, ...limits }
  for (const value of Object.values(config))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Agent run budgets must be positive finite integers")
  let turns = 0,
    tokens = 0
  const deadline = performance.now() + config.max_duration_ms
  return {
    limits: config,
    remainingDurationMs: () => Math.max(0, deadline - performance.now()),
    attempt(request: LLMRequest) {
      if (performance.now() >= deadline) throw new RunBudgetExceeded("time")
      if (++turns > config.max_turns) throw new RunBudgetExceeded("turns")
      tokens += Math.ceil(
        JSON.stringify({
          system: request.system,
          messages: request.messages,
          tools: request.tools,
        }).length / 4,
      )
      if (tokens > config.max_tokens) throw new RunBudgetExceeded("tokens")
    },
    observe(event: LLMEvent) {
      if (
        (event.type === "text-delta" || event.type === "reasoning-delta") &&
        "text" in event
      )
        tokens += Math.ceil(event.text.length / 4)
      if (event.type === "tool-input-delta")
        tokens += Math.ceil(event.text.length / 4)
      if (tokens > config.max_tokens) throw new RunBudgetExceeded("tokens")
    },
  }
}

export const Active = Context.Reference<ReturnType<typeof createRunBudget> | undefined>(
  "@phins/AgentRunBudget",
  {
    defaultValue: () => undefined,
  },
)
