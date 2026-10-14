import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Setter,
} from "solid-js"
import { useSessionState } from "../../state/sessions"
import { useTuiPaths } from "../../state/environment"

export type HomeSessionDestination = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }

type Context = {
  destination: Accessor<HomeSessionDestination | undefined>
  setDestination: Setter<HomeSessionDestination | undefined>
  clear: () => void
}

const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSessionState()
  const paths = useTuiPaths()
  const [selected, setDestination] = createSignal<HomeSessionDestination>()
  const destination = createMemo<HomeSessionDestination>(
    () => selected() ?? { type: "directory", directory: sync.path.directory || paths.cwd, subdirectory: false },
  )
  return (
    <HomeSessionDestinationContext.Provider
      value={{ destination, setDestination, clear: () => setDestination(undefined) }}
    >
      {props.children}
    </HomeSessionDestinationContext.Provider>
  )
}

export function useHomeSessionDestination() {
  return useContext(HomeSessionDestinationContext)
}
