/** Personal-client lifetime is independent from readers and remote supervision. */
import { randomUUID } from "node:crypto"
import type { AgentClientKind } from "./process"

export class SessionOwnershipConflict extends Error {
  constructor() {
    super("Phiên đang do giao diện local điều khiển.")
  }
}

export function createClientLeases(options: {
  stop: (sessionID: string) => Promise<void>
  now?: () => number
  leaseMs?: number
  running?: (sessionID: string) => Promise<boolean>
  keepRemote?: boolean
}) {
  const now = options.now ?? Date.now
  const leaseMs = options.leaseMs ?? 12_000
  const clients = new Map<
    string,
    {
      kind: AgentClientKind
      expiresAt: number
      closing: Promise<void> | undefined
      confirmed: boolean
      revision: number
      sessions: Set<string>
      requests: Map<AbortController, Promise<void>>
    }
  >()
  // Handoff can precede durable run publication; retain admission until settled.
  const background = new Map<
    string,
    ReadonlyMap<AbortController, Promise<void>>
  >()
  // Remote work is owned by its admitted operation, not a personal UI lease.
  const remote = new Map<string, number>()
  const ownedByAnother = (id: string | null, sessionID: string) => {
    for (const [ownerID, owner] of clients)
      if (ownerID !== id && owner.sessions.has(sessionID)) return true
    return false
  }
  const collectSessions = (initial: Iterable<string> = []) => {
    const result = new Set(initial)
    for (const client of clients.values())
      for (const sessionID of client.sessions) result.add(sessionID)
    return [...result]
  }
  const requireClient = (id: string | null) => {
    const client = id ? clients.get(id) : undefined
    if (!client || client.closing || client.expiresAt <= now())
      throw new Error(
        "Giao diện đã mất kết nối với Agent. Kết nối lại trước khi thao tác.",
      )
    return client
  }
  const close = (id: string, keep: boolean): Promise<void> => {
    const client = clients.get(id)
    if (!client) return Promise.resolve()
    if (client.closing) return client.closing
    const durable = options.keepRemote && client.kind === "remote"
    if (keep && !durable && client.expiresAt <= now())
      return Promise.reject(new Error(
        "Giao diện đã mất kết nối với Agent. Dừng tác vụ trước khi đóng.",
      ))
    if (keep && !client.confirmed && !durable)
      return Promise.reject(new Error("Chưa xác nhận tiếp tục chạy nền."))
    // Publish the fence and completion before cleanup starts. Retries of this
    // exact lease must join its Stop, not acknowledge unfinished cancellation.
    client.closing = Promise.resolve().then(async () => {
      if (keep || durable)
        for (const session of client.sessions)
          background.set(session, client.requests)
      else {
        const requests = [...client.requests]
        for (const [controller] of requests) controller.abort()
        await Promise.all([...client.sessions].map(options.stop))
        await Promise.all(requests.map(([, done]) => done))
        // An already admitted HTTP handler may publish its service-owned run
        // while cancellation unwinds. Stop that local owner before ACKing exit.
        if (requests.length)
          await Promise.all([...client.sessions].map(options.stop))
      }
      clients.delete(id)
    }).catch((error) => {
      client.closing = undefined
      throw error
    })
    return client.closing
  }
  return {
    open(kind: AgentClientKind) {
      const id = randomUUID()
      clients.set(id, {
        kind,
        expiresAt: now() + leaseMs,
        closing: undefined,
        confirmed: false,
        revision: 0,
        sessions: new Set(),
        requests: new Map(),
      })
      return id
    },
    heartbeat(id: string | null) {
      requireClient(id).expiresAt = now() + leaseMs
    },
    async withRequest<A>(
      id: string | null,
      work: (signal: AbortSignal) => Promise<A>,
    ): Promise<A> {
      const client = requireClient(id)
      const controller = new AbortController()
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      client.revision++
      client.requests.set(controller, done)
      try {
        return await work(controller.signal)
      } finally {
        client.requests.delete(controller)
        finish()
      }
    },
    async withRemoteRequest<A>(sessionID: string, work: () => Promise<A>) {
      if (background.has(sessionID) || ownedByAnother(null, sessionID))
        throw new SessionOwnershipConflict()
      remote.set(sessionID, (remote.get(sessionID) ?? 0) + 1)
      try {
        return await work()
      } finally {
        const remaining = remote.get(sessionID)! - 1
        if (remaining) remote.set(sessionID, remaining)
        else remote.delete(sessionID)
      }
    },
    claim(id: string | null, sessionID: string) {
      const client = requireClient(id)
      if (background.has(sessionID))
        throw new Error(
          "Phiên đang chạy nền. Dừng tác vụ trước khi gửi yêu cầu mới từ giao diện.",
        )
      if (remote.has(sessionID) || ownedByAnother(id, sessionID))
        throw new Error(
          "Phiên đang được giao diện khác vận hành. Bạn có thể xem hoặc tạo phiên mới.",
        )
      client.revision++
      client.sessions.add(sessionID)
    },
    authorize(id: string | null, sessionID: string) {
      requireClient(id)
      if (background.has(sessionID) || remote.has(sessionID) || ownedByAnother(id, sessionID))
        throw new Error(
          "Phiên do giao diện khác vận hành; chỉ được xem hoặc dừng tác vụ.",
        )
    },
    confirmBackground(id: string | null) {
      const client = requireClient(id)
      if (!client.sessions.size)
        throw new Error("Giao diện chưa có tác vụ riêng để chạy nền.")
      client.confirmed = true
    },
    close,
    releaseObserver(id: string, eligible = true) {
      const client = clients.get(id)
      if (!client) return true // Exact-lease retry after a lost release ACK.
      if (!eligible || client.kind !== "remote" || client.closing || client.confirmed ||
          client.sessions.size || client.requests.size) return false
      // Atomic, no await and no Stop. A later request cannot claim this lease.
      clients.delete(id)
      return true
    },
    async prune() {
      if (!options.running) return
      for (const [session, requests] of background)
        if (!requests.size && !(await options.running(session)) &&
            background.get(session) === requests)
          background.delete(session)
      for (const client of clients.values())
        if (client.kind === "remote")
          for (const session of client.sessions) {
            if (client.closing || client.requests.size) break
            const revision = client.revision
            // A durable idle read can predate admission or its run publication.
            // Release only the unchanged owner with no work still publishing.
            if (!(await options.running(session)) &&
                revision === client.revision &&
                !client.closing && !client.requests.size)
              client.sessions.delete(session)
          }
    },
    async expire() {
      for (const [id, client] of clients)
        if (client.expiresAt <= now())
          // A crash never counts as consent, even after opening a confirmation.
          await close(id, false)
    },
    sessions() {
      return collectSessions([...background.keys(), ...remote.keys()])
    },
    foregroundSessions() {
      return collectSessions()
    },
    owners() {
      const result: (
        | { sessionID: string; clientID: string; kind: AgentClientKind }
        | { sessionID: string; clientID: null; kind: "background" | "remote" }
      )[] = []
      for (const [clientID, client] of clients)
        for (const sessionID of client.sessions)
          result.push({ sessionID, clientID, kind: client.kind })
      for (const sessionID of background.keys())
        result.push({ sessionID, clientID: null, kind: "background" })
      for (const sessionID of remote.keys())
        result.push({ sessionID, clientID: null, kind: "remote" })
      return result
    },
    get idle() {
      return !clients.size && !background.size && !remote.size
    },
    get size() {
      return clients.size
    },
  }
}
