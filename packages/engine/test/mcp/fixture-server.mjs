import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const control = process.argv[2]
const trace = process.argv[3]
const record = (value) => fs.appendFileSync(trace, JSON.stringify(value) + "\n")
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")
const input = readline.createInterface({ input: process.stdin })
const held = []
console.error(process.env.FIXTURE_MCP_SECRET ?? "fixture-stderr")
record({ event: "started", pid: process.pid, cwd: process.cwd() })
input.on("close", () => {
  record({ event: "closed" })
  process.exit(0)
})
input.on("line", (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined)
    return record({ event: "notification", method: request.method })
  const state = JSON.parse(fs.readFileSync(control, "utf8"))
  record({ event: "request", method: request.method, params: request.params })
  if (request.method === "initialize") {
    if (state.mode === "hang") return
    return send({
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "isolated-fixture", version: "1" },
      },
    })
  }
  if (request.method === "tools/list") {
    if (state.mode === "bad-cursor")
      return send({
        id: request.id,
        result: { tools: [], nextCursor: "repeated" },
      })
    if (state.mode === "paged" && !request.params?.cursor)
      return send({
        id: request.id,
        result: { tools: state.tools.slice(0, 1), nextCursor: "next" },
      })
    return send({
      id: request.id,
      result: {
        tools: state.mode === "paged" ? state.tools.slice(1) : state.tools,
      },
    })
  }
  if (request.method === "tools/call") {
    const name = request.params.name
    if (name === "hold") {
      held.push({
        id: request.id,
        text: request.params.arguments?.text ?? "old",
      })
      return
    }
    if (name === "release") {
      for (const result of held.splice(0))
        send({
          id: result.id,
          result: {
            content: [{ type: "text", text: result.text }],
            structuredContent: { text: result.text },
          },
        })
      return send({
        id: request.id,
        result: { content: [{ type: "text", text: "released" }] },
      })
    }
    if (name === "notify") {
      send({ method: "notifications/tools/list_changed" })
      return send({
        id: request.id,
        result: { content: [{ type: "text", text: "notified" }] },
      })
    }
    if (name === "disconnect") {
      input.close()
      return
    }
    const text =
      name === "notes"
        ? fs.readFileSync(path.join(process.cwd(), "notes.md"), "utf8")
        : (request.params.arguments?.text ?? "fixture result")
    return send({
      id: request.id,
      result: {
        content: [{ type: "text", text }],
        ...(name === "error"
          ? { isError: true }
          : { structuredContent: { text } }),
      },
    })
  }
  send({
    id: request.id,
    error: { code: -32601, message: "Unknown fixture method" },
  })
})
