/** Native records projected into the existing TUI's presentation types. */
import type {
  Agent, AgentV2Info, Model, ModelV2Info, Provider, ProviderV2Info,
  Session, Message, Part,
  PermissionRequest, PermissionV2Request,
} from "@phins/engine/transport/client/create"
import type { SessionClientState } from "@phins/engine/transport/client/session-state"
import { compactionText } from "@phins/engine/sessions/run/messages"
type NativeSession = SessionClientState["snapshot"]["session"]
type NativeMessage = SessionClientState["snapshot"]["messages"]["data"][number]

export function sessionInfo(value: NativeSession): Session {
  return {
    id: value.id, slug: value.id, projectID: value.projectID,
    directory: value.location.directory, path: value.subpath,
    workspaceID: value.location.workspaceID, parentID: value.parentID,
    title: value.title, version: "", agent: value.agent, model: value.model,
    cost: value.cost, tokens: value.tokens ? structuredClone(value.tokens) : undefined,
    time: { ...value.time }, revert: value.revert ? { ...value.revert } : undefined,
  }
}

export function agentInfo(value: AgentV2Info): Agent {
  return {
    name: value.id, description: value.description, mode: value.mode,
    hidden: value.hidden, color: value.color, native: true,
    permission: value.permissions.map((rule) => ({
      permission: rule.action, pattern: rule.resource, action: rule.effect,
    })),
    model: value.model ? { providerID: value.model.providerID, modelID: value.model.id } : undefined,
    variant: value.model?.variant, prompt: value.system, options: {},
  }
}

type DisplayModel = Model & { pricing?: ModelV2Info["cost"]; enabled?: boolean }

/** Recommendations require confirmed availability from the provider catalog. */
export function modelAvailable(model: Model) {
  return (model as DisplayModel).enabled === true && model.status !== "deprecated"
}

/** Preserve unknown rates and context tiers across the presentation adapter. */
export function modelPricing(model: Model | undefined): ModelV2Info["cost"] {
  if (!model) return []
  const pricing = (model as DisplayModel).pricing
  if (pricing) return pricing
  return model.cost ? [{ ...model.cost, cache: model.cost.cache ?? { read: model.cost.input, write: model.cost.input } }] : []
}

export function modelInfo(value: ModelV2Info): DisplayModel {
  const input = (type: string) => value.capabilities.input.includes(type)
  const output = (type: string) => value.capabilities.output.includes(type)
  return {
    id: value.id, providerID: value.providerID, name: value.name,
    family: value.family, status: value.status, limit: value.limit, enabled: value.enabled,
    pricing: value.cost,
    api: { id: value.api.id, url: value.api.url ?? "",
      npm: value.api.type === "aisdk" ? value.api.package : "" },
    capabilities: {
      temperature: true, reasoning: output("reasoning"),
      attachment: value.capabilities.input.some((type) => type !== "text"),
      toolcall: value.capabilities.tools, interleaved: false,
      input: { text: input("text"), image: input("image"), audio: input("audio"),
        video: input("video"), pdf: input("pdf") },
      output: { text: output("text"), image: output("image"), audio: output("audio"),
        video: output("video"), pdf: output("pdf") },
    },
    cost: value.cost.find((cost) => !cost.tier) ?? {
      input: 0, output: 0, cache: { read: 0, write: 0 },
    },
    // Request headers/body can contain credentials; never put them in UI state.
    options: {}, headers: {},
    release_date: new Date(value.time.released).toISOString().slice(0, 10),
    variants: Object.fromEntries(value.variants.map((variant) => [variant.id, {}])),
  }
}

export function providers(
  values: ProviderV2Info[], models: ModelV2Info[],
): Provider[] {
  return values.map((value) => ({
    id: value.id, name: value.name, source: "config", env: [], options: {},
    models: Object.fromEntries(models.filter((model) => model.providerID === value.id)
      .map((model) => [model.id, modelInfo(model)])),
  }))
}

export function permission(value: PermissionV2Request): PermissionRequest {
  return { id: value.id, sessionID: value.sessionID, permission: value.action,
    patterns: value.resources, always: value.save ?? [], metadata: value.metadata ?? {},
    tool: value.source?.type === "tool" ? value.source : undefined }
}

type Entry = { info: Message; parts: Part[] }
const partID = (id: string) => `prt_${id}`
const assistantPartID = (messageID: string, id: string, index: number) =>
  partID(`${messageID}_${String(index).padStart(6, "0")}_${id}`)
