import type { CatalogModel } from "../../inference/catalog/model"
import type { Session as SessionSchema } from "../../contracts/session/info"

/** Catalog rates are USD per million tokens; reasoning is billed as output. */
export function usageCost(
  tokens: SessionSchema.Info["tokens"],
  prices: ReadonlyArray<CatalogModel.Info["cost"][number]>,
): number | undefined {
  const input = tokens.input + tokens.cache.read + tokens.cache.write
  let price = prices.find((item) => !item.tier)
  for (const item of prices) {
    if (item.tier && input > item.tier.size
      && (!price?.tier || item.tier.size > price.tier.size)) price = item
  }
  if (!price) return
  const counts = [tokens.input, tokens.output + tokens.reasoning, tokens.cache.read, tokens.cache.write]
  const rates = [price.input, price.output, price.cache.read, price.cache.write]
  if ([...counts, ...rates].some((value) => !Number.isFinite(value) || value < 0)) return
  const cost = counts.reduce((sum, count, i) => sum + count * rates[i]!, 0) / 1_000_000
  return Number.isFinite(cost) ? cost : undefined
}
