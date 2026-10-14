import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { initialize, reserve, settle, status, track, type Policy } from "../../src/inference/request/spending"
import { RequestExecutor } from "../../src/inference/request/executor"
import { LLMEvent, Usage } from "../../src/inference/schema"
const policy: Policy = { limitUSD: 0.03, priorUSD: 0.001, endpoint: "https://fixture.invalid/chat",
  model: "fixture", inputPerMillion: 1, outputPerMillion: 2, maxOutputTokens: 1000, maxRequestBytes: 20000 }
const request = (patch = {}) => HttpClientRequest.post(policy.endpoint).pipe(HttpClientRequest.bodyText(JSON.stringify({
  model: policy.model, stream: true, max_tokens: 1000, messages: [{ role: "user", content: "Fix fixture" }], ...patch,
}), "application/json"))
async function fixture(run: (file: string) => Promise<void> | void) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phins-spending-")))
  const file = path.join(root, "budget.db")
  try { initialize(file, policy); await run(file) } finally { await fs.rm(root, { recursive: true, force: true }) }
}
test("allowance persists actual usage; initialization cannot reset it", () => fixture((file) => {
  const id = reserve(file, request())
  expect(status(file).committedUSD).toBeGreaterThan(0.01)
  settle(file, id, new Usage({ inputTokens: 100, outputTokens: 20 }))
  expect(status(file).committedUSD).toBeCloseTo(0.00114, 8)
  settle(file, id, new Usage({ inputTokens: 0, outputTokens: 0 }))
  expect(status(file).committedUSD).toBeCloseTo(0.00114, 8)
  expect(() => initialize(file, { ...policy, limitUSD: 10 })).toThrow()
}))
test("unknown usage and retries retain reservations and stop before cap", () => fixture((file) => {
  const id = reserve(file, request())
  const charged = status(file).committedUSD
  settle(file, id, new Usage({ inputTokens: 100 }))
  expect(status(file).committedUSD).toBe(charged)
  reserve(file, request())
  expect(() => reserve(file, request())).toThrow()
  expect(status(file).committedUSD).toBeLessThanOrEqual(policy.limitUSD)
  expect(status(file).uncertain).toBe(2)
}))
test("wire overlays cannot bypass pinned model, endpoint, text or output caps", () => fixture((file) => {
  for (const patch of [{ model: "other" }, { max_tokens: 1001 }, { max_tokens: null },
    { max_completion_tokens: 2000 }, { n: 2 }, { stream: false },
    { messages: [{ content: [{ type: "image_url", image_url: "data:private" }] }] }])
    expect(() => reserve(file, request(patch))).toThrow()
  expect(() => reserve(file, request().pipe(HttpClientRequest.setUrl("https://other.invalid/chat")))).toThrow()
  expect(status(file).committedUSD).toBe(policy.priorUSD)
}))
test("invalid prices, missing ledger, symlinks and permissive storage fail closed", () => fixture(async (file) => {
  expect(() => initialize(file + "bad", { ...policy, outputPerMillion: 0 })).toThrow()
  expect(() => reserve(file + "missing", request())).toThrow()
  await fs.symlink(file, file + "link")
  expect(() => reserve(file + "link", request())).toThrow()
  await fs.chmod(file, 0o644)
  expect(() => reserve(file, request())).toThrow()
}))
test("reported usage above reserve exhausts future allowance", () => fixture((file) => {
  const id = reserve(file, request())
  settle(file, id, new Usage({ inputTokens: 20000, outputTokens: 2000 }))
  expect(status(file).committedUSD).toBeGreaterThanOrEqual(policy.limitUSD)
  expect(() => reserve(file, request())).toThrow()
}))
test("actual executor retries each reserve; only completed response settles", () => fixture(async (file) => {
  let sends = 0
  const http = RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient,
    HttpClient.make((req) => Effect.sync(() => {
      sends++
      return HttpClientResponse.fromWeb(req, new Response("ok", { status: sends === 1 ? 429 : 200 }))
    })),
  )))
  const stream = Stream.fromEffect(RequestExecutor.Service.use((executor) => executor.execute(request(), {
    retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
  }))).pipe(Stream.map(() => LLMEvent.finish({ reason: "stop", usage: new Usage({ inputTokens: 100, outputTokens: 10 }) })))
  await Effect.runPromise(track(stream, file).pipe(Stream.runDrain, Effect.provide(http)))
  expect(sends).toBe(2)
  expect(status(file).uncertain).toBe(1)
  expect(status(file).committedUSD).toBeGreaterThan(0.01)
}))
test("stream failure after finish cannot free its reservation", () => fixture(async (file) => {
  const http = RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient,
    HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok")))),
  )))
  const stream = Stream.fromEffect(RequestExecutor.Service.use((e) => e.execute(request()))).pipe(
    Stream.map(() => LLMEvent.finish({ reason: "stop", usage: new Usage({ inputTokens: 1, outputTokens: 1 }) })),
    Stream.concat(Stream.fail("late stream error")),
  )
  await Effect.runPromise(track(stream, file).pipe(Stream.runDrain, Effect.exit, Effect.provide(http)))
  expect(status(file).uncertain).toBe(1)
  expect(status(file).committedUSD).toBeGreaterThan(0.01)
}))

test("independent processes share reservations and cannot reset on restart", () => fixture(async (file) => {
  const module = path.resolve(import.meta.dir, "../../src/inference/request/spending.ts")
  const script = `
    import { reserve } from ${JSON.stringify(module)};
    import { HttpClientRequest } from "effect/unstable/http";
    const request=HttpClientRequest.post(${JSON.stringify(policy.endpoint)}).pipe(HttpClientRequest.bodyText(
      JSON.stringify({model:"fixture",stream:true,max_tokens:1000,messages:[{role:"user",content:"Fix fixture"}]}),"application/json"));
    try { reserve(process.argv[1],request); console.log("reserved") }
    catch { console.log("blocked") }
  `
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    const child = Bun.spawn([process.execPath, "-e", script, file], {
      cwd: path.resolve(import.meta.dir, "../.."), env: { PATH: process.env.PATH },
      stdout: "pipe", stderr: "pipe",
    })
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(exit, err).toBe(0)
    return out.trim()
  }))
  expect(results.filter((r) => r === "reserved")).toHaveLength(2)
  expect(results.filter((r) => r === "blocked")).toHaveLength(2)
  expect(status(file).uncertain).toBe(2)
  expect(() => reserve(file, request())).toThrow()
  expect(status(file).committedUSD).toBeLessThanOrEqual(policy.limitUSD)
}))
