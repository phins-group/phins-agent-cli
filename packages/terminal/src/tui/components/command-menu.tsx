import { createMemo } from "solid-js"
import { DialogSelect } from "./dialog-select"
import { type DialogContext } from "./dialog"
import {
  formatKeyBindings,
  comparePaletteCommands,
  isVisiblePaletteCommand,
  type OpenTuiKeymap,
  useKeymapSelector,
  usePHINsKeymap,
} from "../state/keymap"
import { useTuiConfig } from "../config/settings"

export function CommandPaletteDialog() {
  const config = useTuiConfig()
  const keymap = usePHINsKeymap()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const query = {
      namespace: "palette",
    }
    const reachable = keymap.getCommandEntries({
      ...query,
      visibility: "reachable",
      filter: isVisiblePaletteCommand,
    })
    const registeredBindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })

    return reachable.map((entry) => ({
      ...entry,
      bindings: registeredBindings.get(entry.command.name) ?? entry.bindings,
    }))
  })
  const options = createMemo(() =>
    entries().toSorted((a, b) => comparePaletteCommands(a.command, b.command)).map((entry) => ({
      title: `/${entry.command.slashName}`,
      description: typeof entry.command.title === "string" ? entry.command.title : undefined,
      category: typeof entry.command.category === "string" ? entry.command.category : undefined,
      footer: formatKeyBindings(entry.bindings, config),
      value: entry.command.name,
      onSelect: (dialog: DialogContext) => {
        dialog.clear()
        keymap.dispatchCommand(entry.command.name)
      },
    })),
  )

  return <DialogSelect title="Commands" options={options()} />
}
