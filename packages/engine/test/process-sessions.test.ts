import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ProcessSessions } from "../src/execution/process/sessions"

const command = (text: string) => ({
  command: "/bin/sh",
  args: ["-c", text],
  cwd: process.cwd(),
  root: process.cwd(),
})

test("owned process survives output waits and accepts stdin without relaunch", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* ProcessSessions.make
        const id = yield* sessions.start("owner", command("printf ready; read line; printf '%s' \"$line\""))
        const first = yield* sessions.followup("owner", {
          processID: id,
          action: "wait",
          waitMs: 1000,
        })
        expect(first.output).toBe("ready")
        const quiet = yield* sessions.followup("owner", {
          processID: id,
          action: "wait",
          cursor: first.cursor,
          waitMs: 1,
        })
        expect(quiet.status).toBe("running")
        expect(quiet.output).toBe("")
        const forbidden = yield* sessions
          .followup("other", { processID: id, action: "write", data: "bad\n" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(forbidden)).toBe(true)
        let next = yield* sessions.followup("owner", {
          processID: id,
          action: "write",
          cursor: first.cursor,
          data: "answer\n",
        })
        let text = next.output
        while (next.status === "running") {
          next = yield* sessions.followup("owner", {
            processID: id,
            action: "wait",
            cursor: next.cursor,
          })
          text += next.output
        }
        expect(text).toBe("answer")
        expect(next.exitCode).toBe(0)
      }),
    ),
  ))

test("cancellation, output retention and restart handles are explicit", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* ProcessSessions.make
        const id = yield* sessions.start("owner", command("printf ready; read line"))
        yield* sessions.followup("owner", { processID: id, action: "wait" })
        expect(
          (yield* sessions.followup("owner", {
            processID: id,
            action: "cancel",
          })).status,
        ).toBe("cancelled")
        yield* sessions.disposeOwner("owner")
        const fresh = yield* ProcessSessions.make
        expect(
          Exit.isFailure(yield* fresh.followup("owner", { processID: id, action: "wait" }).pipe(Effect.exit)),
        ).toBe(true)
        const large = yield* sessions.start("owner", command("/usr/bin/head -c 400000 /dev/zero | /usr/bin/tr '\\0' x"))
        let next = yield* sessions.followup("owner", {
          processID: large,
          action: "wait",
        })
        while (next.status === "running")
          next = yield* sessions.followup("owner", {
            processID: large,
            action: "wait",
            cursor: next.cursor,
          })
        const retained = yield* sessions.followup("owner", {
          processID: large,
          action: "wait",
          cursor: 0,
        })
        expect(retained.cursor).toBe(400000)
        expect(retained.output.length).toBe(256 * 1024)
        expect(retained.omitted).toBe(400000 - 256 * 1024)
      }),
    ),
  ))

test("timeout ends process lifetime instead of output observation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* ProcessSessions.make
        const id = yield* sessions.start("owner", {
          ...command("read line"),
          timeout: 20,
        })
        const result = yield* sessions.followup("owner", {
          processID: id,
          action: "wait",
          waitMs: 1000,
        })
        expect(result.status).toBe("timed-out")
      }),
    ),
  ))
