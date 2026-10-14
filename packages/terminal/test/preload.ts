import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// AppPaths.directories is initialized on import, before individual tests can stub I/O.
const testHome = mkdtempSync(path.join(os.tmpdir(), "phins-cli-test-"))
process.env.PHINS_TEST_HOME = testHome
process.env.PHINS_DB = ":memory:"
process.env.PHINS_DISABLE_MODELS_FETCH = "true"
process.env.PHINS_MODELS_PATH = path.resolve(
  import.meta.dir,
  "../../engine/test/plugin/fixtures/models-dev.json",
)

afterAll(() => rmSync(testHome, { recursive: true, force: true }))
