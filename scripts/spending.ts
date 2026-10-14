/** Local owner tool: no key, provider call, or inferred spending authorization. */
import path from "node:path"
import { initialize, status, type Policy } from "../packages/engine/src/inference/request/spending"
const [action, file, policyFile] = process.argv.slice(2)
try {
  if (!file || !["init", "status"].includes(action!)) throw new Error()
  if (action === "init") {
    if (!policyFile) throw new Error()
    initialize(path.resolve(file), await Bun.file(policyFile).json() as Policy)
  }
  console.log(JSON.stringify(status(path.resolve(file)), null, 2))
} catch {
  console.error("Usage: bun scripts/spending.ts init <new-ledger.db> <reviewed-policy.json> | status <ledger.db>. Existing ledgers cannot be reset.")
  process.exitCode = 1
}
