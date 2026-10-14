/** Facts from durable tool records. Model prose is never test evidence. */
export interface ToolEvidence {
  name: string
  status: string
  input: Record<string, unknown>
  output: Record<string, unknown>
}
const mutations = new Set(["edit", "write", "apply_patch"])
export function summarizeTools(tools: readonly ToolEvidence[]) {
  const files = new Set<string>()
  const checks: { command: string; exitCode?: number; timedOut: boolean; afterLatestEdit: boolean }[] = []
  let edits = 0, lastEdit = -1, failedTools = 0, corrections = 0, failureSinceEdit = false
  tools.forEach((tool, index) => {
    if (tool.status === "error") { failedTools++; return }
    if (tool.status !== "completed") return
    if (mutations.has(tool.name)) {
      if (failureSinceEdit) { corrections++; failureSinceEdit = false }
      edits++
      lastEdit = index
      const name = tool.input.path ?? tool.input.filePath
      if (typeof name === "string") files.add(name)
      if (Array.isArray(tool.output.files)) for (const item of tool.output.files) {
        const file = item?.path ?? item?.filePath ?? item?.relativePath
        if (typeof file === "string") files.add(file)
      }
    }
    if (tool.name === "bash" && typeof tool.input.command === "string") {
      const exitCode = typeof tool.output.exitCode === "number" && Number.isInteger(tool.output.exitCode)
        ? tool.output.exitCode : undefined
      const timedOut = tool.output.timedOut === true
      if ((exitCode !== undefined && exitCode !== 0) || timedOut) failureSinceEdit = lastEdit >= 0
      checks.push({ command: tool.input.command, exitCode, timedOut, afterLatestEdit: false })
    }
  })
  let commandIndex = 0
  tools.forEach((tool, index) => {
    if (tool.name === "bash" && tool.status === "completed" && typeof tool.input.command === "string")
      checks[commandIndex++]!.afterLatestEdit = index > lastEdit
  })
  return { edits, changedFiles: [...files], failedTools, correctionAttempts: corrections, commands: checks,
    verification: "unverified" as const }
}
