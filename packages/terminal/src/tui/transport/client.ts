/** Existing TUI SDK calls translated to the one native service. */
import { Schema } from "effect"
import { TuiContext, TuiSession } from "@phins/engine/transport/api/resources/tui"
import {
  connectLocalService, createLocalServiceFetch,
  type LocalServiceConnection,
} from "@phins/engine/transport/client/connection"
import { watchSessionState } from "@phins/engine/transport/client/session-state"
import type { Event, GlobalEvent, Session, SessionV2Info, Part, Prompt } from "@phins/engine/transport/client/create"
import { agentInfo, permission, providers, sessionInfo, stateTranscript, transcript } from "./mapping"
import { randomUUID } from "node:crypto"
import { SessionMessage } from "@phins/engine/sessions/messages/service"
import path from "node:path"
import { modelRef } from "../../agent/session-target"

type Input = {
  title?: string; directory?: string; workspace?: string; agent?: string
  model?: string | { providerID: string; modelID?: string; id?: string; variant?: string }
  variant?: string; messageID?: string; parts?: Part[]; noReply?: boolean
  providerID?: string; modelID?: string
  command?: string; arguments?: string; time?: { archived: number | null }
  reply?: "once" | "always" | "reject"; message?: string; answers?: string[][]
}

function selectedModel(input: Input) {
  if (!input.model) return undefined
  const value = typeof input.model === "string" ? modelRef(input.model)!
    : { providerID: input.model.providerID, id: input.model.modelID ?? input.model.id ?? "" }
  if (!value.providerID || !value.id) throw new Error("Model must use provider/model format")
  return { ...value, variant: input.variant ?? (typeof input.model === "string" ? undefined : input.model.variant) }
}

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  value === undefined ? new Response(null, { status: 204, headers }) : Response.json(value, { status, headers })

