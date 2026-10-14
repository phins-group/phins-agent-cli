import { createStateContext } from "./context"

export type Exit = (reason?: unknown) => void

export const { use: useExit, provider: ExitProvider } = createStateContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
})

export const { use: useEpilogue, provider: EpilogueProvider } = createStateContext({
  name: "Epilogue",
  init: (props: { set(value?: string): void }) => props.set,
})
