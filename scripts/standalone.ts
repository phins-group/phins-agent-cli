/** Set up the standalone edition before any engine modules read the environment. */
import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"

const home = path.resolve(process.env.PHINS_TEST_HOME
  ?? process.env.PHINS_LOCAL_HOME ?? path.join(os.homedir(), ".phins-agent-cli"))
await mkdir(home, { recursive: true, mode: 0o700 })
process.env.PHINS_TEST_HOME = home
process.env.PHINS_TEST_MANAGED_CONFIG_DIR ??= path.join(home, "managed")
process.env.PHINS_CONFIG_DIR ??= path.join(home, ".phins/config")
process.env.PHINS_DISABLE_AUTOUPDATE = "true"
process.env.PHINS_DISABLE_MODELS_FETCH = "true"

// The existing root CLI action opens the TUI; all subcommands use this same entry.
await import("../packages/terminal/src/index")
