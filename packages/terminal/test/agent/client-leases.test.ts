import { expect, test } from "bun:test"
import { createClientLeases, SessionOwnershipConflict } from "../../src/agent/client-leases"

test("remote admission respects idle local ownership and explicit background handoff", async () => {
  const clients = createClientLeases({ stop: async () => {} })
  const owner = clients.open("tui")
  clients.claim(owner, "owned")
  let calls = 0
  const request = () => clients.withRemoteRequest("owned", async () => { calls++ })
  await expect(request()).rejects.toBeInstanceOf(SessionOwnershipConflict)
  clients.confirmBackground(owner)
  await clients.close(owner, true)
  await expect(request()).rejects.toBeInstanceOf(SessionOwnershipConflict)
  expect(calls).toBe(0)
})

test("remote reservation is atomic with local claim and survives nested replies until settlement", async () => {
  const stopped: string[] = []
  const clients = createClientLeases({ stop: async (id) => { stopped.push(id) } })
  const observer = clients.open("desktop")
  let finish!: () => void
  const request = clients.withRemoteRequest("remote", async () => {
    await new Promise<void>((resolve) => { finish = resolve })
  })
  expect(() => clients.claim(observer, "remote")).toThrow("giao diện khác")
  expect(() => clients.authorize(observer, "remote")).toThrow("giao diện khác")
  expect(clients.owners()).toEqual([{ sessionID: "remote", clientID: null, kind: "remote" }])
  await clients.withRemoteRequest("remote", async () => {
    expect(() => clients.claim(observer, "remote")).toThrow("giao diện khác")
  })
  expect(() => clients.claim(observer, "remote")).toThrow("giao diện khác")
  await clients.close(observer, false)
  expect(stopped).toEqual([])
  expect(clients.idle).toBe(false)
  finish()
  await request
  expect(clients.idle).toBe(true)
  const next = clients.open("tui")
  clients.claim(next, "remote")
  expect(clients.owners()[0]?.clientID).toBe(next)
})

test("remote failure releases its reservation but cannot race local closing cleanup", async () => {
  let finish!: () => void
  const clients = createClientLeases({ stop: () => new Promise<void>((resolve) => { finish = resolve }) })
  await expect(clients.withRemoteRequest("remote", async () => { throw new Error("cancelled") }))
    .rejects.toThrow("cancelled")
  expect(clients.idle).toBe(true)
  const owner = clients.open("desktop")
  clients.claim(owner, "remote")
  const closing = clients.close(owner, false)
  await Promise.resolve()
  await expect(clients.withRemoteRequest("remote", async () => {}))
    .rejects.toBeInstanceOf(SessionOwnershipConflict)
  finish()
  await closing
  await clients.withRemoteRequest("remote", async () => {})
  expect(clients.idle).toBe(true)
})

test("an observer's lost release ACK remains idempotent after host eligibility changes", () => {
  const clients = createClientLeases({ stop: async () => { throw new Error("Observer release cannot Stop") } })
  const observer = clients.open("remote")
  expect(clients.releaseObserver(observer, false)).toBe(false)
  expect(clients.size).toBe(1)
  expect(clients.releaseObserver(observer)).toBe(true)
  expect(clients.releaseObserver(observer, false)).toBe(true)
  const owner = clients.open("tui")
  clients.claim(owner, "ses_owned")
  expect(clients.releaseObserver(owner, false)).toBe(false)
  expect(clients.owners()).toEqual([{ sessionID: "ses_owned", clientID: owner, kind: "tui" }])
})

test("idle observer release is atomic, idempotent and cannot stop an owner", async () => {
  const clients = createClientLeases({ stop: async () => { throw new Error("must not Stop") } })
  const tui = clients.open("tui"), observer = clients.open("remote"), owner = clients.open("remote")
  clients.claim(tui, "local")
  clients.claim(owner, "remote")
  expect(clients.releaseObserver(tui)).toBe(false)
  expect(clients.releaseObserver(owner)).toBe(false)
  expect(clients.releaseObserver(observer)).toBe(true)
  expect(clients.releaseObserver(observer)).toBe(true)
  expect(() => clients.claim(observer, "late")).toThrow("mất kết nối")
  expect(clients.sessions()).toEqual(["local", "remote"])
})

