import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createModelCatalog, mergeDiscoveredModel } from "../src/inference/catalog/discovery"
import { CatalogModel } from "../src/inference/catalog/model"
import { CatalogProvider } from "../src/inference/catalog/provider"

function provider(url: string) {
  return CatalogProvider.Info.make({
    ...CatalogProvider.Info.empty(CatalogProvider.ID.make("fixture")),
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url },
  })
}

test("provider models use authenticated metadata only and persist separately for each account", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-model-catalog-"))
  const calls: { method: string; path: string; key: string | null; body: string }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push({ method: request.method, path: new URL(request.url).pathname,
      key: request.headers.get("authorization"), body: await request.text() })
    return Response.json({ data: [{ id: "nvidia/fixture" }, { id: "nvidia/fixture" }, { id: "second-model" }] })
  } })
  try {
    const item = provider(`${server.url}v1/`)
    const cache = createModelCatalog(directory)
    expect(await cache.load(item, "synthetic-first-key")).toEqual([])
    expect(calls).toEqual([])
    await cache.refresh(item, "synthetic-first-key")
    expect(calls).toEqual([{ method: "GET", path: "/v1/models",
      key: "Bearer synthetic-first-key", body: "" }])
    expect(await cache.load(item, "synthetic-first-key")).toEqual([{ id: "nvidia/fixture" }, { id: "second-model" }])
    expect(await createModelCatalog(directory).load(item, "synthetic-first-key"))
      .toEqual([{ id: "nvidia/fixture" }, { id: "second-model" }])
    expect(await cache.load(item, "synthetic-second-key")).toEqual([])
    expect(await cache.load(provider(`${server.url}other`), "synthetic-first-key")).toEqual([])
    expect(calls).toHaveLength(1)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain("synthetic")
    const file = path.join(directory, files[0]!)
    expect(await readFile(file, "utf8")).not.toContain("synthetic-first-key")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("failed, malicious and cancelled model refreshes retain the last valid cache and hide diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-model-catalog-"))
  let mode = "valid"
  let redirected = 0
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    redirected++
    return Response.json({ data: [] })
  } })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    if (mode === "auth") return Response.json({ detail: "synthetic-sensitive-response" }, { status: 401 })
    if (mode === "redirect") return Response.redirect(target.url, 302)
    if (mode === "invalid") return Response.json({ data: [{ id: "evil\u001b[2J" }] })
    if (mode === "large") return new Response("synthetic-sensitive-response".repeat(50000))
    if (mode === "cancel") await Bun.sleep(200)
    return Response.json({ data: [{ id: "stable-model" }] })
  } })
  try {
    const item = provider(`${server.url}v1`)
    const cache = createModelCatalog(directory)
    await cache.refresh(item, "synthetic-sensitive-key")
    for (mode of ["auth", "redirect", "invalid", "large", "cancel"]) {
      const controller = new AbortController()
      if (mode === "cancel") controller.abort()
      const error = await cache.refresh(item, "synthetic-sensitive-key", controller.signal)
        .then(() => undefined, (error: Error) => error)
      expect(error?.message).toBe("Could not load provider models. Check the API key and connection.")
      expect(String(error)).not.toContain("synthetic-sensitive")
      expect(await cache.load(item, "synthetic-sensitive-key")).toEqual([{ id: "stable-model" }])
    }
    expect(redirected).toBe(0)
    expect(await readdir(directory)).toHaveLength(1)
    await expect(cache.refresh(provider("http://example.invalid/v1"), "key"))
      .rejects.toThrow("HTTPS or a local provider")
    await expect(cache.refresh(provider("https://user:password@example.invalid/v1"), "key"))
      .rejects.toThrow("HTTPS or a local provider")
  } finally {
    server.stop(true)
    target.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("Nebius enriches account models with public context and rates without forwarding credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-nebius-catalog-"))
  const calls: { url: string; headers: Headers }[] = []
  const id = "nvidia/Nemotron-3_5-Lightning"
  let unavailable = false
  const cache = createModelCatalog(directory, async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) })
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("error")
    expect(init.body).toBeUndefined()
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id }, { id: "unknown" }] })
    if (unavailable) return new Response("private diagnostic", { status: 503 })
    return Response.json([{ flavors: [
      { model_id: id, max_model_len: 1048576, input_price_per_million_tokens: 0.06, output_price_per_million_tokens: 0.24 },
      { model_id: "not-available-to-account", max_model_len: 12345 },
    ] }])
  })
  const item = CatalogProvider.Info.make({
    ...provider("https://api.tokenfactory.nebius.com/v1"),
    request: { headers: { "x-private-account": "synthetic-account" }, body: {} },
  })
  try {
    await cache.refresh(item, "synthetic-key")
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-key")
    expect(calls[1]!.url).toBe("https://tokenfactory.nebius.com/api/public/models_info")
    expect([...calls[1]!.headers.entries()]).toEqual([["accept", "application/json"]])
    const models = await cache.load(item, "synthetic-key")
    expect(models).toEqual([{ id, context: 1048576,
      cost: { input: 0.06, output: 0.24, cache: { read: 0.06, write: 0.06 } } }, { id: "unknown" }])
    expect(await createModelCatalog(directory).load(item, "synthetic-key")).toEqual(models)
    const empty = CatalogModel.Info.empty(item.id, CatalogModel.ID.make(id))
    expect(mergeDiscoveredModel(empty, models[0]!)).toMatchObject({ limit: { context: 1048576 }, cost: [models[0]!.cost] })
    const configured = { ...empty, limit: { context: 65536, output: 8192 },
      cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 1 } }] }
    expect(mergeDiscoveredModel(configured, models[0]!)).toEqual(configured)
    unavailable = true
    await cache.refresh(item, "synthetic-key")
    expect(await cache.load(item, "synthetic-key")).toEqual(models)
    const saved = await readFile(path.join(directory, (await readdir(directory))[0]!), "utf8")
    expect(saved).not.toMatch(/synthetic|private diagnostic/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("model metadata validates rates and context, preserves free rates and reads the old ID cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phins-model-metadata-"))
  const item = provider("https://example.invalid/v1")
  let calls = 0
  const cache = createModelCatalog(directory, async () => {
    calls++
    return Response.json({ data: [
      { id: "free", max_model_len: 16000, input_price_per_million_tokens: 0, output_price_per_million_tokens: 0 },
      { id: "invalid", max_model_len: -1, input_price_per_million_tokens: -1, output_price_per_million_tokens: 2 },
      { id: "text-values", max_model_len: "32000", input_price_per_million_tokens: "1", output_price_per_million_tokens: "2" },
    ] })
  })
  try {
    await cache.refresh(item)
    expect(await cache.load(item)).toEqual([
      { id: "free", context: 16000, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      { id: "invalid" }, { id: "text-values" },
    ])
    expect(calls).toBe(1)
    const file = path.join(directory, (await readdir(directory))[0]!)
    await writeFile(file, JSON.stringify({ version: 1, models: ["legacy"] }))
    expect(await createModelCatalog(directory).load(item)).toEqual([{ id: "legacy" }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
