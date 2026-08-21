import * as Schema from "effect/Schema";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeOutput,
  ComputeSessionGeneration,
  ComputeSessionId,
} from "./contract.ts";
import { Count, Label, ShortText, StreamText } from "./primitives.ts";
import { ComputeExecutionSource, ComputeProjectId } from "./record.ts";

/**
 * What a client asks a compute session coordinator to do, and how it is told no.
 *
 * These are the commands, not the transport: a transport speaks to one runtime
 * and knows nothing of projects, queues, or history. Everything here is
 * addressed by `(projectId, sessionId)` and carries the generation the caller
 * believed it was talking to, because a session can be restarted underneath a
 * client that is still holding a stale view of it.
 *
 * Inputs are schemas rather than interfaces so the RPC boundary can decode them
 * once, at the edge, instead of every caller hand-validating the same fields.
 */

export class ComputeOperationError extends Schema.TaggedErrorClass<ComputeOperationError>()(
  "ComputeOperationError",
  {
    operation: Schema.Literals([
      "start",
      "submit",
      "cancel",
      "interrupt",
      "restart",
      "stop",
      "list",
      "get",
      "outputs",
      "resolve",
      "subscribe",
      "inspect",
      "verify",
      "variables",
    ]),
    reason: Schema.Literals([
      // The session is not there, or is not in a state that can run code.
      "session-not-found",
      "session-not-running",
      "session-terminal",
      "session-conflict",
      // The caller is talking about a namespace that has been replaced.
      "generation-stale",
      // The session is there and healthy but has nowhere to put the work.
      "queue-full",
      // No usable runtime for the language, in terms a user can act on.
      "runtime-missing",
      "runtime-unusable",
      "capability-missing",
      // The execution is not there, or has already ended.
      "execution-not-found",
      "execution-already-finished",
      "execution-conflict",
      // Something underneath failed.
      "transport-failed",
      "persistence-failed",
      "operation-failed",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Starting a session names it: the caller chooses the id, so a retried start is
 * idempotent rather than a second runtime for the same panel.
 *
 * `projectId` is passed rather than derived from `workingDirectory` because
 * resolving a project identity is the RPC edge's job, and a coordinator that
 * did it too would need a project on disk to be testable at all.
 */
export const ComputeStartSessionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  languageId: ComputeLanguageId,
  label: Label,
  workingDirectory: ShortText,
  configuredExecutable: Schema.NullOr(ShortText),
});
export type ComputeStartSessionInput = typeof ComputeStartSessionInput.Type;

/** The caller names the execution too, for the same reason it names the session. */
export const ComputeSubmitExecutionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
  code: StreamText,
  source: ComputeExecutionSource,
});
export type ComputeSubmitExecutionInput = typeof ComputeSubmitExecutionInput.Type;

/** Interrupt, restart, and stop all address a session at a known generation. */
export const ComputeSessionCommandInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeSessionCommandInput = typeof ComputeSessionCommandInput.Type;

export const ComputeExecutionCommandInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeExecutionCommandInput = typeof ComputeExecutionCommandInput.Type;

export const ComputeListSessionsInput = Schema.Struct({
  projectId: ComputeProjectId,
});
export type ComputeListSessionsInput = typeof ComputeListSessionsInput.Type;

export const ComputeGetSessionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
});
export type ComputeGetSessionInput = typeof ComputeGetSessionInput.Type;

export const ComputeListExecutionsInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
});
export type ComputeListExecutionsInput = typeof ComputeListExecutionsInput.Type;

/** A null `executionId` asks for the output that belongs to the session itself. */
export const ComputeListOutputsInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: Schema.NullOr(ComputeExecutionId),
});
export type ComputeListOutputsInput = typeof ComputeListOutputsInput.Type;

export const ComputeSubscribeSessionsInput = Schema.Struct({
  projectId: ComputeProjectId,
});
export type ComputeSubscribeSessionsInput = typeof ComputeSubscribeSessionsInput.Type;

/**
 * A transcript as it could be read back, with the damage stated rather than
 * hidden: a line that could not be decoded is counted, not silently skipped, so
 * a client can say the transcript is incomplete instead of implying it is whole.
 */
export const ComputeExecutionOutputs = Schema.Struct({
  outputs: Schema.Array(ComputeOutput),
  corruptLineCount: Count,
});
export type ComputeExecutionOutputs = typeof ComputeExecutionOutputs.Type;
