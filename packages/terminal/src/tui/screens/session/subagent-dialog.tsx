import { DialogSelect } from "../../components/dialog-select"
import { useNavigation } from "../../state/navigation"
import type { AgentRun } from "@phins/engine/transport/client/create"

export function SubagentDialog(props: {
  agents: AgentRun[]
  current?: string
  onCancel?: (sessionID: string) => void
  onBackground?: (sessionID: string) => void
}) {
  const route = useNavigation()

  function statusLabel(agent: AgentRun) {
    const pieces: string[] = [agent.status]
    if (agent.background) pieces.push("background")
    if (agent.blockers.length > 0) pieces.push(`${agent.blockers.length} blocker${agent.blockers.length === 1 ? "" : "s"}`)
    return pieces.join(" - ")
  }

  function category(agent: AgentRun) {
    if (agent.status === "running" || agent.status === "blocked") return "Active"
    return "Finished"
  }

  return (
    <DialogSelect
      title="Agent Manager"
      current={props.agents.find((agent) => agent.sessionID === props.current)}
      options={props.agents.map((agent) => ({
        title: agent.title || agent.agent || agent.sessionID,
        value: agent,
        description: statusLabel(agent),
        category: category(agent),
        details: [
          agent.model ? `${agent.model.providerID}/${agent.model.modelID}${agent.model.variant ? `:${agent.model.variant}` : ""}` : "",
          agent.scope?.description ?? "",
          ...agent.blockers.map((blocker) => blocker.title ?? blocker.type),
        ].filter(Boolean),
        footer: `${agent.sessionID.slice(0, 12)}${agent.counters?.toolCalls ? ` - ${agent.counters.toolCalls} tools` : ""}`,
        onSelect: (dialog) => {
          route.navigate({
            type: "session",
            sessionID: agent.sessionID,
          })
          dialog.clear()
        },
      }))}
      actions={[
        {
          command: "agent.run.cancel",
          title: "Cancel",
          disabled: (option) => option?.value.status !== "running",
          onTrigger: (option) => props.onCancel?.(option.value.sessionID),
        },
        {
          command: "agent.run.background",
          title: "Background",
          disabled: (option) => option?.value.status !== "running" || option.value.background,
          onTrigger: (option) => props.onBackground?.(option.value.sessionID),
        },
      ]}
    />
  )
}
