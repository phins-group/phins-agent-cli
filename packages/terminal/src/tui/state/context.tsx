import { createContext, createMemo, Show, useContext, type Accessor, type ParentProps } from "solid-js"

type ReadyState = {
  ready?: Accessor<boolean> | boolean
}

export function createStateContext<T, Props extends Record<string, unknown>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const isReady = createMemo(() => {
        const ready = (init as T & ReadyState).ready
        return ready === undefined || (typeof ready === "function" ? ready() : ready)
      })
      return (
        <Show when={isReady()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
