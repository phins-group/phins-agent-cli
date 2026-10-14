import { createStore, reconcile } from "solid-js/store"
import { createStateContext } from "./context"
import type { PromptInfo } from "../composer/history"
import { useTuiStartup } from "./environment"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID?: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useNavigation, provider: NavigationProvider } = createStateContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      normalizeRoute(props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "session" }),
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(normalizeRoute(route)))
      },
    }
  },
})

function normalizeRoute(route: Route): Route {
  if (route.type === "home") return { type: "session", prompt: route.prompt }
  return route
}

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "session" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type NavigationContext = ReturnType<typeof useNavigation>

export function useScreenRoute<T extends Route["type"]>(type: T) {
  const route = useNavigation()
  return route.data as Extract<Route, { type: typeof type }>
}
