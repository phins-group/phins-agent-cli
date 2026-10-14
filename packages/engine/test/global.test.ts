import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppPaths } from "../src/runtime/paths"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(AppPaths.directories.tmp).toBe(path.join(os.tmpdir(), "phins"))
    expect(AppPaths.resolvePaths().tmp).toBe(AppPaths.directories.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(AppPaths.directories.tmp)).isDirectory()).toBe(true)
  })
})
