import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { CatalogProvider } from "./provider"
import { CatalogModel } from "./model"

const maxBytes = 1024 * 1024
const maxModels = 4096
const nebiusCatalog = "https://tokenfactory.nebius.com/api/public/models_info"

type DiscoveredModel = { id: string; context?: number; cost?: CatalogModel.Info["cost"][number] }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

/** Keep only validated metadata; provider content never supplies execution policy. */
function modelList(value: unknown): DiscoveredModel[] {
  if (!Array.isArray(value) || value.length > maxModels) throw new Error("Invalid model list.")
  const models = new Map<string, DiscoveredModel>()
  for (const item of value) {
    const data = record(item)
    const id = data.id
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(id))
      throw new Error("Invalid model identifier.")
    const model: DiscoveredModel = { id }
    if (typeof data.context === "number" && Number.isSafeInteger(data.context) && data.context > 0)
      model.context = data.context
    const cost = record(data.cost)
    const cache = record(cost.cache)
    if (rate(cost.input) && rate(cost.output)) model.cost = {
      input: cost.input, output: cost.output,
      // No advertised cache discount means a conservative input-rate estimate.
      cache: { read: rate(cache.read) ? cache.read : cost.input, write: rate(cache.write) ? cache.write : cost.input },
    }
    models.set(id, model)
  }
  return [...models.values()]
}

function metadata(value: unknown) {
  const item = record(value)
  return { id: item.id ?? item.model_id, context: item.max_model_len,
    cost: { input: item.input_price_per_million_tokens, output: item.output_price_per_million_tokens } }
}

export function mergeDiscoveredModel(model: CatalogModel.Info, discovered: DiscoveredModel): CatalogModel.Info {
  return { ...model,
    limit: { ...model.limit, context: model.limit.context || discovered.context || 0 },
    cost: model.cost.length ? model.cost : discovered.cost ? [discovered.cost] : [],
  }
}

export function supportsModelDiscovery(provider: CatalogProvider.Info) {
  return provider.api.type === "aisdk"
    && ["@ai-sdk/openai-compatible", "@ai-sdk/openai"].includes(provider.api.package)
    && !!provider.api.url
}

function endpoint(provider: CatalogProvider.Info) {
  if (!supportsModelDiscovery(provider)) return
  const url = new URL(provider.api.url!)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Model discovery requires HTTPS or a local provider.")
  url.pathname = url.pathname.replace(/\/$/, "") + "/models"
  return url.toString()
}

/** Explicit metadata refresh only. Reading the cache never contacts a provider. */
export function createModelCatalog(directory: string, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  const memory = new Map<string, DiscoveredModel[]>()
  function target(provider: CatalogProvider.Info, key?: string) {
    const url = endpoint(provider)
    if (!url) return
    const headers = new Headers(provider.request.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    headers.set("accept", "application/json")
    // Separate accounts/endpoints without writing credentials into the cache.
    const hash = createHash("sha256")
      .update(JSON.stringify([provider.id, url, [...headers.entries()]]))
      .digest("hex")
    return { url, headers, file: path.join(directory, `${hash}.json`) }
  }

  async function json(url: string, headers: Headers, signal: AbortSignal): Promise<unknown> {
    const response = await fetcher(url, { method: "GET", headers, redirect: "error", signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error("Provider model list unavailable.")
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw new Error("Model list is too large.")
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }

  async function load(provider: CatalogProvider.Info, key?: string): Promise<DiscoveredModel[]> {
    try {
      const item = target(provider, key)
      if (!item) return []
      const saved = memory.get(item.file)
      if (saved) return saved
      if ((await stat(item.file)).size > maxBytes) return []
      const data = JSON.parse(await readFile(item.file, "utf8"))
      if (data.version !== 1 && data.version !== 2) return []
      const models = modelList(data.version === 1
        ? data.models.map((id: unknown) => ({ id })) : data.models)
      memory.set(item.file, models)
      return models
    } catch { return [] }
  }

  return {
    load,
    async refresh(provider: CatalogProvider.Info, key?: string, signal?: AbortSignal) {
      const item = target(provider, key)
      if (!item) return
      const deadline = AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])])
      let models: DiscoveredModel[]
      try {
        const data = record(await json(item.url, item.headers, deadline))
        if (!Array.isArray(data.data)) throw new Error("Invalid model list.")
        models = modelList(data.data.map(metadata))
        if (item.url === "https://api.tokenfactory.nebius.com/v1/models") {
          const previous = new Map((await load(provider, key)).map((model) => [model.id, model]))
          // This public request must never carry account headers or credentials.
          const details = await json(nebiusCatalog, new Headers({ accept: "application/json" }), deadline)
            .then((value) => {
              if (!Array.isArray(value)) throw new Error("Invalid public catalog.")
              return modelList(value.flatMap((item) => {
                const flavors = record(item).flavors
                return Array.isArray(flavors) ? flavors.map(metadata) : []
              }))
            }).catch(() => [])
          for (const model of details) previous.set(model.id, model)
          // Public metadata enriches only IDs actually returned by this account.
          models = models.map((model) => ({ ...previous.get(model.id), ...model }))
        }
        if (signal?.aborted) throw new Error("Cancelled")
      } catch {
        // Do not retain a response body, request, URL or authorization in errors.
        throw new Error("Could not load provider models. Check the API key and connection.")
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temp = `${item.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 2, models }) + "\n", { mode: 0o600 })
        await rename(temp, item.file)
      } finally { await unlink(temp).catch(() => {}) }
      memory.set(item.file, models)
    },
  }
}
