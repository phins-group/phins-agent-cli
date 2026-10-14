// Separate processes keep module state and test hooks isolated. Keep the worker
// count small: Git, SQLite and subprocess suites compete for the same disk.
export function testShards(files: readonly string[], workers = 2): string[][] {
  if (!Number.isInteger(workers) || workers < 1 || workers > 4)
    throw new Error("Test workers must be an integer from 1 to 4")
  if (new Set(files).size !== files.length)
    throw new Error("Test discovery contains duplicate files")
  const shards = Array.from(
    { length: Math.min(workers, files.length) },
    () => [] as string[],
  )
  for (const [index, file] of files.toSorted().entries())
    shards[index % shards.length]!.push(file)
  return shards
}

export async function runTestShards(input: {
  files: readonly string[]
  cwd: string
  command: (files: readonly string[]) => string[]
  workers?: number
}): Promise<number> {
  const started = performance.now()
  const shards = testShards(input.files, input.workers)
  if (!shards.length) throw new Error("Refusing an empty test suite")
  const children = shards.map((files) =>
    Bun.spawn(input.command(files), {
      cwd: input.cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
    }),
  )
  const interrupt = () => children.forEach((child) => child.kill("SIGINT"))
  const terminate = () => children.forEach((child) => child.kill("SIGTERM"))
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    const codes = await Promise.all(
      children.map(async (child, index) => {
        const code = await child.exited
        if (code !== 0)
          console.error(
            `Test shard ${index + 1}/${shards.length} failed (${code})`,
          )
        return code
      }),
    )
    console.log(
      `Test phase: ${input.files.length} files, ${shards.length} worker(s), ${((performance.now() - started) / 1000).toFixed(3)}s`,
    )
    return codes.find((code) => code !== 0) ?? 0
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}
