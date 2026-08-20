import * as Schema from "effect/Schema";

import {
  ComputeDiagnostic,
  ComputeEnvironmentFingerprint,
  ComputeExecutionId,
  ComputeExecutionOutcome,
  ComputeExecutionStatus,
  ComputeLanguageId,
  ComputeOutput,
  ComputeRuntimeIdentity,
  ComputeRuntimeProfile,
  ComputeSessionActivity,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeSessionStatus,
  ComputeTransportKind,
} from "./contract.ts";
import {
  ByteLength,
  ContentHash,
  Count,
  EntityId,
  Label,
  ObservedAt,
  Sequence,
  ShortText,
  StreamText,
} from "./primitives.ts";

/**
 * What a session and its executions look like once they are written down.
 *
 * `contract.ts` describes a live conversation with a runtime: what a transport
 * promises, what it reports, and in what order. This describes what survives
 * the runtime, the server, and the machine being switched off. The two are
 * deliberately separate types over shared primitives -- a durable record has to
 * answer questions a live event never does ("what was submitted", "what was it
 * submitted against", "how did it end"), and a live event carries things that
 * must never be stored, such as image bytes.
 */

/** A project identifier as the server knows it, used as a storage segment. */
export const ComputeProjectId = EntityId.pipe(Schema.brand("ComputeProjectId"));
export type ComputeProjectId = typeof ComputeProjectId.Type;

/** Where in a document an execution came from. Zero-based, end-exclusive. */
export const ComputeSourceRange = Schema.Struct({
  startLine: Count,
  startColumn: Count,
  endLine: Count,
  endColumn: Count,
});
export type ComputeSourceRange = typeof ComputeSourceRange.Type;

/**
 * Where submitted code came from.
 *
 * A union rather than one struct with nullable members: console code has no
 * path, no revision, and no range, and a struct would leave a reader unable to
 * tell an absent locator from a console execution that stored one anyway. The
 * three document origins share every field, so they share a member and differ
 * by `origin`.
 *
 * `bufferState` says whether the submitted bytes matched durable source. The
 * exact submitted code is stored on the request either way; this flag prevents
 * a reader from attributing dirty editor bytes to the saved file. `revision` is
 * the saved revision the editor was based on, or null for an untracked/unknown
 * base. It lets a transcript say the file has changed since rather than showing
 * a range that now points somewhere else.
 */
export const ComputeExecutionSource = Schema.Union([
  Schema.TaggedStruct("console", {}),
  Schema.TaggedStruct("document", {
    origin: Schema.Literals(["file", "selection", "cell"]),
    path: ShortText,
    bufferState: Schema.Literals(["saved", "dirty"]),
    revision: Schema.NullOr(Label),
    range: Schema.NullOr(ComputeSourceRange),
  }),
]);
export type ComputeExecutionSource = typeof ComputeExecutionSource.Type;

/** Whether a session's bulky data is still on disk. */
export const ComputeSessionStorage = Schema.Struct({
  status: Schema.Literals(["retained", "metadata-only"]),
  outputBytes: ByteLength,
  imageBytes: ByteLength,
  totalBytes: ByteLength,
  removedAt: Schema.NullOr(ObservedAt),
});
export type ComputeSessionStorage = typeof ComputeSessionStorage.Type;

export const EMPTY_COMPUTE_SESSION_STORAGE: ComputeSessionStorage = {
  status: "retained",
  outputBytes: 0,
  imageBytes: 0,
  totalBytes: 0,
  removedAt: null,
};

/**
 * The durable state of one session.
 *
 * `activeExecutionId` and `pendingCount` are stored rather than derived because
 * they are the two facts recovery has to contradict: a record that says an
 * execution was active is exactly what proves, after a restart, that something
 * has to be marked lost. Deriving them from the execution directory would
 * require reading every execution to answer a question about the session.
 */
export const ComputeSessionRecord = Schema.Struct({
  sessionId: ComputeSessionId,
  projectId: ComputeProjectId,
  label: Label,
  languageId: ComputeLanguageId,
  transportKind: ComputeTransportKind,
  workingDirectory: ShortText,
  // Null until the runtime has been chosen, and again after a record is
  // recovered from a version that could not have chosen one.
  runtime: Schema.NullOr(ComputeRuntimeProfile),
  // Null until the runtime answers: this is what did reply, not what was asked
  // for, and before the handshake completes nothing has replied.
  identity: Schema.NullOr(ComputeRuntimeIdentity),
  environmentFingerprint: Schema.NullOr(ComputeEnvironmentFingerprint),
  generation: ComputeSessionGeneration,
  status: ComputeSessionStatus,
  activity: ComputeSessionActivity,
  activeExecutionId: Schema.NullOr(ComputeExecutionId),
  pendingCount: Count,
  storage: ComputeSessionStorage,
  createdAt: ObservedAt,
  lastActivityAt: ObservedAt,
  closedAt: Schema.NullOr(ObservedAt),
  lostReason: Schema.NullOr(ShortText),
});
export type ComputeSessionRecord = typeof ComputeSessionRecord.Type;

/**
 * What was submitted, written once and never rewritten.
 *
 * Split from the result so a crash mid-update can corrupt only the mutable
 * half. It is also what makes recovery honest: a request with no result is an
 * execution that was in flight when the server stopped, which is the one case
 * that must become `lost` rather than being quietly forgotten.
 */
