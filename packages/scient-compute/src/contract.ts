import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

const EntityId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Slug = Schema.NonEmptyString.check(Schema.isMaxLength(64));
const Label = Schema.String.check(Schema.isMaxLength(256));
const ShortText = Schema.String.check(Schema.isMaxLength(4096));
const StreamText = Schema.String.check(Schema.isMaxLength(1024 * 1024));
const ContentHash = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Pixels = Schema.Int.check(Schema.isGreaterThan(0));
const ProcessId = Schema.Int.check(Schema.isGreaterThan(0));
const ObservedAt = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) =>
    Option.isSome(DateTime.make(value)) ? true : "Expected an ISO-8601 instant.",
  ),
);

export const ComputeSessionId = EntityId.pipe(Schema.brand("ComputeSessionId"));
export type ComputeSessionId = typeof ComputeSessionId.Type;

export const ComputeExecutionId = EntityId.pipe(Schema.brand("ComputeExecutionId"));
export type ComputeExecutionId = typeof ComputeExecutionId.Type;

/**
 * Correlates one command with the events it causes.
 *
 * It is not the execution identifier: a runtime also answers interrupt,
 * restart, and inspection commands, and it emits output that belongs to no
 * command at all.
 */
export const ComputeRequestId = EntityId.pipe(Schema.brand("ComputeRequestId"));
export type ComputeRequestId = typeof ComputeRequestId.Type;

export const ComputeLanguageId = Slug.pipe(Schema.brand("ComputeLanguageId"));
export type ComputeLanguageId = typeof ComputeLanguageId.Type;

export const ComputeTransportKind = Slug.pipe(Schema.brand("ComputeTransportKind"));
export type ComputeTransportKind = typeof ComputeTransportKind.Type;

/**
 * Names one namespace of a session. Restarting destroys a namespace, so every
 * mutating command carries the generation it was written against and is refused
 * when that namespace is gone.
 */
export const ComputeSessionGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ComputeSessionGeneration"),
);
export type ComputeSessionGeneration = typeof ComputeSessionGeneration.Type;

export const INITIAL_COMPUTE_SESSION_GENERATION = ComputeSessionGeneration.make(1);

export function nextComputeSessionGeneration(
  generation: ComputeSessionGeneration,
): ComputeSessionGeneration {
  return ComputeSessionGeneration.make(generation + 1);
}

export const ComputeSessionStatus = Schema.Literals([
  "starting",
  "ready",
  "restarting",
  "stopping",
  "stopped",
  "failed",
  "lost",
]);
export type ComputeSessionStatus = typeof ComputeSessionStatus.Type;

export const TERMINAL_COMPUTE_SESSION_STATUSES: ReadonlySet<ComputeSessionStatus> = new Set([
  "stopped",
  "failed",
  "lost",
]);

/**
 * What the session is doing, which is not what has happened to it. A ready
 * session is idle or busy; a session whose heartbeat is late is unresponsive
 * without yet being declared lost; a failed execution leaves the session ready.
 */
export const ComputeSessionActivity = Schema.Literals(["idle", "busy", "unresponsive"]);
export type ComputeSessionActivity = typeof ComputeSessionActivity.Type;

export const ComputeExecutionStatus = Schema.Literals([
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "interrupting",
  "cancelled",
  "lost",
]);
export type ComputeExecutionStatus = typeof ComputeExecutionStatus.Type;

export const TERMINAL_COMPUTE_EXECUTION_STATUSES: ReadonlySet<ComputeExecutionStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

/** How a runtime says an execution ended. Loss is reported about the session. */
export const ComputeExecutionOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);
export type ComputeExecutionOutcome = typeof ComputeExecutionOutcome.Type;

export const ComputeOutputStream = Schema.Literals(["stdout", "stderr"]);
export type ComputeOutputStream = typeof ComputeOutputStream.Type;

/** A runtime error normalized out of a language-specific report. */
export const ComputeDiagnostic = Schema.Struct({
  errorName: Label,
  message: ShortText,
  traceback: Schema.Array(ShortText),
});
export type ComputeDiagnostic = typeof ComputeDiagnostic.Type;

export const ComputeImageMediaType = Schema.Literals(["image/png"]);
export type ComputeImageMediaType = typeof ComputeImageMediaType.Type;

/** Facts about the session itself, told in the same ordered stream as its output. */
export const ComputeSystemEvent = Schema.Literals([
  "session-started",
  "session-restarted",
  "execution-interrupted",
  "session-lost",
  "output-truncated",
  "input-unsupported",
  "runtime-warning",
]);
export type ComputeSystemEvent = typeof ComputeSystemEvent.Type;

const OutputEnvelope = {
  sequence: Sequence,
  observedAt: ObservedAt,
} as const;

/**
 * One ordered piece of what a session produced.
 *
 * The first product slice renders every member. The union is a closed set on
 * purpose: a representation Scient cannot yet display is either dropped by the
 * transport or reduced to `stream` text, so no client is ever handed a variant
 * it has no code for. Richer representations arrive as new members, and a
 * client that meets an unknown member fails to decode loudly instead of
 * silently rendering nothing.
 */
