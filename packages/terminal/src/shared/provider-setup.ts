/** Local onboarding: the existing integration service owns all credentials. */
import { Effect, Option, Redacted } from "effect"
import type { Prompt } from "effect/unstable/cli"
import type { createPHINsClient } from "@phins/engine/transport/client/create"
import { mkdir, open, lstat } from "node:fs/promises"
import path from "node:path"
import preset from "../../../../configs/nebius.example.json"
import { readJson, writeJsonAtomic } from "./storage"
import { preferredNebiusModel, type ModelChoice } from "./model-info"

export type SelectedModel = { providerID: string; modelID: string }
export function selectedModel(value: unknown): SelectedModel | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.providerID !== "string" || !item.providerID
    || typeof item.modelID !== "string" || !item.modelID) return
  return { providerID: item.providerID, modelID: item.modelID }
}

export async function readSelectedModel(state: string) {
  const data = await readJson<{ selected?: unknown }>(path.join(state, "model.json")).catch(() => undefined)
  return selectedModel(data?.selected)
}

export async function saveSelectedModel(state: string, model: SelectedModel) {
  const file = path.join(state, "model.json")
  const saved = await readJson<Record<string, unknown>>(file).catch(() => ({}))
  await writeJsonAtomic(file, { ...saved, selected: model })
}

/** Seed only a fresh local profile; existing and explicit config wins. No key. */
export async function ensureProviderConfig(directory: string, explicit?: string) {
  if (explicit) return
  for (const name of ["config.json", "phins.json", "phins.jsonc"])
    if (await lstat(path.join(directory, name)).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await open(path.join(directory, "config.json"), "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return undefined
    throw error
  })
  if (!file) return
  try { await file.writeFile(JSON.stringify(preset, null, 2) + "\n") }
  finally { await file.close() }
}

type Client = ReturnType<typeof createPHINsClient>
export type ProviderSetupPrompts<R> = {
  select<T>(options: Prompt.SelectOptions<T>): Effect.Effect<T, Error, R>
  password(options: Prompt.TextOptions): Effect.Effect<Redacted.Redacted, Error, R>
  model(options: { message: string; choices: ModelChoice[] }): Effect.Effect<SelectedModel, Error, R>
}

export const providerSetup = Effect.fn("terminal.provider.setup")(function* <R>(
  client: Client, location: { directory: string; workspace?: string },
  prompts: ProviderSetupPrompts<R>,
) {
  const integrations = yield* Effect.tryPromise({
    try: async (signal) => (await client.v2.integration.list({ location }, {
      signal, throwOnError: true,
    })).data.data,
    catch: () => new Error("Unable to load local provider settings."),
  })
  const providers = integrations.filter((item) =>
    item.methods.some((method) => method.type === "key"))
    .sort((a, b) => Number(a.id !== "nebius") - Number(b.id !== "nebius"))
  if (!providers.length)
    return yield* Effect.fail(new Error("No API-key provider is configured. Check the local provider configuration."))
  const providerID = providers.length === 1 ? providers[0]!.id : yield* prompts.select({
    message: "Provider", choices: providers.map((item) => ({ title: item.name, value: item.id })),
  })
  const provider = providers.find((item) => item.id === providerID)!
  const key = yield* prompts.password({
    message: `${provider.name} API key (saved locally; no inference)`,
    validate: (value) => value.trim() && !/[\r\n\0]/.test(value.trim())
      ? Effect.succeed(value.trim()) : Effect.fail("Enter a non-empty, single-line API key."),
  })
  yield* Effect.tryPromise({
    try: (signal) => client.v2.integration.connect.key({
      integrationID: providerID, location, key: Redacted.value(key), label: "Local setup",
    }, { signal, throwOnError: true }),
    // Never serialize request errors: they can retain the authorization payload.
    catch: () => new Error("Unable to save the API key. Retry setup; no inference was requested."),
  })
  // Only a provider metadata GET is made; no prompt or source code is sent.
  const refreshed = yield* Effect.tryPromise({
    try: async (signal) => (await client.v2.model.list({ location, refresh: providerID }, {
      signal, throwOnError: true,
    })).data.data,
    catch: () => new Error("Model refresh failed."),
  }).pipe(Effect.option)
  const available = Option.isSome(refreshed) ? refreshed.value : yield* Effect.tryPromise({
    try: async (signal) => (await client.v2.model.list({ location }, {
      signal, throwOnError: true,
    })).data.data,
    catch: () => new Error("API key saved. Unable to load models; run setup again."),
  })
  const models = available.filter((item) => item.providerID === providerID)
  if (!models.length)
    return yield* Effect.fail(new Error("API key saved. No enabled models are configured for this provider."))
  const choices: ModelChoice[] = models.map((item) => ({
    title: item.name || item.id,
    providerName: provider.name,
    supportsTools: item.enabled && item.status !== "deprecated" && item.capabilities.tools,
    value: { providerID, modelID: item.id },
  }))
  const preferred = preferredNebiusModel(choices)
  // Both frontends initially select the first choice. Keep every other model available.
  const ordered = preferred ? [preferred, ...choices.filter((item) => item !== preferred)] : choices
  return yield* prompts.model({
    message: Option.isSome(refreshed)
      ? "Default model (API key saved locally)"
      : "Default model (saved list; API refresh failed)",
    choices: ordered.map((item) => ({ ...item, recommended: item === preferred })),
  })
})
