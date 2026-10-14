/** Registry route động và API lifecycle mặc định cho TUI plugins. @module */
import type { TuiPluginApi, TuiRouteDefinition } from "./contracts"
import { createSignal } from "solid-js"

type RouteEntry = {
  key: symbol
  render: TuiRouteDefinition["render"]
}

export type RouteMap = Map<string, RouteEntry[]>

/** Registry route dạng stack; contribution đăng ký sau cùng có quyền hiển thị. */
export function createPluginRoutes() {
  const routes: RouteMap = new Map()
  const [revision, setRevision] = createSignal(0)

  return {
    register(list: TuiRouteDefinition[]) {
      const key = Symbol()
      list.forEach((item) => routes.set(item.name, [...(routes.get(item.name) ?? []), { key, render: item.render }]))
      setRevision((value) => value + 1)

      return () => {
        list.forEach((item) => {
          const next = routes.get(item.name)?.filter((entry) => entry.key !== key) ?? []
          if (next.length) {
            routes.set(item.name, next)
            return
          }
          routes.delete(item.name)
        })
        setRevision((value) => value + 1)
      }
    },
    get(name: string) {
      revision()
      return routes.get(name)?.at(-1)?.render
    },
  }
}

export type PluginRoutes = ReturnType<typeof createPluginRoutes>

/** Bổ sung lifecycle no-op trước khi host thay bằng scope riêng của từng plugin. */
export function createTuiApi(input: Omit<TuiPluginApi, "lifecycle">): TuiPluginApi {
  return {
    ...input,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose() {
        return () => {}
      },
    },
  }
}
