import { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useTheme } from "../theme/provider"
import { useTuiConfig } from "../config/settings"
import { getScrollAcceleration } from "../platform/scroll"
import { useCommandShortcut } from "../state/keymap"

/** One scroll owner for the feed. OpenTUI preserves manual scrolling while streaming. */
export function ConversationViewport(props: {
  children: JSX.Element
  ref?: (scroll: ScrollBoxRenderable) => void
  scrollbar?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const config = useTuiConfig()
  const shortcut = useCommandShortcut("session.last")
  const [readingHistory, setReadingHistory] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined
  const update = () => {
    if (!scroll || scroll.isDestroyed) return
    setReadingHistory(scroll.scrollHeight - scroll.viewport.height - scroll.scrollTop > 1)
  }
  const latest = () => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
    update()
  }
  // A layout resize can change the distance to the end without moving the bar.
  renderer.on("frame", update)
  onCleanup(() => {
    renderer.off("frame", update)
    scroll?.verticalScrollBar.off("change", update)
  })
  return <box flexGrow={1} minHeight={0} minWidth={0}>
    <scrollbox
      id="conversation-feed"
      ref={(value) => {
        scroll = value
        value.verticalScrollBar.on("change", update)
        props.ref?.(value)
      }}
      paddingLeft={1}
      paddingRight={1}
      viewportOptions={{ paddingRight: props.scrollbar ? 1 : 0 }}
      verticalScrollbarOptions={{ paddingLeft: 1, visible: !!props.scrollbar,
        trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border } }}
      stickyScroll
      stickyStart="bottom"
      flexGrow={1}
      minHeight={0}
      scrollAcceleration={getScrollAcceleration(config)}
    >
      {props.children}
    </scrollbox>
    <Show when={readingHistory()}>
      <box flexShrink={0} alignItems="center" onMouseUp={latest}>
        <text fg={theme.secondary}>↓ Back to latest <span style={{ fg: theme.textMuted }}>{shortcut()}</span></text>
      </box>
    </Show>
  </box>
}
