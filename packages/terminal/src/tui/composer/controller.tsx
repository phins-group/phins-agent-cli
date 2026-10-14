import { createStateContext } from "../state/context"
import type { PromptRef } from "./input"

export const { use: usePromptRef, provider: PromptRefProvider } = createStateContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
