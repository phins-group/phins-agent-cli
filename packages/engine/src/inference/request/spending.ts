/** Optional launcher-owned, cumulative HTTP inference allowance. */
import { Database } from "bun:sqlite"
import { closeSync, openSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { Context, Effect, Exit, Stream } from "effect"
import type { HttpClientRequest } from "effect/unstable/http"
import { InvalidRequestReason, LLMError, type LLMEvent, type Usage } from "../schema"

export interface Policy {
  limitUSD: number
  priorUSD: number
  endpoint: string
  model: string
  inputPerMillion: number
  outputPerMillion: number
  maxOutputTokens: number
  maxRequestBytes: number
}
const launcherLedger = process.env.PHINS_SPENDING_LEDGER
const fail = () => new Error("Inference allowance unavailable, invalid or exhausted; no request sent")
const units = (usd: number) => Math.ceil(usd * 1e9)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const validate = (p: Policy) => {
  const url = new URL(p.endpoint)
  if (!path.isAbsolute(url.pathname) || url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    !p.model || ![p.limitUSD, p.priorUSD, p.inputPerMillion, p.outputPerMillion].every(
      (n) => Number.isFinite(n) && n >= 0 && Number.isSafeInteger(units(n)),
    ) || p.limitUSD <= 0 || p.priorUSD > p.limitUSD || p.inputPerMillion <= 0 || p.outputPerMillion <= 0 ||
    !count(p.maxOutputTokens) || p.maxOutputTokens < 1 || p.maxOutputTokens > 1_000_000 ||
    !count(p.maxRequestBytes) || p.maxRequestBytes < 1 || p.maxRequestBytes > 8_000_000)
    throw fail()
  return p
}

/** Explicit initialization only. Never overwrites an existing cumulative ledger. */
export function initialize(file: string, policy: Policy) {
  validate(policy)
  if (!path.isAbsolute(file) || realpathSync(path.dirname(file)) !== path.dirname(file)) throw fail()
  closeSync(openSync(file, "wx", 0o600))
  const db = new Database(file)
  try {
    db.exec("CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);" +
      "CREATE TABLE charges (id TEXT PRIMARY KEY, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)")
    db.query("INSERT INTO policy VALUES (1, ?)").run(JSON.stringify(policy))
    db.query("INSERT INTO charges VALUES ('prior', ?, ?, 1)").run(units(policy.priorUSD), units(policy.priorUSD))
  } finally { db.close() }
}

function open(file: string) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file || !lstatSync(file).isFile() ||
    (lstatSync(file).mode & 0o077) !== 0) throw fail()
  const db = new Database(file, { create: false, strict: true })
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}
function policy(db: Database) {
  const row = db.query<{ json: string }, []>("SELECT json FROM policy WHERE id=1").get()
  if (!row) throw fail()
  return validate(JSON.parse(row.json) as Policy)
}
function total(db: Database) {
  const row = db.query<{ total: number }, []>("SELECT SUM(charged) AS total FROM charges").get()
  if (!row || !count(row.total)) throw fail()
  return row.total
}
export function status(file: string) {
  const db = open(file)
  try {
    const p = policy(db)
    return { limitUSD: p.limitUSD, committedUSD: total(db) / 1e9,
      uncertain: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM charges WHERE settled=0").get()!.count }
  } finally { db.close() }
}

/** Validates the actual wire body after all request/config overlays. */
export function reserve(file: string, request: HttpClientRequest.HttpClientRequest) {
  const db = open(file)
  try {
    return db.transaction(() => {
      const p = policy(db)
      if (request.method !== "POST" || request.url !== p.endpoint || request.urlParams.params.length || request.hash._tag === "Some" ||
        request.body._tag !== "Uint8Array" || request.body.body.byteLength > p.maxRequestBytes) throw fail()
      const wire = new TextDecoder().decode(request.body.body)
      const body = JSON.parse(wire)
      const outputs = [body.max_tokens, body.max_completion_tokens].filter((x) => x !== undefined)
      if (body.model !== p.model || body.stream !== true || (body.n !== undefined && body.n !== 1) ||
        outputs.length !== 1 || !count(outputs[0]) || outputs[0] < 1 || outputs[0] > p.maxOutputTokens ||
        !Array.isArray(body.messages) || body.messages.some((m: { content?: unknown }) =>
          m.content !== null && m.content !== undefined && typeof m.content !== "string") ||
        body.audio !== undefined || body.modalities !== undefined) throw fail()
      // Byte-based conservative text token estimate, with protocol overhead.
      // No cache discount; multimodal and multiple-completion requests are refused.
      const reserved = units(((request.body.body.byteLength + 8192) * p.inputPerMillion +
        outputs[0] * p.outputPerMillion) / 1e6)
      if (!count(reserved) || total(db) + reserved > units(p.limitUSD)) throw fail()
      const id = crypto.randomUUID()
      db.query("INSERT INTO charges VALUES (?, ?, ?, 0)").run(id, reserved, reserved)
      return id
    }).immediate()
  } finally { db.close() }
}

/** Incomplete/error/interrupted responses keep their entire reservation. */
export function settle(file: string, id: string, usage: Usage | undefined) {
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens) ||
    (usage.totalTokens !== undefined && usage.totalTokens !== usage.inputTokens + usage.outputTokens)) return
  const db = open(file)
  try {
    db.transaction(() => {
      const p = policy(db)
      const row = db.query<{ reserved: number; settled: number }, [string]>(
        "SELECT reserved, settled FROM charges WHERE id=?",
      ).get(id)
      if (!row || row.settled) return
      const actual = units((usage.inputTokens! * p.inputPerMillion + usage.outputTokens! * p.outputPerMillion) / 1e6)
      // If the upstream exceeds the estimate, record it and exhaust the allowance.
      const charged = actual > row.reserved ? Math.max(actual, units(p.limitUSD)) : actual
      db.query("UPDATE charges SET charged=?, settled=1 WHERE id=?").run(charged, id)
    }).immediate()
  } finally { db.close() }
}