test("observer with admitted HTTP work cannot be released", async () => {
  const clients = createClientLeases({ stop: async () => { throw new Error("must not Stop") } })
  const observer = clients.open("remote")
  await clients.withRequest(observer, async () => {
    expect(clients.releaseObserver(observer)).toBe(false)
    clients.claim(observer, "newly-admitted")
  })
  expect(clients.releaseObserver(observer)).toBe(false)
})

test("closing an observer never stops another interface's sessions", async () => {
  const stopped: string[] = []
  const clients = createClientLeases({
    stop: async (id) => {
      stopped.push(id)
    },
  })
  const tui = clients.open("tui"),
    desktop = clients.open("desktop")
  clients.claim(tui, "ses_tui")
  clients.claim(desktop, "ses_desktop")
  expect(() => clients.claim(desktop, "ses_tui")).toThrow("giao diện khác")
  await clients.close(desktop, false)
  expect(stopped).toEqual(["ses_desktop"])
  expect(clients.foregroundSessions()).toEqual(["ses_tui"])
})

test("background requires explicit confirmation and a successful release", async () => {
  let now = 0
  const stopped: string[] = []
  const clients = createClientLeases({
    now: () => now,
    leaseMs: 100,
    stop: async (id) => {
      stopped.push(id)
    },
  })
  const owner = clients.open("tui")
  clients.claim(owner, "ses_background")
  await expect(clients.close(owner, true)).rejects.toThrow("Chưa xác nhận")
  clients.confirmBackground(owner)
  await clients.close(owner, true)
  now = 200
  await clients.expire()
  expect(stopped).toEqual([])
  expect(clients.sessions()).toEqual(["ses_background"])
  const crash = clients.open("tui")
  clients.claim(crash, "ses_crash")
  clients.confirmBackground(crash)
  now = 400
  await clients.expire()
  expect(stopped).toEqual(["ses_crash"])
})

test("failed cleanup is not reported as a stopped session", async () => {
  let fail = true
  const clients = createClientLeases({
    stop: async () => {
      if (fail) throw new Error("cleanup failed")
    },
  })
  const owner = clients.open("desktop")
  clients.claim(owner, "ses_cleanup")
  await expect(clients.close(owner, false)).rejects.toThrow("cleanup failed")
  expect(clients.size).toBe(1)
  fail = false
  await clients.close(owner, false)
  expect(clients.idle).toBe(true)
})

test("concurrent closes join one Stop before acknowledging the exact lease", async () => {
  let finish!: () => void,
    stops = 0,
    acknowledged = false
  const clients = createClientLeases({
    stop: async () => {
      stops++
      await new Promise<void>((resolve) => { finish = resolve })
    },
  })
  const owner = clients.open("desktop")
  clients.claim(owner, "owned")
  const first = clients.close(owner, false)
  // A concurrent handoff cannot change the already chosen Stop operation.
  const second = clients.close(owner, true)
  expect(second).toBe(first)
  void second.then(() => { acknowledged = true })
  await Promise.resolve()
  expect(stops).toBe(1)
  expect(acknowledged).toBe(false)
  expect(() => clients.heartbeat(owner)).toThrow("mất kết nối")
  expect(() => clients.confirmBackground(owner)).toThrow("mất kết nối")
  finish()
  await Promise.all([first, second])
  expect(acknowledged).toBe(true)
  expect(clients.idle).toBe(true)
  await clients.close(owner, false)
  await clients.close(owner, true)
  expect(stops).toBe(1)
  expect(clients.sessions()).toEqual([])
})

test("concurrent failed closes share failure and leave cleanup retryable", async () => {
  let fail!: () => void,
    stops = 0
  const clients = createClientLeases({
    stop: async () => {
      stops++
      if (stops === 1)
        await new Promise<void>((_, reject) => {
          fail = () => reject(new Error("cleanup failed"))
        })
    },
  })
  const owner = clients.open("tui")
  clients.claim(owner, "owned")
  const first = clients.close(owner, false)
  const second = clients.close(owner, false)
  expect(second).toBe(first)
  const completed = Promise.allSettled([first, second])
  await Promise.resolve()
  fail()
  for (const result of await completed) {
    expect(result.status).toBe("rejected")
    if (result.status === "rejected")
      expect(result.reason.message).toBe("cleanup failed")
  }
  expect(stops).toBe(1)
  expect(clients.size).toBe(1)
  await clients.close(owner, false)
  expect(stops).toBe(2)
  expect(clients.idle).toBe(true)
})

