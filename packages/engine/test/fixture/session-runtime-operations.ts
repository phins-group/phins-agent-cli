import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Equal, Hash } from "effect"
// Exercise the import order that previously loaded operations before Session.
import { SessionExecution } from "../../src/sessions/run/execution"
import { AgentRegistry } from "../../src/agents/registry"
import { Database } from "../../src/storage/database"
import { ServiceGraph } from "../../src/runtime/effect/service-graph"
import { EventBus } from "../../src/runtime/events/bus"
import { Location } from "../../src/workspace/location"
import { LocationServiceRegistry } from "../../src/runtime/services"
import { AbsolutePath } from "../../src/shared/schema"
import { SessionManager } from "../../src/sessions/service"
import { SessionInput } from "../../src/sessions/input/inbox"
import { SessionMessage } from "../../src/sessions/messages/service"
import { SessionRuntimeLocal } from "../../src/sessions/runtime"
import { SkillRegistry } from "../../src/agents/skills/registry"

// Runs in a child with a private home, DB and Location. No credential or
// provider is configured; every executable command touches only this fixture.
await Effect.gen(function* () {
  const directory = AbsolutePath.make(process.cwd())
  const ref = Location.Ref.make({ directory })
  const session = yield* SessionManager.Service
  const created = yield* session.create({ location: ref })
  const persisted = yield* session.get(created.id)
  assert.ok(Equal.equals(ref, persisted.location))
  assert.equal(Hash.hash(ref), Hash.hash(persisted.location))
  const locations = yield* LocationServiceRegistry
  assert.equal(
    yield* locations.contextEffect(ref),
    yield* locations.contextEffect(persisted.location),
  )
  yield* Effect.gen(function* () {
    yield* (yield* AgentRegistry.Service).transform((draft) =>
      draft.update(AgentRegistry.defaultID, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
    yield* (yield* SkillRegistry.Service).transform((draft) =>
      draft.source({
        type: "embedded",
        skill: {
          name: "review",
          content: "Read fixture only.",
          location: AbsolutePath.make(path.join(directory, "skills/review/SKILL.md")),
        },
      }),
    )
  }).pipe(Effect.provide(LocationServiceRegistry.get(ref)))

  const id = EventBus.ID.create()
  const input = {
    sessionID: created.id,
    id,
    command: "printf runtime-fixture; printf x >> operation-count.txt",
    resume: false,
  }
  yield* session.shell(input)
  yield* session.shell(input)
  yield* session.wait(created.id)
  assert.equal(yield* Effect.promise(() => fs.readFile(path.join(directory, "operation-count.txt"), "utf8")), "x")
  const messages = yield* session.messages({ sessionID: created.id })
  assert.equal(messages.length, 1)
  assert.ok(messages[0]?.type === "shell")
  assert.equal(messages[0].output, "runtime-fixture\n\nCommand exited with code 0.")

  const skillID = EventBus.ID.create()
  yield* session.skill({ sessionID: created.id, id: skillID, skill: "review", resume: false })
  yield* session.wait(created.id)
  const pending = yield* SessionInput.find(
    (yield* Database.Service).db,
    SessionMessage.ID.make(`msg_${skillID.slice(4)}`),
  )
  assert.ok(pending?.prompt.text.includes("Read fixture only."))
  assert.equal(pending?.promotedSeq, undefined)
  assert.equal((yield* session.messages({ sessionID: created.id })).length, 1)

  const empty = yield* session.create({ location: ref })
  yield* session.compact({ sessionID: empty.id })
  yield* session.wait(empty.id)
  assert.deepEqual(yield* session.context(empty.id), [])
  yield* (yield* SessionExecution.Service).awaitIdle
}).pipe(
  Effect.scoped,
  Effect.provide(ServiceGraph.build(ServiceGraph.group([SessionRuntimeLocal.graph, Database.node]))),
  Effect.runPromise,
)
