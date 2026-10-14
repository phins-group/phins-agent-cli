import type { Provider } from "@phins/engine/transport/client/create"
import type { SelectedModel } from "./provider-setup"
import preset from "../../../../configs/nebius.example.json"

export type ModelChoice = {
  value: SelectedModel
  title: string
  providerName: string
  supportsTools?: boolean
  favorite?: boolean
  recommended?: boolean
}

/** Keep the competition integration first without hiding configured providers. */
export function modelPriority(value: SelectedModel) {
  if (value.providerID !== "nebius") return 3
  const id = value.modelID.toLowerCase()
  if (!id.startsWith("nvidia/")) return 2
  return id.includes("nemotron") ? 0 : 1
}

export function preferredNebiusModel(choices: readonly ModelChoice[]) {
  const candidates = choices.filter((item) => modelPriority(item.value) === 0 && item.supportsTools === true)
  return candidates.find((item) => `${item.value.providerID}/${item.value.modelID}` === preset.model) ?? candidates[0]
}

export function parseModelReference(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function indexProviders(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function findModel(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}