export async function createTuiTransport(
  connection: LocalServiceConnection,
  directory: string,
  options: { recordOnly?: boolean; fetch?: (request: Request) => Promise<Response> } = {},
) {
  connection = { ...connection, headers: new Headers(connection.headers) }
  const controller = new AbortController()
  const signal = controller.signal
  const nativeFetch = createLocalServiceFetch(connection, { signal, fetch: options.fetch })
  const client = await connectLocalService(connection, { signal, fetch: options.fetch,
    required: ["service.generation.fence.v1", "session.prompt.durable.v1"] })
  const location = { directory }
  const listeners = new Set<(event: GlobalEvent) => void>()
  const watchers = new Map<string, Promise<void>>()
  const requestSessions = new Map<string, string>()
  const metadata = new Map<string, Session>()
  const details = new Map<string, Promise<typeof TuiSession.Type>>()
  const history = new Map<string, Set<string>>()
  const pendingPrompts = new Map<string, { id: string; signature: string }>()
  const pendingCommands = new Map<string, { id: string; signature: string }>()
  let globalTask: Promise<void> | undefined
  let context: Promise<typeof TuiContext.Type> | undefined

  async function native(route: string, init?: RequestInit) {
    const url = new URL(route, connection.url)
    const headers = new Headers(connection.headers)
    if (init?.body) headers.set("content-type", "application/json")
    return nativeFetch(new Request(url, { ...init, headers }))
  }
  async function presentation() {
    return context ??= native(`/api/tui?location[directory]=${encodeURIComponent(directory)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404
          ? "Agent local đang dùng bản cũ. Hãy kết thúc tác vụ đang chạy rồi mở lại CLI."
          : "Không đọc được cấu hình TUI từ Agent local")
        return Schema.decodeUnknownSync(TuiContext)(await response.json())
      }).catch((error) => { context = undefined; throw error })
  }
  function detail(id: string) {
    const existing = details.get(id)
    if (existing) return existing
    const task = (async () => {
      const response = await native(`/api/tui/session/${encodeURIComponent(id)}`)
      if (!response.ok) throw new Error("Không đọc được phiên từ Agent local")
      const value = Schema.decodeUnknownSync(TuiSession)(await response.json())
      metadata.set(id, value.info as Session)
      return value
    })().finally(() => details.delete(id))
    details.set(id, task)
    return task
  }
  type Payload = Event extends infer Value ? Value extends Event ? Omit<Value, "id"> : never : never
  function emit(value: Payload, target = directory) {
    const payload = { ...value, id: `evt_${randomUUID()}` } as Event
    for (const listener of listeners) listener({ directory: target, payload })
  }
  function failed(error: unknown) {
    if (signal.aborted) return
    emit({ type: "tui.toast.show", properties: { variant: "error",
      title: "Agent local", message: error instanceof Error ? error.message : "Mất kết nối Agent local" } })
  }

  async function admitPrompt(sessionID: string, prompt: Prompt, resume: boolean, messageID?: string, requestSignal = signal) {
    const signature = JSON.stringify({ text: prompt.text, files: prompt.files ?? [], agents: prompt.agents ?? [] })
    const previous = pendingPrompts.get(sessionID)
    const intent = previous?.signature === signature && (!messageID || previous.id === messageID)
      ? previous : { id: messageID ?? SessionMessage.ID.create(), signature }
    const call = { signal: requestSignal, throwOnError: true } as const
    const recover = async () => {
      const response = await client.v2.session.input({ sessionID, messageID: intent.id }, { ...call, throwOnError: false })
      if (response.response.status === 404) return undefined
      if (response.error) throw response.error
      const admitted = response.data?.data
      if (!admitted || admitted.id !== intent.id || admitted.sessionID !== sessionID ||
          JSON.stringify({ text: admitted.prompt.text, files: admitted.prompt.files ?? [], agents: admitted.prompt.agents ?? [] }) !== signature)
        throw new Error("Agent local returned an invalid prompt acknowledgement")
      return response.data
    }
    // A retry reconciles the original intent by reading. Never resend or wake
    // an already-admitted input just because the client lost its ACK.
    if (previous === intent) {
      const admitted = await recover()
      if (admitted) { pendingPrompts.delete(sessionID); return admitted }
    }
    pendingPrompts.set(sessionID, intent)
    try {
      const response = await client.v2.session.prompt({ sessionID, id: intent.id,
        prompt, delivery: "queue", resume }, call)
      pendingPrompts.delete(sessionID)
      return response.data
    } catch (error) {
      const admitted = await recover().catch(() => undefined)
      if (!admitted) throw error
      pendingPrompts.delete(sessionID)
      return admitted
    }
  }

  function watch(id: string) {
    if (watchers.has(id) || signal.aborted) return
    let previous = new Map<string, { info: string; parts: Map<string, string> }>()
    let failureRun: string | undefined
    const task = (async () => {
      for await (const state of watchSessionState(connection, { sessionID: id, limit: 200 }, {
        signal, fetch: options.fetch,
      })) {
        const target = state.snapshot.session.location.directory
        const previousInfo = metadata.get(id)
        const info = sessionInfo(state.snapshot.session as SessionV2Info)
        emit({ type: "session.updated", properties: { sessionID: id,
          info: previousInfo ? { ...previousInfo, ...info, slug: previousInfo.slug,
            version: previousInfo.version, time: { ...previousInfo.time, ...info.time } } : info } }, target)
        const run = state.snapshot.runState
        if (run && run.runID !== failureRun && (run.status === "terminal-failure" || run.status === "interrupted")) {
          failureRun = run.runID
          emit({ type: "session.error", properties: { sessionID: id,
            error: run.status === "interrupted" ? { name: "MessageAbortedError", data: { message: "Session stopped" } }
              : { name: "UnknownError", data: { message: run.error.message } } } }, target)
        }
        const shell = state.snapshot.messages.data.some((message) => message.type === "shell" && message.time.completed === undefined)
        emit({ type: "session.status", properties: { sessionID: id,
          status: run?.status === "busy" || shell ? { type: "busy" }
            : run?.status === "retrying" ? { type: "retry", attempt: run.attempt,
                message: run.error.message, next: run.nextRetryAt }
              : { type: "idle" } } }, target)
        const next = new Map<string, { info: string; parts: Map<string, string> }>()
        for (const entry of stateTranscript(state)) {
          let seen = history.get(id)
          if (!seen) history.set(id, seen = new Set())
          seen.add(entry.info.id)
          const old = previous.get(entry.info.id)
          const info = JSON.stringify(entry.info)
          if (old?.info !== info) emit({ type: "message.updated", properties: { sessionID: id, info: entry.info } }, target)
          const parts = new Map<string, string>()
          for (const part of entry.parts) {
            const encoded = JSON.stringify(part)
            parts.set(part.id, encoded)
            if (old?.parts.get(part.id) !== encoded)
              emit({ type: "message.part.updated", properties: { sessionID: id, part, time: Date.now() } }, target)
          }
          for (const partID of old?.parts.keys() ?? [])
            if (!parts.has(partID)) emit({ type: "message.part.removed",
              properties: { sessionID: id, messageID: entry.info.id, partID } }, target)
          next.set(entry.info.id, { info, parts })
        }
        // Window eviction never removes pages the TUI already loaded. Durable
        // transcript mutations below reconcile against the complete ID set.
        previous = next
      }
    })().catch(failed)
    watchers.set(id, task)
  }
  async function globalEvents() {
    const stream = await client.v2.event.subscribe({ signal, sseMaxRetryAttempts: 0 })
    for (const request of (await client.v2.question.request.list({ location }, { signal, throwOnError: true })).data.data) {
      requestSessions.set(request.id, request.sessionID)
      emit({ type: "question.asked", properties: request })
    }
    for await (const event of stream.stream) {
      if (signal.aborted) return
      if (event.type === "server.connected") {
        emit({ type: "server.connected", properties: {} })
        continue
      }
      const target = "location" in event ? event.location?.directory ?? directory : directory
      switch (event.type) {
        case "session.next.revert.committed":
        case "session.next.transcript.reset": {
          const id = event.data.sessionID
          if (!history.has(id)) break
          const value = await detail(id)
          const current = new Set([...value.messageIDs, ...value.pending.map((input) => input.id)])
          for (const messageID of history.get(id)!) {
            if (!current.has(messageID as typeof value.messageIDs[number])) {
              emit({ type: "message.removed", properties: { sessionID: id, messageID } }, target)
              history.get(id)!.delete(messageID)
            }
          }
          break
        }
        case "session.next.prompt.admitted":
        case "session.next.prompt.origin.admitted": {
          const session = (await client.v2.session.get({ sessionID: event.data.sessionID }, { signal, throwOnError: true })).data.data
          const [entry] = transcript(session, [{ type: "user", id: event.data.messageID,
            time: { created: event.data.timestamp }, ...event.data.prompt }])
          emit({ type: "message.updated", properties: { sessionID: session.id, info: entry!.info } }, target)
          for (const part of entry!.parts) emit({ type: "message.part.updated",
            properties: { sessionID: session.id, part, time: event.data.timestamp } }, target)
          break
        }
        case "session.created":
        case "session.updated": {
          metadata.set(event.data.sessionID, event.data.info)
          emit({ type: event.type, properties: event.data }, target)
          break
        }
        case "session.deleted":
          emit({ type: "session.deleted", properties: event.data }, target)
          break
        case "permission.v2.asked":
          requestSessions.set(event.data.id, event.data.sessionID)
          emit({ type: "permission.asked", properties: permission(event.data) }, target)
          break
        case "permission.v2.replied":
          requestSessions.delete(event.data.requestID)
          emit({ type: "permission.replied", properties: event.data }, target)
          break
        case "question.v2.asked":
          requestSessions.set(event.data.id, event.data.sessionID)
          emit({ type: "question.asked", properties: event.data }, target)
          break
        case "question.v2.replied":
          requestSessions.delete(event.data.requestID)
          emit({ type: "question.replied", properties: event.data }, target)
          break
        case "question.v2.rejected":
          requestSessions.delete(event.data.requestID)
          emit({ type: "question.rejected", properties: event.data }, target)
          break
        case "todo.updated":
          emit({ type: "todo.updated", properties: event.data }, target)
          break
        case "catalog.updated":
          context = undefined
          emit({ type: "server.instance.disposed", properties: { directory } }, target)
          break
      }
    }
    if (!signal.aborted) throw new Error("Mất kết nối Agent local. Mở lại CLI để kết nối.")
  }

  const adapter = async (request: Request): Promise<Response> => {
    signal.throwIfAborted()
    const url = new URL(request.url)
    if (url.origin !== new URL(connection.url).origin)
      throw new Error("TUI request must stay on its registered Node")
    if (url.pathname.startsWith("/api/")) return nativeFetch(request)
    const route = url.pathname
    const method = request.method
    const raw = method === "GET" || method === "HEAD" ? "" : await request.text()
    const body: Input = raw ? JSON.parse(raw) : {}
    const call = { signal: AbortSignal.any([signal, request.signal]), throwOnError: true } as const
    const readSession = async (id: string) => {
      const value = (await client.v2.session.get({ sessionID: id }, call)).data.data
      return value
    }
    if (method === "GET") {
      if (["/path", "/project/current", "/config", "/vcs", "/mcp", "/formatter"].includes(route)) {
        if (route === "/mcp") context = undefined
        const value = await presentation()
        return json(route === "/path" ? value.path : route === "/project/current" ? value.project
          : route === "/config" ? { ...value.config, model: value.defaultModel ?? value.config.model }
            : route === "/vcs" ? value.vcs : route === "/formatter" ? value.formatter ?? [] : value.mcp)
      }
      if (/^\/project\/[^/]+\/directories$/.test(route)) return json((await presentation()).directories)
      if (route === "/config/providers" || route === "/provider") {
        const [available, models, value] = await Promise.all([
          client.v2.provider.list({ location }, call), client.v2.model.list({ location }, call), presentation(),
        ])
        const values = providers(available.data.data, models.data.data)
        const defaults = Object.fromEntries(values.map((provider) => [provider.id,
          value.defaultModel?.startsWith(`${provider.id}/`)
            ? value.defaultModel.slice(provider.id.length + 1) : Object.keys(provider.models)[0]]))
        return json(route === "/provider" ? { all: values, default: defaults, connected: values.map((provider) => provider.id) }
          : { providers: values, default: defaults })
      }
      if (route === "/agent") return json((await client.v2.agent.list({ location }, call)).data.data.map(agentInfo))
      if (route === "/skill") return json((await client.v2.skill.list({ location }, call)).data.data)
      if (route === "/command") return json((await client.v2.command.list({ location }, call)).data.data.map((command) => ({
        ...command, model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
      })))
      if (route === "/permission" || route === "/question") {
        const values = route === "/permission"
          ? (await client.v2.permission.request.list({ location }, call)).data.data.map(permission)
          : (await client.v2.question.request.list({ location }, call)).data.data
        for (const value of values) requestSessions.set(value.id, value.sessionID)
        return json(values)
      }
      if (route === "/session") {
        const scoped = await client.v2.location.get({ location }, call)
        const all = [] as SessionV2Info[]
        let cursor: string | undefined
        do {
          const response = await client.v2.session.list({
            ...(url.searchParams.get("scope") === "project" ? { project: scoped.data.project.id } : { directory }),
            search: url.searchParams.get("search") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 200), cursor,
          }, call)
          all.push(...response.data.data)
          cursor = url.searchParams.has("limit") ? undefined : response.data.cursor.next
        } while (cursor)
        const start = Number(url.searchParams.get("start") ?? 0)
        return json(all.filter((value) => value.time.updated >= start).map(sessionInfo))
      }
      if (route === "/session/status") {
        return native(`/api/tui/status?location[directory]=${encodeURIComponent(directory)}`)
      }
      const match = /^\/session\/([^/]+)(?:\/(message|todo|diff))?$/.exec(route)
      if (match) {
        const id = decodeURIComponent(match[1])
        const value = await readSession(id)
        watch(id)
        if (!match[2]) return json((await detail(id)).info)
        if (match[2] !== "message") return json((await detail(id))[match[2] as "todo" | "diff"])
        const response = await client.v2.session.messages({ sessionID: id,
          limit: Number(url.searchParams.get("limit") ?? 100), order: "desc",
          cursor: url.searchParams.get("before") ?? undefined }, call)
        const next = response.data.cursor.next
        const entries = transcript(value, response.data.data.toReversed())
        if (!url.searchParams.has("before")) {
          for (const pending of (await detail(id)).pending) {
            if (entries.some((entry) => entry.info.id === pending.id)) continue
            entries.push(...transcript(value, [{ type: "user", id: pending.id,
              time: { created: pending.time }, ...pending.prompt }]))
          }
        }
        let seen = history.get(id)
        if (!seen) history.set(id, seen = new Set())
        for (const entry of entries) seen.add(entry.info.id)
        return json(entries, 200,
          next ? { "X-Next-Cursor": next } : undefined)
      }
      if (route === "/find/file") return json((await client.v2.fs.find({ location,
        query: url.searchParams.get("query") ?? "", limit: url.searchParams.get("limit") ?? "50",
      }, call)).data.data.map((entry) => entry.path))
      // These registries do not exist in the native runtime. Reads describe
      // their actual absence; mutations below always return an explicit error.
      if (["/experimental/workspace", "/experimental/workspace/status",
        "/experimental/workspace/adapter"].includes(route)) return json([])
      if (route === "/experimental/console") return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      if (route === "/experimental/capabilities") return json({ backgroundSubagents: false })
      if (route === "/experimental/resource") return json({})
      if (route === "/provider/auth") {
        const values = (await client.v2.integration.list({ location }, call)).data.data
        return json(Object.fromEntries(values.map((value) => [value.id, value.methods
          .filter((method) => method.type !== "env")
          .map((method) => ({ ...method, type: method.type === "key" ? "api" : "oauth", label: method.label ?? "API key" }))])))
      }
    }
    if (method === "POST" && route === "/session") {
      const value = (await client.v2.session.create({
        agent: body.agent, model: selectedModel(body), title: body.title,
        location: { directory: body.directory ? path.resolve(body.directory) : directory,
          workspaceID: body.workspace },
      }, call)).data.data
      return json(sessionInfo(value))
    }
    const mcp = /^\/mcp\/([^/]+)\/(connect|disconnect)$/.exec(route)
    if (method === "POST" && mcp) {
      context = undefined
      return native(`/api/tui/mcp/${encodeURIComponent(decodeURIComponent(mcp[1]))}?location[directory]=${encodeURIComponent(directory)}`, {
        method: "POST", body: JSON.stringify({ enabled: mcp[2] === "connect" }),
      })
    }
    const metadataRoute = /^\/session\/([^/]+)(?:\/(fork))?$/.exec(route)
    if (metadataRoute && ["PATCH", "DELETE", "POST"].includes(method)) {
      if (method === "POST" && !metadataRoute[2]) return json({ message: "Unsupported session operation" }, 405)
      return native(`/api/tui/session/${encodeURIComponent(decodeURIComponent(metadataRoute[1]))}${metadataRoute[2] ? "/fork" : ""}`, {
        method, body: method === "DELETE" ? undefined : JSON.stringify(body),
      })
    }
    const match = /^\/session\/([^/]+)\/(message|prompt_async|abort|shell|command|summarize|revert|unrevert)$/.exec(route)
    if (method === "POST" && match) {
      const id = decodeURIComponent(match[1])
      if (match[2] === "summarize" && options.recordOnly) throw new Error("Record-only mode cannot call a model")
      watch(id)
      const value = await readSession(id)
      const model = selectedModel(match[2] === "summarize" && body.providerID && body.modelID
        ? { model: { providerID: body.providerID, modelID: body.modelID } } : body)
      if (match[2] === "command") {
        if (!body.command) throw new Error("Chưa chọn command")
        const payload = { command: body.command, arguments: body.arguments ?? "",
          files: (body.parts ?? []).filter((part) => part.type === "file")
            .map((part) => ({ uri: part.url, mime: part.mime, name: part.filename })),
          agent: body.agent, model, resume: !options.recordOnly && !body.noReply }
        const signature = JSON.stringify(payload)
        const previous = pendingCommands.get(id)
        const intent = previous?.signature === signature && (!body.messageID || previous.id === body.messageID)
          ? previous : { id: body.messageID ?? SessionMessage.ID.create(), signature }
        pendingCommands.set(id, intent)
        // The server owns expansion, selection, shell/subtask execution and the
        // durable receipt. Never repeat those side effects in this UI adapter.
        const response = await native(`/api/session/${encodeURIComponent(id)}/command`, {
          method: "POST", body: JSON.stringify({ ...payload, id: intent.id }), signal: call.signal,
        })
        if (!response.ok) {
          const error = await response.json().catch(() => ({})) as { message?: string }
          throw new Error(error.message ?? "Không hoàn tất command. Kiểm tra phiên trước khi thử lại.")
        }
        pendingCommands.delete(id)
        return json(true)
      }
      // Selection is explicit and only changes when the user requests it.
      if (model && (value.model?.providerID !== model.providerID || value.model?.id !== model.id ||
        (body.variant !== undefined && value.model?.variant !== body.variant)))
        await client.v2.session.switchModel({ sessionID: id, model }, call)
      if (body.agent && body.agent !== value.agent)
        await client.v2.session.switchAgent({ sessionID: id, agent: body.agent }, call)
      switch (match[2]) {
        case "message":
        case "prompt_async": {
          const parts = body.parts ?? []
          const response = await admitPrompt(id, {
              text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
              files: parts.filter((part) => part.type === "file").map((part) => ({
                uri: part.url, mime: part.mime, name: part.filename })),
              agents: parts.filter((part) => part.type === "agent").map((part) => ({ name: part.name })),
            }, !options.recordOnly && !body.noReply, body.messageID, call.signal)
          return json(response)
        }
        case "abort": await client.v2.session.interrupt({ sessionID: id }, call); break
        case "shell":
          if (options.recordOnly) throw new Error("Record-only mode cannot execute shell commands")
          if (!body.command) throw new Error("Shell command must not be empty")
          await client.v2.session.shell({ sessionID: id, command: body.command, resume: false }, call); break
        case "summarize": {
          const before = (await client.v2.session.context({ sessionID: id }, call)).data.data
            .findLast((message) => message.type === "compaction")
          await client.v2.session.compact({ sessionID: id }, call)
          const after = (await client.v2.session.context({ sessionID: id }, call)).data.data
            .findLast((message) => message.type === "compaction")
          if (!after || after.id === before?.id) return json(false)
          // Publish the committed checkpoint before acknowledging completion. A later
          // watcher refresh uses the same IDs, and reopening projects this same record.
          const [entry] = transcript(value, [after])
          emit({ type: "message.updated", properties: { sessionID: id, info: entry!.info } }, value.location.directory)
          for (const part of entry!.parts) emit({ type: "message.part.updated",
            properties: { sessionID: id, part, time: Date.now() } }, value.location.directory)
          return json(true)
        }
        case "revert":
          await client.v2.session.revert.stage({ sessionID: id, messageID: body.messageID, files: true }, call); break
        case "unrevert": await client.v2.session.revert.clear({ sessionID: id }, call); break
      }
      return json(true)
    }
    const reply = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(route)
    if (method === "POST" && reply) {
      const requestID = decodeURIComponent(reply[2])
      const sessionID = requestSessions.get(requestID)
      if (!sessionID) throw new Error("Yêu cầu đã hết hiệu lực. Mở lại phiên để cập nhật.")
      if (reply[1] === "permission") await client.v2.session.permission.reply({ sessionID, requestID,
        reply: body.reply, message: body.message }, call)
      else if (reply[3] === "reject") await client.v2.session.question.reject({ sessionID, requestID }, call)
      else {
        if (!body.answers) throw new Error("Question answers are required")
        await client.v2.session.question.reply({ sessionID, requestID, questionV2Reply: { answers: body.answers } }, call)
      }
      return json(true)
    }
    const message = `Agent local chưa hỗ trợ thao tác ${method} ${route}. Không có thay đổi nào được thực hiện.`
    if (method !== "GET") failed(new Error(message))
    return json({ message }, 501)
  }

  try { await presentation() } catch (error) { controller.abort(); throw error }
  return {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await adapter(input instanceof Request ? input : new Request(input, init)) }
      catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
        failed(error)
        return json({ message: error instanceof Error ? error.message : "Agent local request failed" }, 502)
      }
    }, { preconnect: fetch.preconnect }) as typeof fetch,
    events: { async subscribe(listener: (event: GlobalEvent) => void) {
      listeners.add(listener)
      globalTask ??= globalEvents().catch(failed)
      return () => { listeners.delete(listener) }
    } },
    async dispose() {
      controller.abort()
      listeners.clear()
      await Promise.all([globalTask, ...watchers.values()])
    },
  }
}
