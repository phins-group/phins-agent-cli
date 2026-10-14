import type { EventBus } from "../../runtime/events/bus"
import type { SessionV1 } from "../../contracts/session/compat"
import type { Session as SessionSchema } from "../../contracts/session/info"

export interface Usage {
  readonly cost: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

type UsagePart = {
  readonly type: string
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

const frame = (value: string) => `${value.length}_${value}`

export const partContributionKey = (
  sessionID: SessionSchema.ID | string,
  partID: SessionV1.PartID | string,
) => `usage_part_${frame(String(sessionID))}_${frame(String(partID))}`

export const eventContributionKey = (eventID: EventBus.ID | string) =>
  `usage_event_${frame(String(eventID))}`

export const residualContributionKey = (sessionID: SessionSchema.ID | string) =>
  `usage_residual_${frame(String(sessionID))}`

export function fromPart(part: UsagePart): Usage | undefined {
  if (part.type !== "step-finish" || part.cost === undefined || part.tokens === undefined) return undefined
  return {
    cost: part.cost,
    input: part.tokens.input,
    output: part.tokens.output,
    reasoning: part.tokens.reasoning,
    cacheRead: part.tokens.cache.read,
    cacheWrite: part.tokens.cache.write,
  }
}
