import { define } from "../../../src/extensions/api"
import { Effect } from "effect"

export default define({
  id: "config-interrupted-plugin",
  effect: () => Effect.interrupt,
})
