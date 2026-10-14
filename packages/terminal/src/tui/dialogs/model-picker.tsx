import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { usePreferences } from "../state/preferences"
import { sortBy } from "remeda"
import { ModelSelect } from "../components/model-select"
import type { ModelChoice } from "../../shared/model-info"
import { useDialog } from "../components/dialog"
import { VariantPickerDialog } from "./variant-picker"
import { useConnected } from "../state/connection"
import { useSessionState } from "../state/sessions"
import { useAgentClient } from "../state/agent-client"
import { useTuiPaths } from "../state/environment"
import { useToast } from "../components/toast"
import { modelAvailable } from "../transport/mapping"

export function ModelPickerDialog(props: { providerID?: string }) {
  const local = usePreferences()
  const sync = useSessionState()
  const dialog = useDialog()
  const [refreshing, setRefreshing] = createSignal(false)
  const sdk = useAgentClient()
  const paths = useTuiPaths()
  const toast = useToast()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  onMount(async () => {
    dialog.setSize("model")
    const providerID = props.providerID ?? local.model.current()?.providerID ?? sync.data.provider[0]?.id
    if (!providerID) return
    setRefreshing(true)
    try {
      await sdk.client.v2.model.list({
        location: { directory: sdk.directory ?? paths.cwd }, refresh: providerID,
      }, { signal: controller.signal, throwOnError: true })
      if (!controller.signal.aborted) await sync.bootstrap()
    } catch {
      if (!controller.signal.aborted) toast.show({
        message: "Could not refresh provider models. Showing saved models; check the key or connection.",
        variant: "warning",
      })
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  })

  const connected = useConnected()

  const options = createMemo<ModelChoice[]>(() => {
    const favorites = connected() ? local.model.favorite() : []
    return sortBy(sync.data.provider, (provider) => provider.id !== "phins", (provider) => provider.name)
      .filter((provider) => !props.providerID || provider.id === props.providerID)
      .flatMap((provider) => sortModelOptions(Object.entries(provider.models)
        .filter(([id, info]) => info.status !== "deprecated" && !(provider.id === "phins" && id.includes("-nano")))
        .map(([id, info]) => {
          const matches = (item: { providerID: string; modelID: string }) => item.providerID === provider.id && item.modelID === id
          const favorite = favorites.some(matches)
          return {
            value: { providerID: provider.id, modelID: id },
            title: info.name ?? id,
            providerName: provider.name,
            supportsTools: modelAvailable(info) && info.capabilities.toolcall,
            releaseDate: info.release_date,
            footer: info.cost?.input === 0 && provider.id === "phins" ? "Free" : undefined,
            favorite,
          }
        }), props.providerID !== undefined))
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    // Variant selection lives here, including when reselecting the current model.
    if (list.length > 0) {
      dialog.replace(() => <VariantPickerDialog />)
      return
    }
    dialog.clear()
  }

  return <ModelSelect options={options()} current={local.model.current()} loading={refreshing()}
    onSelect={(value) => onSelect(value.providerID, value.modelID)} onCancel={() => dialog.clear()}
    onFavorite={connected() ? (value) => local.model.toggleFavorite(value) : undefined} />
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
