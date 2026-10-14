export * as SessionEvent from "./session"

import { Schema } from "effect"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "../inference/llm"
import { Delivery } from "../session/delivery"
import { Model } from "../inference/model"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath } from "../schema"
import { FileAttachment, Prompt } from "../session/prompt"
import { SessionID } from "../session/id"
import { Location } from "../workspace/location"
import { SessionMessageID } from "../session/message-id"
import { SessionMessage } from "../session/message"
import { Revert } from "../session/revert"
import { VerificationReceipt } from "../execution/verification-receipt"
import { SessionV1 } from "../session/compat"
import { SessionRunState } from "../session/run-state"
import { SessionInputOrigin } from "../session/input-origin"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = typeof Source.Type

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}

/**
 * Transitional, replayable projection for readers that still consume the V1
 * message tables. The discriminator versions the embedded projection itself;
 * the enclosing durable event version intentionally remains unchanged while
 * the workspace protocol requires homogeneous PHINs versions.
 *
 * Older binaries strip unknown Struct fields while decoding and re-encoding,
 * so publishers MUST NOT send a checkpoint through an older relay. Mixed-
 * version workspace synchronization needs a capability gate before this field
 * may be emitted across that boundary.
 */
export const LegacyProjection = Schema.Struct({
  version: Schema.Literal(1),
  canonicalMessageID: SessionMessageID.ID,
  message: SessionV1.Info,
  parts: Schema.Array(
    Schema.Struct({
      part: SessionV1.Part,
      time: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "session.next.legacy_projection.v1" })
export type LegacyProjection = typeof LegacyProjection.Type

const LegacyProjectionField = {
  legacyProjection: LegacyProjection.pipe(Schema.optional),
}

const PromptFields = {
  ...Base,
  messageID: SessionMessageID.ID,
  prompt: Prompt,
  delivery: Delivery,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const verificationRequestOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const verificationSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 3,
  },
} as const
const transcriptMutationOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(Schema.optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: { ...PromptFields, ...LegacyProjectionField },
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: PromptFields,
})
export type PromptAdmitted = typeof PromptAdmitted.Type

// A distinct durable type prevents older relays from stripping provenance
// and replaying a remote command as an unrestricted local prompt.
export const OriginPromptAdmitted = Event.define({
  type: "session.next.prompt.origin.admitted",
  ...options,
  schema: { ...PromptFields, origin: SessionInputOrigin.Origin },
})
export type OriginPromptAdmitted = typeof OriginPromptAdmitted.Type

/** A remote promotion must retain its durable source, never use Prompted. */
export const OriginPrompted = Event.define({
  type: "session.next.prompt.origin.promoted",
  ...options,
  schema: { ...PromptFields, origin: SessionInputOrigin.Origin },
})
export type OriginPrompted = typeof OriginPrompted.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

/** Historical copy only: it admits no input and cannot schedule execution. */
export const MessageCopied = Event.define({
  type: "session.next.message.copied",
  ...options,
  schema: { ...Base, sourceSessionID: SessionID, message: SessionMessage.Message },
})
export type MessageCopied = typeof MessageCopied.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export const VerificationRequested = Event.define({
  type: "session.next.verification.requested",
  ...verificationRequestOptions,
  schema: {
    ...Base,
    request: VerificationReceipt.Request,
  },
})
export type VerificationRequested = typeof VerificationRequested.Type

export const VerificationSettled = Event.define({
  type: "session.next.verification.settled",
  ...verificationSettlementOptions,
  schema: {
    ...Base,
    settlement: VerificationReceipt.Settlement,
  },
})
export type VerificationSettled = typeof VerificationSettled.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      messageID: SessionMessageID.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      messageID: SessionMessageID.ID.pipe(Schema.optional),
      callID: Schema.String,
      output: Schema.String,
      error: SessionMessage.UnknownError.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(Schema.optional),
      files: Schema.Array(RelativePath).pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      legacyPartID: SessionV1.PartID.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      text: Schema.String,
      legacyPartID: SessionV1.PartID.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      legacyPartID: SessionV1.PartID.pipe(Schema.optional),
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      legacyPartID: SessionV1.PartID.pipe(Schema.optional),
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessageID.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        ...LegacyProjectionField,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        ...LegacyProjectionField,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      ...LegacyProjectionField,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      ...LegacyProjectionField,
      structured: Schema.Record(Schema.String, Schema.Any),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      ...LegacyProjectionField,
      structured: Schema.Record(Schema.String, Schema.Any),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(Schema.optional),
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      ...LegacyProjectionField,
      error: UnknownError,
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = SessionRunState.RetryError
export type RetryError = SessionRunState.RetryError

export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

/** Durable run lifecycle used to recover process-local execution state. */
export namespace Run {
  export const Started = Event.define({
    type: "session.next.run.started",
    ...options,
    schema: {
      ...Base,
      runID: SessionRunState.ID,
      inputID: SessionMessageID.ID.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Retried = Event.define({
    type: "session.next.run.retried",
    ...options,
    schema: {
      sessionID: SessionID,
      runID: SessionRunState.ID,
      attempt: PositiveInt,
      nextRetryAt: DateTimeUtcFromMillis,
      error: RetryError,
    },
  })
  export type Retried = typeof Retried.Type

  export const Settled = Event.define({
    type: "session.next.run.settled",
    ...options,
    schema: {
      ...Base,
      runID: SessionRunState.ID,
      outcome: SessionRunState.Outcome,
    },
  })
  export type Settled = typeof Settled.Type
}

/**
 * Authoritative V1-compatible transcript mutations. Version 2 keeps the
 * existing public event names and payloads while separating new durable
 * writers from the historical SessionV1 definitions.
 */
export namespace Transcript {
  export const Reset = Event.define({
    type: "session.next.transcript.reset",
    ...options,
    schema: Base,
  })
  export type Reset = typeof Reset.Type

  export const MessageUpdated = Event.define({
    type: SessionV1.Event.MessageUpdated.type,
    ...transcriptMutationOptions,
    schema: SessionV1.Event.MessageUpdated.data.fields,
  })
  export type MessageUpdated = typeof MessageUpdated.Type

  export const MessageRemoved = Event.define({
    type: SessionV1.Event.MessageRemoved.type,
    ...transcriptMutationOptions,
    schema: SessionV1.Event.MessageRemoved.data.fields,
  })
  export type MessageRemoved = typeof MessageRemoved.Type

  export const PartUpdated = Event.define({
    type: SessionV1.Event.PartUpdated.type,
    ...transcriptMutationOptions,
    schema: SessionV1.Event.PartUpdated.data.fields,
  })
  export type PartUpdated = typeof PartUpdated.Type

  export const PartRemoved = Event.define({
    type: SessionV1.Event.PartRemoved.type,
    ...transcriptMutationOptions,
    schema: SessionV1.Event.PartRemoved.data.fields,
  })
  export type PartRemoved = typeof PartRemoved.Type
}

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      ...LegacyProjectionField,
      messageID: SessionMessageID.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessageID.ID },
  })
}

export const DurableDefinitions = Event.inventory(
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  OriginPromptAdmitted,
  OriginPrompted,
  ContextUpdated,
  MessageCopied,
  Synthetic,
  VerificationRequested,
  VerificationSettled,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Run.Started,
  Run.Retried,
  Run.Settled,
  Transcript.Reset,
  Transcript.MessageUpdated,
  Transcript.MessageRemoved,
  Transcript.PartUpdated,
  Transcript.PartRemoved,
  Compaction.Started,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Definitions = Event.inventory(
  AgentSwitched,
  ModelSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  OriginPromptAdmitted,
  OriginPrompted,
  ContextUpdated,
  MessageCopied,
  Synthetic,
  VerificationRequested,
  VerificationSettled,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Retried,
  Run.Started,
  Run.Retried,
  Run.Settled,
  Transcript.Reset,
  Transcript.MessageUpdated,
  Transcript.MessageRemoved,
  Transcript.PartUpdated,
  Transcript.PartRemoved,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
