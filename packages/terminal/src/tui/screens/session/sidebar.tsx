import { useProject } from "../../state/project"
import { useSessionState } from "../../state/sessions"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../theme/provider"
import { useTuiConfig } from "../../config/settings"
import { InstallationChannel } from "@phins/engine/runtime/version"
import { usePluginRuntime } from "../../extensions/provider"

import { getScrollAcceleration } from "../../platform/scroll"
import { WorkspaceLabel } from "../../components/workspace-label"
import { VerificationHistoryPanel } from "./verification-history-panel"

export function Sidebar(props: { sessionID?: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSessionState()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const sessionID = createMemo(() => props.sessionID ?? "")
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const title = createMemo(() => session()?.title ?? "New session")
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={42}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      position={props.overlay ? "absolute" : "relative"}
    >
      <box flexShrink={0} paddingBottom={2}>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.success }}>•</span>{" "}
          <span style={{ fg: theme.text }}>PHINs</span> <span>v0.1.0</span>
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <box flexShrink={0} gap={1} paddingRight={1}>
          <pluginRuntime.Slot
            name="sidebar_title"
            mode="single_winner"
            session_id={sessionID()}
            title={title()}
            share_url={session()?.share?.url}
          >
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{title()}</b>
              </text>
              <Show when={InstallationChannel !== "latest" && props.sessionID}>
                <text fg={theme.textMuted}>{props.sessionID}</text>
              </Show>
              <Show when={session()?.workspaceID}>
                {(workspaceID) => (
                  <text fg={theme.textMuted}>
                    <Show when={workspace()} fallback={<WorkspaceLabel type="unknown" name={workspaceID()} status="error" icon />}>
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                )}
              </Show>
              <Show when={session()?.share?.url}>
                {(shareURL) => <text fg={theme.textMuted}>{shareURL()}</text>}
              </Show>
            </box>
          </pluginRuntime.Slot>
          <VerificationHistoryPanel sessionID={props.sessionID} color={theme.textMuted} />
          <pluginRuntime.Slot name="sidebar_content" session_id={sessionID()} />
        </box>
      </scrollbox>
      <box flexShrink={0} paddingTop={1}>
        <pluginRuntime.Slot name="sidebar_footer" session_id={sessionID()} />
      </box>
    </box>
  )
}
