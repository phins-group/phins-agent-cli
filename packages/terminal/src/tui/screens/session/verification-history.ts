import type { VerificationHistoryItem } from "@phins/engine/transport/client/create"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { useEvent } from "../../state/event"
import { useAgentClient } from "../../state/agent-client"

type State = { status: "loading" | "unavailable"; items: [] } | { status: "ready"; items: VerificationHistoryItem[] }

const verdicts = ["pending", "passed", "failed", "error", "timeout", "missing", "stale", "abandoned"]

export function useVerificationHistory(sessionID: Accessor<string | undefined>) {
  const sdk = useAgentClient()
  const events = useEvent()
  const [revision, refresh] = createSignal(0)
  const [state, setState] = createSignal<State>({ status: "ready", items: [] })
  let active: AbortController | undefined
  let deleted: string | undefined

  onCleanup(
    events.subscribe((event) => {
      if (event.type === "session.deleted" && event.properties.info.id === sessionID()) {
        deleted = sessionID()
        active?.abort()
        setState({ status: "unavailable", items: [] })
        return
      }
      if (
        event.type === "server.connected" ||
        ((event.type === "session.next.verification.requested" ||
          event.type === "session.next.verification.settled" ||
          event.type === "session.next.moved") &&
          event.properties.sessionID === sessionID())
      )
        refresh((value) => value + 1)
    }),
  )

  createEffect(() => {
    revision()
    const id = sessionID()
    if (deleted && id === deleted) return
    deleted = undefined
    if (!id) {
      setState({ status: "ready", items: [] })
      return
    }
    const controller = new AbortController()
    active = controller
    onCleanup(() => controller.abort())
    setState({ status: "loading", items: [] })
    void sdk.client.v2.session
      .verificationHistory({ sessionID: id }, { signal: controller.signal, throwOnError: true })
      .then((response) => {
        if (controller.signal.aborted) return
        const items = response.data.data
        // Fail closed on incompatible servers; never interpret missing data as success.
        if (
          !Array.isArray(items) ||
          items.length > 50 ||
          items.some(
            (item) =>
              !item ||
              item.sessionID !== id ||
              item.mode !== "shadow" ||
              item.freshness !== "unverified" ||
              !verdicts.includes(item.verdict) ||
              !Number.isSafeInteger(item.time?.requested) ||
              item.time.requested < 0 ||
              item.time.requested > 8.64e15,
          )
        )
          throw new Error("Invalid verification history")
        setState({ status: "ready", items })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable", items: [] })
      })
  })

  return state
}