export const ComputeExecutionRequestRecord = Schema.Struct({
  executionId: ComputeExecutionId,
  sessionId: ComputeSessionId,
  generation: ComputeSessionGeneration,
  code: StreamText,
  codeHash: ContentHash,
  source: ComputeExecutionSource,
  submittedAt: ObservedAt,
  environmentFingerprint: Schema.NullOr(ComputeEnvironmentFingerprint),
});
export type ComputeExecutionRequestRecord = typeof ComputeExecutionRequestRecord.Type;

/**
 * What became of a submitted execution.
 *
 * `queuePosition` is stored rather than computed on read. A client that was
 * told it is third in line has to keep being told the same thing, and a
 * position recomputed from a list that has since changed is a different number.
 */
export const ComputeExecutionResultRecord = Schema.Struct({
  executionId: ComputeExecutionId,
  status: ComputeExecutionStatus,
  outcome: Schema.NullOr(ComputeExecutionOutcome),
  queuePosition: Schema.NullOr(Count),
  startedAt: Schema.NullOr(ObservedAt),
  finishedAt: Schema.NullOr(ObservedAt),
  diagnostics: Schema.Array(ComputeDiagnostic).check(Schema.isMaxLength(64)),
  outputCount: Count,
  outputBytes: ByteLength,
  truncated: Schema.Boolean,
  failureReason: Schema.NullOr(ShortText),
});
export type ComputeExecutionResultRecord = typeof ComputeExecutionResultRecord.Type;

/**
 * A whole execution as a reader sees it.
 *
 * `result` is null only for a request that was persisted and never updated,
 * which recovery repairs the first time it reads the session. It is modelled
 * rather than defaulted so the repair is a decision the service makes, not a
 * gap a reader silently fills.
 */
export const ComputeExecutionRecord = Schema.Struct({
  request: ComputeExecutionRequestRecord,
  result: Schema.NullOr(ComputeExecutionResultRecord),
});
export type ComputeExecutionRecord = typeof ComputeExecutionRecord.Type;

/**
 * What happened to a session, in the order it happened.
 *
 * The journal is append-only and is never read to answer a question the session
 * record already answers. It exists so an operator can reconstruct why a
 * session ended up in a state, which a snapshot by definition cannot say.
 */
export const ComputeSessionJournalEvent = Schema.Literals([
  "session-created",
  "session-ready",
  "session-restarted",
  "session-stopping",
  "session-stopped",
  "session-failed",
  "session-lost",
  "session-recovered",
  "session-unresponsive",
  "execution-submitted",
  "execution-started",
  "execution-finished",
  "execution-cancelled",
  "queue-rejected",
  "storage-trimmed",
]);
export type ComputeSessionJournalEvent = typeof ComputeSessionJournalEvent.Type;

export const ComputeSessionJournalEntry = Schema.Struct({
  sequence: Sequence,
  observedAt: ObservedAt,
  event: ComputeSessionJournalEvent,
  generation: ComputeSessionGeneration,
  executionId: Schema.NullOr(ComputeExecutionId),
  detail: Schema.NullOr(ShortText),
});
export type ComputeSessionJournalEntry = typeof ComputeSessionJournalEntry.Type;

/**
 * Names one stored image without naming a file.
 *
 * The content hash is the identity, and the file name is derived from it. A
 * reference that carried a file name would let a corrupted record choose which
 * file the server opens.
 */
export const ComputeOutputResourceRef = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  // Null for an image a session produced outside any execution. Rare -- a
  // background thread drawing a figure -- but the transport allows it, and a
  // reference that could not express it would make such an image permanently
  // unreachable rather than merely unusual.
  executionId: Schema.NullOr(ComputeExecutionId),
  contentHash: ContentHash,
});
export type ComputeOutputResourceRef = typeof ComputeOutputResourceRef.Type;

/**
 * What a subscriber is told, in one ordered stream.
 *
 * `eventSequence` is the ordering and recovery cursor minted by the service.
 * A subscriber discards events covered by its snapshot; if it observes a gap,
 * it re-reads the durable list/output APIs before applying later deltas. The
 * stream is a fast notification path, never the authority for a transcript.
 */
export const ComputeSessionStreamEvent = Schema.Union([
  Schema.TaggedStruct("session-snapshot", {
    eventSequence: Sequence,
    session: ComputeSessionRecord,
  }),
  Schema.TaggedStruct("session-updated", {
    eventSequence: Sequence,
    session: ComputeSessionRecord,
  }),
  Schema.TaggedStruct("execution-updated", {
    eventSequence: Sequence,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    execution: ComputeExecutionRecord,
  }),
  Schema.TaggedStruct("execution-output", {
    eventSequence: Sequence,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    // Null for output that belongs to the session rather than to a command.
    // Attributing a stray thread's print to whichever cell happens to be
    // running would put one execution's output inside another's transcript.
    executionId: Schema.NullOr(ComputeExecutionId),
    outputs: Schema.Array(ComputeOutput),
  }),
]);
export type ComputeSessionStreamEvent = typeof ComputeSessionStreamEvent.Type;