export const ComputeOutput = Schema.Union([
  Schema.TaggedStruct("stream", {
    ...OutputEnvelope,
    stream: ComputeOutputStream,
    text: StreamText,
  }),
  Schema.TaggedStruct("diagnostic", {
    ...OutputEnvelope,
    diagnostic: ComputeDiagnostic,
  }),
  Schema.TaggedStruct("image", {
    ...OutputEnvelope,
    mediaType: ComputeImageMediaType,
    contentHash: ContentHash,
    byteLength: ByteLength,
    width: Schema.NullOr(Pixels),
    height: Schema.NullOr(Pixels),
  }),
  Schema.TaggedStruct("system", {
    ...OutputEnvelope,
    event: ComputeSystemEvent,
    detail: Schema.NullOr(ShortText),
  }),
]);
export type ComputeOutput = typeof ComputeOutput.Type;

/**
 * What a transport promises to do. A session refuses to start when the runtime
 * on the other side cannot do what the session needs, rather than discovering
 * it when a user asks.
 */
export const ComputeCapability = Schema.Literals([
  "execute",
  "interrupt",
  "restart",
  "shutdown",
  "completion",
  "inspection",
  "variables",
  "stdin",
]);
export type ComputeCapability = typeof ComputeCapability.Type;

/** Identity of what is actually running, reported once the runtime answers. */
export const ComputeRuntimeIdentity = Schema.Struct({
  languageId: ComputeLanguageId,
  transportKind: ComputeTransportKind,
  protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  languageVersion: Label,
  platform: Label,
  // The supervising sidecar and the process running user code are usually not
  // the same process, and stopping the session has to reach both.
  transportProcessId: Schema.NullOr(ProcessId),
  runtimeProcessId: Schema.NullOr(ProcessId),
});
export type ComputeRuntimeIdentity = typeof ComputeRuntimeIdentity.Type;

/**
 * Transient binary image bytes carried alongside durable image metadata.
 *
 * `ComputeOutput.image` is durable metadata with no bytes; this type carries
 * the validated `Uint8Array` so Phase 3 can consume it into compute-owned
 * storage. It is never persisted: base64 and multi-megabyte byte arrays do not
 * belong in durable snapshots.
 */
export const ComputeTransportImageEvent = Schema.Struct({
  bytes: Schema.Uint8Array,
});
export type ComputeTransportImageEvent = typeof ComputeTransportImageEvent.Type;

/**
 * Everything a transport reports, in the order it happened.
 *
 * `output` carries a null `requestId` for output that belongs to the session
 * rather than to a command, which is what asynchronous runtime chatter is.
 * Attributing it to whichever execution happens to be running would put one
 * user's stray thread output inside another user's cell.
 *
 * `image` carries transient bytes only when `output` is an image; it is null
 * for every other output variant. The bytes are consumed once and never
 * persisted.
 */
export const ComputeTransportEvent = Schema.Union([
  Schema.TaggedStruct("ready", {
    runtime: ComputeRuntimeIdentity,
    capabilities: Schema.Array(ComputeCapability),
  }),
  Schema.TaggedStruct("accepted", {
    requestId: ComputeRequestId,
  }),
  Schema.TaggedStruct("output", {
    requestId: Schema.NullOr(ComputeRequestId),
    output: ComputeOutput,
    image: Schema.NullOr(ComputeTransportImageEvent),
  }),
  Schema.TaggedStruct("completed", {
    requestId: ComputeRequestId,
    outcome: ComputeExecutionOutcome,
  }),
  Schema.TaggedStruct("restarted", {
    generation: ComputeSessionGeneration,
  }),
  Schema.TaggedStruct("lost", {
    reason: ShortText,
  }),
]);
export type ComputeTransportEvent = typeof ComputeTransportEvent.Type;

