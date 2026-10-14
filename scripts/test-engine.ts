import { runTestShards } from "./test-shards"
const cwd = import.meta.dir + "/../packages/engine"
const files = await Array.fromAsync(new Bun.Glob("test/**/*.test.ts").scan({ cwd, onlyFiles: true }))
process.exitCode = await runTestShards({ cwd, files, command: files => ["bun", "test", ...files, "--timeout", "60000", "--only-failures"] })
