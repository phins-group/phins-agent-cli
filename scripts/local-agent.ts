/** Launch the full native CLI with state isolated from installed Phins Agents. */
import { mkdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const home = path.resolve(process.env.PHINS_LOCAL_HOME ?? path.join(root, ".local/home"))
await mkdir(home, { recursive: true, mode: 0o700 })
const child = Bun.spawn({
  cmd: [process.execPath, path.join(root, "packages/terminal/src/index.ts"),
    ...process.argv.slice(2)],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PHINS_TEST_HOME: home,
    PHINS_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
    PHINS_CONFIG_DIR: path.join(home, ".phins/config"),
    PHINS_DISABLE_AUTOUPDATE: "true",
    PHINS_DISABLE_MODELS_FETCH: "true",
    PHINS_MODELS_PATH: path.join(root, "configs/models.json"),
  },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal))
process.exitCode = await child.exited