test("an expired lease can stop but cannot newly confirm background work", async () => {
  let now = 0
  const stopped: string[] = []
  const clients = createClientLeases({
    now: () => now,
    leaseMs: 100,
    stop: async (id) => { stopped.push(id) },
  })
  const owner = clients.open("desktop")
  clients.claim(owner, "owned")
  clients.confirmBackground(owner)
  now = 101
  await expect(clients.close(owner, true)).rejects.toThrow("mất kết nối")
  expect(clients.size).toBe(1)
  await clients.close(owner, false)
  expect(stopped).toEqual(["owned"])
  expect(clients.idle).toBe(true)
})

test("explicit server mode keeps remote work, while personal UI crashes still stop their own work", async () => {
  let now = 0
  const stopped: string[] = []
  const clients = createClientLeases({
    now: () => now,
    leaseMs: 100,
    keepRemote: true,
    stop: async (id) => {
      stopped.push(id)
    },
  })
  const remote = clients.open("remote"),
    tui = clients.open("tui")
  clients.claim(remote, "server-run")
  clients.claim(tui, "personal-run")
  now = 101
  await clients.expire()
  expect(stopped).toEqual(["personal-run"])
  expect(clients.sessions()).toEqual(["server-run"])
})

test.each(["tui", "desktop"] as const)(
  "an idle %s keeps ownership until its own expired lease is cleaned up",
  async (kind) => {
    let now = 0
    const stopped: string[] = []
    const clients = createClientLeases({
      now: () => now,
      leaseMs: 100,
      running: async () => false,
      stop: async (id) => { stopped.push(id) },
    })
    const owner = clients.open(kind)
    const observer = clients.open(kind === "tui" ? "desktop" : "tui")
    clients.claim(owner, "idle-local")
    clients.claim(observer, "neighbour")
    await clients.prune()
    expect(() => clients.claim(observer, "idle-local")).toThrow("giao diện khác")
    expect(stopped).toEqual([])
    now = 90
    clients.heartbeat(observer)
    now = 101
    await clients.expire()
    expect(stopped).toEqual(["idle-local"])
    expect(clients.owners()).toEqual([
      { sessionID: "neighbour", clientID: observer, kind: kind === "tui" ? "desktop" : "tui" },
    ])
    clients.claim(observer, "idle-local")
    expect(clients.sessions()).toEqual(["neighbour", "idle-local"])
  },
)

test("finished background and supervisor runs release ownership without stopping another client", async () => {
  let running = true
  const clients = createClientLeases({
    stop: async () => {},
    running: async () => running,
  })
  const remote = clients.open("remote"),
    observer = clients.open("desktop")
  clients.claim(remote, "remote-run")
  expect(() => clients.authorize(observer, "remote-run")).toThrow()
  running = false
  await clients.prune()
  clients.claim(observer, "remote-run")
  expect(clients.owners()).toMatchObject([
    { clientID: observer, sessionID: "remote-run" },
  ])
  clients.confirmBackground(observer)
  await clients.close(observer, true)
  await clients.prune()
  expect(clients.sessions()).toEqual([])
})

test("session projections preserve order, deduplicate claims and return snapshots", async () => {
  const clients = createClientLeases({ stop: async () => {} })
  const background = clients.open("tui")
  clients.claim(background, "background-second")
  clients.claim(background, "background-first")
  clients.confirmBackground(background)
  await clients.close(background, true)
  const desktop = clients.open("desktop"),
    tui = clients.open("tui")
  clients.claim(desktop, "desktop-second")
  clients.claim(desktop, "desktop-first")
  clients.claim(desktop, "desktop-second")
  clients.claim(tui, "tui-run")
  const foreground = ["desktop-second", "desktop-first", "tui-run"]
  const backgroundSessions = ["background-second", "background-first"]
  expect(clients.sessions()).toEqual([...backgroundSessions, ...foreground])
  expect(clients.foregroundSessions()).toEqual(foreground)
  expect(clients.owners()).toEqual([
    { sessionID: "desktop-second", clientID: desktop, kind: "desktop" },
    { sessionID: "desktop-first", clientID: desktop, kind: "desktop" },
    { sessionID: "tui-run", clientID: tui, kind: "tui" },
    { sessionID: "background-second", clientID: null, kind: "background" },
    { sessionID: "background-first", clientID: null, kind: "background" },
  ])
  const sessions = clients.sessions(),
    foregroundSessions = clients.foregroundSessions(),
    owners = clients.owners()
  sessions.length = 0
  foregroundSessions.push("not-owned")
  owners[0]!.sessionID = "not-owned"
  expect(clients.sessions()).toEqual([...backgroundSessions, ...foreground])
  expect(clients.foregroundSessions()).toEqual(foreground)
  expect(clients.owners()[0]!.sessionID).toBe("desktop-second")
})

