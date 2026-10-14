import { createMemo } from "solid-js"
import { useSessionState } from "./sessions"

export function useConnected() {
  const sync = useSessionState()
  return createMemo(() =>
    sync.data.provider.some(
      (provider) =>
        provider.id !== "phins" || Object.values(provider.models).some((model) => model.cost?.input !== 0),
    ),
  )
}