interface Tracking { file: string; id?: string; usage?: Usage; finished: boolean; invalid: boolean }
const Current = Context.Reference<Tracking | undefined>("@phins/LLM/Spending", { defaultValue: () => undefined })
const safe = <A>(run: () => A) => Effect.try({ try: run, catch: () => new LLMError({
  module: "Spending", method: "allowance", reason: new InvalidRequestReason({ message: fail().message }),
}) })

export const beforeAttempt = (request: HttpClientRequest.HttpClientRequest) => Effect.gen(function* () {
  const tracking = yield* Current
  const file = tracking?.file ?? launcherLedger
  if (!file) return
  const id = yield* safe(() => reserve(file, request))
  if (tracking) tracking.id = id
})

/** One tracking scope per response; failed retry reservations are never released. */
export function track<E, R>(stream: Stream.Stream<LLMEvent, E, R>, file = launcherLedger) {
  if (!file) return stream
  return Stream.unwrap(Effect.sync(() => {
    const tracking: Tracking = { file, finished: false, invalid: false }
    return stream.pipe(
      Stream.tap((event) => Effect.sync(() => {
        if (event.type === "provider-error") tracking.invalid = true
        if (event.type === "finish") {
          if (tracking.finished || event.reason === "error") tracking.invalid = true
          tracking.finished = true
          tracking.usage = event.usage
        }
      })),
      Stream.onExit((exit) => Exit.isSuccess(exit) && tracking.finished && !tracking.invalid && tracking.id
        ? safe(() => settle(file, tracking.id!, tracking.usage)).pipe(Effect.orDie) : Effect.void),
      Stream.provideService(Current, tracking),
    )
  }))
}

export const guarded = launcherLedger !== undefined