test("an expired owner still blocks control until its cleanup succeeds", async () => {
  let now = 0,
    fail = true
  const stopped: string[] = []
  const clients = createClientLeases({
    now: () => now,
    leaseMs: 100,
    stop: async (id) => {
      stopped.push(id)
      if (fail) throw new Error("cleanup failed")
    },
  })
  const owner = clients.open("tui")
  clients.claim(owner, "owned")
  now = 101
  const observer = clients.open("desktop")
  expect(() => clients.claim(observer, "owned")).toThrow("giao diện khác")
  expect(() => clients.authorize(observer, "owned")).toThrow("chỉ được xem")
  await expect(clients.expire()).rejects.toThrow("cleanup failed")
  expect(() => clients.claim(observer, "owned")).toThrow("giao diện khác")
  fail = false
  await clients.expire()
  clients.claim(observer, "owned")
  clients.authorize(observer, "owned")
  expect(stopped).toEqual(["owned", "owned"])
  expect(clients.owners()).toEqual([
    { sessionID: "owned", clientID: observer, kind: "desktop" },
  ])
})

test("client validation precedes background ownership errors", async () => {
  const clients = createClientLeases({ stop: async () => {} })
  const owner = clients.open("tui")
  clients.claim(owner, "background")
  clients.confirmBackground(owner)
  await clients.close(owner, true)
  for (const id of [null, owner, "missing"])
    for (const action of [clients.claim, clients.authorize])
      expect(() => action(id, "background")).toThrow("mất kết nối")
  const observer = clients.open("desktop")
  expect(() => clients.claim(observer, "background")).toThrow("chạy nền")
  expect(() => clients.authorize(observer, "background")).toThrow("chỉ được xem")
  expect(clients.sessions()).toEqual(["background"])
})

test("closing cancels and drains admitted writes before its final local stop", async () => {
  let running = false,
    stops = 0,
    aborted = false
  const clients = createClientLeases({
    stop: async () => {
      stops++
      running = false
    },
  })
  const owner = clients.open("tui")
  clients.claim(owner, "session")
  const request = clients.withRequest(owner, async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true
        resolve()
      }, { once: true })
    })
    // A service-owned admission can finish publishing as HTTP cancellation
    // unwinds. Exit must also stop this owner, not only the initial snapshot.
    running = true
    return "settled"
  })
  const closing = clients.close(owner, false)
  await expect(clients.withRequest(owner, async () => {}))
    .rejects.toThrow("mất kết nối")
  await closing
  expect(await request).toBe("settled")
  expect(aborted).toBe(true)
  expect(stops).toBe(2)
  expect(running).toBe(false)
  expect(clients.idle).toBe(true)
  await expect(clients.withRequest(owner, async () => {}))
    .rejects.toThrow("mất kết nối")
})

test("explicit background handoff does not abort an admitted operation", async () => {
  const clients = createClientLeases({
    stop: async () => { throw new Error("must not stop background work") },
  })
  const owner = clients.open("desktop")
  clients.claim(owner, "session")
  let finish!: () => void,
    aborted = false
  const request = clients.withRequest(owner, async (signal) => {
    signal.addEventListener("abort", () => { aborted = true })
    await new Promise<void>((resolve) => { finish = resolve })
    return "completed"
  })
  clients.confirmBackground(owner)
  await clients.close(owner, true)
  expect(aborted).toBe(false)
  expect(clients.sessions()).toEqual(["session"])
  finish()
  expect(await request).toBe("completed")
})

test("an old idle observation cannot release a newly claimed remote run", async () => {
  let idle!: (running: boolean) => void
  const clients = createClientLeases({
    stop: async () => {},
    running: () => new Promise<boolean>((resolve) => { idle = resolve }),
  })
  const owner = clients.open("remote"), observer = clients.open("desktop")
  clients.claim(owner, "session")
  const pruning = clients.prune()
  clients.claim(owner, "session")
  idle(false)
  await pruning
  expect(() => clients.claim(observer, "session")).toThrow("giao diện khác")
  expect(clients.owners()).toEqual([
    { sessionID: "session", clientID: owner, kind: "remote" },
  ])
})

