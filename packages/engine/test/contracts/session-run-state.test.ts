import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { SessionEvent } from "../../src/contracts/events/session"
import { SessionRunState } from "../../src/contracts/session/run-state"

describe("SessionRunState", () => {
  test("round-trips retrying and terminal states", () => {
    const retrying = Schema.decodeUnknownSync(SessionRunState.State)({
      sessionID: "ses_run_state",
      runID: "run_retrying",
      status: "retrying",
      attempt: 2,
      nextRetryAt: 20,
      error: {
        message: "rate limited",
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after": "1" },
      },
      time: { started: 10 },
    })
    expect(retrying.status).toBe("retrying")
    expect(retrying.status === "retrying" && retrying.nextRetryAt).toEqual(DateTime.makeUnsafe(20))
    expect(Schema.encodeSync(SessionRunState.State)(retrying)).toEqual({
      sessionID: "ses_run_state",
      runID: "run_retrying",
      status: "retrying",
      attempt: 2,
      nextRetryAt: 20,
      error: {
        message: "rate limited",
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after": "1" },
      },
      time: { started: 10 },
    })

    expect(() =>
      Schema.decodeUnknownSync(SessionRunState.State)({
        sessionID: "ses_run_state",
        runID: "run_failed",
        status: "terminal-failure",
        time: { started: 10, settled: 20 },
      }),
    ).toThrow()
  })

  test("requires a positive retry attempt and a branded run ID", () => {
    const base = {
      sessionID: "ses_run_state",
      runID: "run_retrying",
      attempt: 1,
      nextRetryAt: 20,
      error: { message: "retry", isRetryable: true },
    }
    expect(() => Schema.decodeUnknownSync(SessionEvent.Run.Retried.data)(base)).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent.Run.Retried.data)({
        ...base,
        attempt: 0,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent.Run.Retried.data)({
        ...base,
        runID: "retrying",
      }),
    ).toThrow()
  })
})