export class ComputeTransportError extends Schema.TaggedErrorClass<ComputeTransportError>()(
  "ComputeTransportError",
  {
    operation: Schema.Literals([
      "open",
      "handshake",
      "execute",
      "interrupt",
      "restart",
      "shutdown",
      "receive",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** How to start a runtime. Produced by a language adapter, run by a transport. */
export interface ComputeLaunchPlan {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ComputeTransportOpenRequest {
  readonly sessionId: ComputeSessionId;
  readonly generation: ComputeSessionGeneration;
  readonly languageId: ComputeLanguageId;
  readonly transportKind: ComputeTransportKind;
  readonly launch: ComputeLaunchPlan;
  readonly requiredCapabilities: ReadonlyArray<ComputeCapability>;
}

export interface ComputeExecuteRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
  readonly code: string;
}

export interface ComputeInterruptRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
}

export interface ComputeRestartRequest {
  readonly expectedGeneration: ComputeSessionGeneration;
  readonly nextGeneration: ComputeSessionGeneration;
}

export interface ComputeShutdownRequest {
  readonly expectedGeneration: ComputeSessionGeneration;
}

/**
 * A live conversation with one runtime.
 *
 * Commands only say what to ask for; what happened is told by `events`, because
 * a runtime reports interrupts, restarts, and death asynchronously and a
 * command that returned its own result would have to guess.
 *
 * The channel already identifies the session, so each mutating command carries
 * only its expected generation. This is the stale-command boundary: a delayed
 * client cannot execute in, interrupt, restart, or shut down the namespace that
 * replaced the one it observed.
 */
export interface ComputeChannel {
  readonly events: Stream.Stream<ComputeTransportEvent, ComputeTransportError>;
  readonly execute: (request: ComputeExecuteRequest) => Effect.Effect<void, ComputeTransportError>;
  readonly interrupt: (
    request: ComputeInterruptRequest,
  ) => Effect.Effect<void, ComputeTransportError>;
  readonly restart: (request: ComputeRestartRequest) => Effect.Effect<void, ComputeTransportError>;
  readonly shutdown: (
    request: ComputeShutdownRequest,
  ) => Effect.Effect<void, ComputeTransportError>;
}

export interface ComputeTransport {
  readonly open: (
    request: ComputeTransportOpenRequest,
  ) => Effect.Effect<ComputeChannel, ComputeTransportError, Scope.Scope>;
}

export const ComputeRuntimeSource = Schema.Literals([
  "configured",
  "project",
  "path",
  "conventional",
]);
export type ComputeRuntimeSource = typeof ComputeRuntimeSource.Type;

export const ComputeRuntimeProfile = Schema.Struct({
  languageId: ComputeLanguageId,
  source: ComputeRuntimeSource,
  executable: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  languageVersion: Label,
  architecture: Schema.NullOr(Label),
  displayName: Label,
});
export type ComputeRuntimeProfile = typeof ComputeRuntimeProfile.Type;

export const ComputeRuntimeReadiness = Schema.Literals([
  "ready",
  "missing-requirement",
  "unsupported-version",
  "unusable",
]);
export type ComputeRuntimeReadiness = typeof ComputeRuntimeReadiness.Type;

/** Why a runtime cannot be used, in terms a user can act on. */
export const ComputeRuntimeVerification = Schema.Struct({
  profile: ComputeRuntimeProfile,
  readiness: ComputeRuntimeReadiness,
  missingRequirements: Schema.Array(Label),
  message: Schema.NullOr(ShortText),
});
export type ComputeRuntimeVerification = typeof ComputeRuntimeVerification.Type;

/**
 * Identifies the environment an execution ran in without repeating it. The
 * contributor names say what was hashed; the values are deliberately absent so
 * a fingerprint can be stored and shown without leaking an environment.
 */
export const ComputeEnvironmentFingerprint = Schema.Struct({
  hash: ContentHash,
  contributors: Schema.Array(Label),
});
export type ComputeEnvironmentFingerprint = typeof ComputeEnvironmentFingerprint.Type;

/** A runtime error as the runtime reported it, before an adapter normalizes it. */
export interface ComputeRuntimeErrorReport {
  readonly name: string;
  readonly value: string;
  readonly traceback: ReadonlyArray<string>;
}

export interface ComputeDiscoveryRequest {
  readonly projectRoot: string;
  readonly configuredExecutable: string | null;
}

export interface ComputeLaunchRequest {
  readonly profile: ComputeRuntimeProfile;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ComputeRuntimeError extends Schema.TaggedErrorClass<ComputeRuntimeError>()(
  "ComputeRuntimeError",
  {
    operation: Schema.Literals(["discover", "verify", "prepare", "fingerprint"]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Everything that differs between one language and the next.
 *
 * A shared transport removes wire-protocol work for every language that has a
 * kernel, and removes none of this: finding an installation, judging whether it
 * can be used, deciding how to start it, and turning its errors into something
 * readable. Session lifecycle, queueing, persistence, and output retention are
 * deliberately absent, because they are identical for every language and
 * putting them here would make each new language re-earn them.
 */
export interface ComputeLanguageAdapter {
  readonly languageId: ComputeLanguageId;
  readonly transportKind: ComputeTransportKind;
  readonly discover: (
    request: ComputeDiscoveryRequest,
  ) => Effect.Effect<ReadonlyArray<ComputeRuntimeProfile>, ComputeRuntimeError>;
  readonly verify: (
    request: ComputeLaunchRequest,
  ) => Effect.Effect<ComputeRuntimeVerification, ComputeRuntimeError>;
  readonly prepareLaunch: (
    request: ComputeLaunchRequest,
  ) => Effect.Effect<ComputeLaunchPlan, ComputeRuntimeError>;
  readonly normalizeDiagnostic: (
    report: ComputeRuntimeErrorReport,
  ) => ReadonlyArray<ComputeDiagnostic>;
  readonly fingerprintEnvironment: (
    profile: ComputeRuntimeProfile,
  ) => Effect.Effect<ComputeEnvironmentFingerprint, ComputeRuntimeError>;
}