const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export function transcript(
  session: NativeSession,
  messages: ReadonlyArray<NativeMessage>,
): Entry[] {
  let parentID = ""
  return messages.map((message): Entry => {
    const base = { sessionID: session.id, messageID: message.id }
    const text = (value: string, suffix = "text"): Extract<Part, { type: "text" }> => ({
      ...base, id: partID(`${message.id}_${suffix}`), type: "text", text: value,
    })
    if (message.type === "assistant") {
      // The original TUI sorts parts by ID. Provider-generated IDs are opaque;
      // include the canonical content position, stable as a part streams.
      const parts: Part[] = message.content.map((part, index): Part => {
        const common = { ...base, id: assistantPartID(message.id, part.id, index) }
        if (part.type === "text") return { ...common, type: "text", text: part.text }
        if (part.type === "reasoning") return { ...common, type: "reasoning",
          text: part.text, time: { start: message.time.created, end: message.time.completed } }
        const state = part.state
        const output = state.status === "pending" ? "" : state.content
          .filter((item) => item.type === "text").map((item) => item.text).join("\n")
        const metadata = state.status === "pending" ? {} : state.structured
        const input = state.status === "pending" ? {} : state.input
        const title = typeof metadata.title === "string" ? metadata.title : part.name
        return { ...common, type: "tool", tool: part.name, callID: part.id,
          state: state.status === "pending"
            ? { status: "pending", input, raw: state.input }
            : state.status === "running"
              ? { status: "running", input, title, metadata, time: { start: part.time.ran ?? part.time.created } }
              : state.status === "error"
                ? { status: "error", input, error: state.error.message, metadata,
                    time: { start: part.time.ran ?? part.time.created, end: part.time.completed ?? message.time.created } }
                : { status: "completed", input, title, metadata, output,
                    attachments: state.attachments?.map((file, index) => ({
                      ...base, id: partID(`${part.id}_file_${index}`),
                      type: "file", mime: file.mime, url: file.uri, filename: file.name,
                    })),
                    time: { start: part.time.ran ?? part.time.created, end: part.time.completed ?? message.time.created } },
        }
      })
      return {
        info: { id: message.id, sessionID: session.id, role: "assistant", parentID,
          modelID: message.model.id, providerID: message.model.providerID,
          agent: message.agent, mode: message.agent,
          path: { cwd: session.location.directory, root: session.location.directory },
          time: message.time, cost: message.cost ?? 0, tokens: message.tokens ?? zeroTokens,
          finish: message.finish,
          error: message.error ? { name: "UnknownError", data: { message: message.error.message } } : undefined },
        parts,
      }
    }
    const parts: Part[] = []
    if (message.type === "user") {
      parentID = message.id
      parts.push(text(message.text))
      for (const [index, file] of (message.files ?? []).entries())
        parts.push({ ...base, id: partID(`${message.id}_file_${index}`), type: "file",
          mime: file.mime, url: file.uri, filename: file.name })
      for (const [index, agent] of (message.agents ?? []).entries())
        parts.push({ ...base, id: partID(`${message.id}_agent_${index}`), type: "agent", name: agent.name })
    } else if (message.type === "shell") {
      parts.push({ ...base, id: partID(`${message.id}_shell`), type: "tool", tool: "bash", callID: message.callID,
        state: message.time.completed === undefined
          ? { status: "running", input: { command: message.command }, time: { start: message.time.created } }
          : message.error
            ? { status: "error", input: { command: message.command }, error: message.error.message,
                time: { start: message.time.created, end: message.time.completed } }
            : { status: "completed", input: { command: message.command }, output: message.output,
                title: message.command, metadata: {}, time: { start: message.time.created, end: message.time.completed } },
      })
    } else if (message.type === "compaction") {
      parts.push({ ...base, id: partID(`${message.id}_compaction`), type: "compaction", auto: message.reason === "auto" })
      parts.push({ ...text(compactionText(message)), synthetic: true })
    } else {
      const value = message.type === "agent-switched" ? `Agent: ${message.agent}`
        : message.type === "model-switched" ? `Model: ${message.model.providerID}/${message.model.id}` : message.text
      parts.push({ ...text(value), synthetic: true })
    }
    return { info: { id: message.id, sessionID: session.id, role: "user",
      time: message.time, agent: session.agent ?? "build",
      model: { providerID: session.model?.providerID ?? "", modelID: session.model?.id ?? "" } }, parts }
  }).map((entry) => structuredClone(entry))
}

/** Live fragments remain transient; a durable refresh replaces them. */
export function stateTranscript(state: SessionClientState): Entry[] {
  const entries = transcript(state.snapshot.session, state.snapshot.messages.data.toReversed())
  if (state.catchingUp) return entries
  for (const draft of state.drafts) {
    if (draft.kind === "tool-input") continue
    const entry = entries.find((entry) => entry.info.id === draft.assistantMessageID)
    const message = state.snapshot.messages.data.find((message) => message.id === draft.assistantMessageID)
    const index = message?.type === "assistant"
      ? message.content.findIndex((part) => part.id === draft.partID) : -1
    const part = entry?.parts.find((part) => part.id === assistantPartID(draft.assistantMessageID, draft.partID, index))
    if (part && (part.type === "text" || part.type === "reasoning"))
      part.text += draft.text
  }
  return entries
}