test("remote ownership survives an admitted request before its run is published", async () => {
  let finish!: () => void, observations = 0
  const clients = createClientLeases({
    stop: async () => {},
    running: async () => { observations++; return false },
  })
  const owner = clients.open("remote"), observer = clients.open("desktop")
  clients.claim(owner, "session")
  const request = clients.withRequest(owner, () =>
    new Promise<void>((resolve) => { finish = resolve }),
  )
  await clients.prune()
  expect(observations).toBe(0)
  expect(() => clients.claim(observer, "session")).toThrow("giao diện khác")
  finish()
  await request
  await clients.prune()
  expect(observations).toBe(1)
  clients.claim(observer, "session")
})

test("an admission that finishes during an idle read still invalidates that read", async () => {
  let idle!: (running: boolean) => void
  const clients = createClientLeases({
    stop: async () => {},
    running: () => new Promise<boolean>((resolve) => { idle = resolve }),
  })
  const owner = clients.open("remote"), observer = clients.open("desktop")
  clients.claim(owner, "session")
  const pruning = clients.prune()
  await clients.withRequest(owner, async () => {})
  idle(false)
  await pruning
  expect(() => clients.claim(observer, "session")).toThrow("giao diện khác")
})

test.each([false, true])(
  "background handoff retains pending admission (server mode: %s)",
  async (keepRemote) => {
    let publish!: () => void, running = false, observations = 0
    const clients = createClientLeases({
      keepRemote,
      stop: async () => { throw new Error("must not stop background work") },
      running: async () => { observations++; return running },
    })
    const owner = clients.open(keepRemote ? "remote" : "desktop")
    clients.claim(owner, "session")
    const request = clients.withRequest(owner, async () => {
      await new Promise<void>((resolve) => { publish = resolve })
      running = true
    })
    if (!keepRemote) clients.confirmBackground(owner)
    await clients.close(owner, !keepRemote)
    await clients.prune()
    expect(observations).toBe(0)
    expect(clients.idle).toBe(false)
    expect(clients.sessions()).toEqual(["session"])
    publish()
    await request
    await clients.prune()
    expect(clients.sessions()).toEqual(["session"])
    running = false
    await clients.prune()
    expect(clients.idle).toBe(true)
  },
)

test("failed background admission releases idle ownership on the next prune", async () => {
  let fail!: () => void
  const clients = createClientLeases({
    stop: async () => { throw new Error("must not stop background work") },
    running: async () => false,
  })
  const owner = clients.open("desktop")
  clients.claim(owner, "session")
  const request = clients.withRequest(owner, () =>
    new Promise<void>((_, reject) => {
      fail = () => reject(new Error("admission failed"))
    }),
  )
  clients.confirmBackground(owner)
  await clients.close(owner, true)
  await clients.prune()
  expect(clients.idle).toBe(false)
  const rejected = request.catch((error: unknown) => error)
  fail()
  expect(await rejected).toEqual(new Error("admission failed"))
  await clients.prune()
  expect(clients.sessions()).toEqual([])
  expect(clients.owners()).toEqual([])
  expect(clients.idle).toBe(true)
})

test("an old background idle read cannot release a successor handoff", async () => {
  const observations: ((running: boolean) => void)[] = []
  const clients = createClientLeases({
    stop: async () => {},
    running: () => observations.length >= 2
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => { observations.push(resolve) }),
  })
  const first = clients.open("desktop")
  clients.claim(first, "session")
  clients.confirmBackground(first)
  await clients.close(first, true)
  const stale = clients.prune(), current = clients.prune()
  observations[1]!(false)
  await current
  const successor = clients.open("desktop")
  clients.claim(successor, "session")
  clients.confirmBackground(successor)
  await clients.close(successor, true)
  observations[0]!(false)
  await stale
  expect(clients.sessions()).toEqual(["session"])
  expect(clients.idle).toBe(false)
})

test("an idle read during closing cannot drop ownership before Stop finishes", async () => {
  let idle!: (running: boolean) => void, stopped!: () => void
  const clients = createClientLeases({
    stop: () => new Promise<void>((resolve) => { stopped = resolve }),
    running: () => new Promise<boolean>((resolve) => { idle = resolve }),
  })
  const owner = clients.open("remote"), observer = clients.open("desktop")
  clients.claim(owner, "session")
  const pruning = clients.prune(), closing = clients.close(owner, false)
  idle(false)
  await pruning
  expect(() => clients.claim(observer, "session")).toThrow("giao diện khác")
  stopped()
  await closing
  clients.claim(observer, "session")
})
