import { createMemo } from "solid-js"
import { useSessionState } from "../../state/sessions"
import { DialogSelect } from "../../components/dialog-select"
import { useClipboard } from "../../state/clipboard"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
}) {
  const sync = useSessionState()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
      ]}
    />
  )
}
