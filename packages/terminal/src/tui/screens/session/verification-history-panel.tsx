import type { RGBA } from "@opentui/core"
import { For, Show } from "solid-js"
import { useVerificationHistory } from "./verification-history"

export function VerificationHistoryPanel(props: { sessionID?: string; color: RGBA }) {
  const history = useVerificationHistory(() => props.sessionID)
  return (
    <Show when={props.sessionID}>
      <box flexShrink={0}>
        <text fg={props.color}>
          <b>Verification history · shadow</b>
        </text>
        <text fg={props.color}>Current code: unverified</text>
        <Show when={history().status === "loading"}>
          <text fg={props.color}>Loading history…</text>
        </Show>
        <Show when={history().status === "unavailable"}>
          <text fg={props.color}>History unavailable</text>
        </Show>
        <Show when={history().status === "ready"}>
          <Show when={history().items.length} fallback={<text fg={props.color}>No historical checks</text>}>
            <For each={history().items.slice(0, 3)}>
              {(item) => (
                <text fg={props.color}>
                  {new Date(item.time.requested).toISOString().slice(0, 16).replace("T", " ")}
                  {" UTC · "}
                  {item.verdict}
                </text>
              )}
            </For>
            <Show when={history().items.length > 3}>
              <text fg={props.color}>Showing latest 3 checks</text>
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  )
}
