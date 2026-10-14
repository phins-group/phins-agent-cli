import { createStateContext } from "./context"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createStateContext({
  name: "Args",
  init: (props: Args) => props,
})
