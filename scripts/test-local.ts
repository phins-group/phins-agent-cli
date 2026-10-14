import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tests = (await readdir(import.meta.dir)).filter(name => name.endsWith(".test.mjs"))
  .sort().map(name => `scripts/${name}`)
const sourceTests = Bun.spawn(["node", "--test", ...tests], {
  cwd: path.resolve(import.meta.dir, ".."),
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
if (await sourceTests.exited !== 0) process.exit(1)

const home = await mkdtemp(path.join(os.tmpdir(), "phins-native-suite-"))
const child = Bun.spawn(["pnpm", "-r", "--if-present", "test"], {
  cwd: path.resolve(import.meta.dir, ".."),
  env: { ...process.env, PHINS_CHANNEL: "local", PHINS_TEST_HOME: home,
    PHINS_DISABLE_MODELS_FETCH: "true", RECORD: "false" },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal))
try {
  process.exitCode = await child.exited
} finally {
  await rm(home, { recursive: true, force: true })
}
