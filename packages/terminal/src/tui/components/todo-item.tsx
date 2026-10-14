import { useTheme } from "../theme/provider"

export interface TodoItemProps {
  status: string
  content: string
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" gap={0}>
      <text
        flexShrink={0}
        style={{
          fg: props.status === "completed" ? theme.success : props.status === "in_progress" ? theme.info : theme.textMuted,
        }}
      >
        {props.status === "completed" ? "✓" : props.status === "in_progress" ? "◉" : "○"}{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: props.status === "in_progress" ? theme.info : theme.secondary,
        }}
      >
        {props.content}
      </text>
    </box>
  )
}
