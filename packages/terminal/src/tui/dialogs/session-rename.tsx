import { DialogPrompt } from "../components/dialog-prompt"
import { useDialog } from "../components/dialog"
import { useSessionState } from "../state/sessions"
import { createMemo, createSignal } from "solid-js"
import { useAgentClient } from "../state/agent-client"
import { useToast } from "../components/toast"

interface RenameSessionProps {
  session: string
}

export function RenameSessionDialog(props: RenameSessionProps) {
  const dialog = useDialog()
  const sync = useSessionState()
  const sdk = useAgentClient()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      busy={busy()}
      onConfirm={async (value) => {
        if (busy()) return
        setBusy(true)
        try {
          await sdk.client.session.update({ sessionID: props.session, title: value }, { throwOnError: true })
          dialog.clear()
        } catch (error) {
          toast.error(error)
        } finally {
          setBusy(false)
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
