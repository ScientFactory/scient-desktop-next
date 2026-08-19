import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

const EntityId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const BoundedText = Schema.String.check(Schema.isMaxLength(1024 * 1024));

export const ExecutionRunId = EntityId.pipe(Schema.brand("ExecutionRunId"));
export type ExecutionRunId = typeof ExecutionRunId.Type;

export const ExecutionStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

export const ExecutionOutputStream = Schema.Literals(["stdout", "stderr", "system"]);
export type ExecutionOutputStream = typeof ExecutionOutputStream.Type;

export const ExecutionOutputChunk = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stream: ExecutionOutputStream,
  text: BoundedText,
  observedAt: Schema.String,
});
export type ExecutionOutputChunk = typeof ExecutionOutputChunk.Type;

export const ExecutionReceiptSummary = Schema.Struct({
  runId: ExecutionRunId,
  status: ExecutionStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  failureMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  cancellationRequested: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  outputByteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputContentHash: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(256))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type ExecutionReceiptSummary = typeof ExecutionReceiptSummary.Type;

export const ExecutionReceipt = Schema.Struct({
  ...ExecutionReceiptSummary.fields,
  output: Schema.Array(ExecutionOutputChunk),
});
export type ExecutionReceipt = typeof ExecutionReceipt.Type;

export const ExecutionEvent = Schema.Union([
  Schema.TaggedStruct("status", {
    status: ExecutionStatus,
    observedAt: Schema.String,
  }),
  Schema.TaggedStruct("output", {
    chunk: ExecutionOutputChunk,
  }),
  Schema.TaggedStruct("output-truncated", {
    observedAt: Schema.String,
    maximumBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type ExecutionEvent = typeof ExecutionEvent.Type;

export interface ExecutionProcessRequest {
  readonly runId: ExecutionRunId;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ExecutionProcessError extends Schema.TaggedErrorClass<ExecutionProcessError>()(
  "ExecutionProcessError",
  {
    operation: Schema.Literals(["spawn", "output", "exit", "cancel"]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ExecutionProcessOutput {
  readonly stream: Extract<ExecutionOutputStream, "stdout" | "stderr">;
  readonly text: string;
}

export interface ExecutionProcessHandle {
  readonly output: Stream.Stream<ExecutionProcessOutput, ExecutionProcessError>;
  readonly exitCode: Effect.Effect<number, ExecutionProcessError>;
  readonly cancel: Effect.Effect<void, ExecutionProcessError>;
}

export interface ExecutionProcessPort {
  readonly start: (
    request: ExecutionProcessRequest,
  ) => Effect.Effect<ExecutionProcessHandle, ExecutionProcessError, Scope.Scope>;
}

export const DuplexProcessId = EntityId.pipe(Schema.brand("DuplexProcessId"));
export type DuplexProcessId = typeof DuplexProcessId.Type;

export interface DuplexProcessRequest {
  readonly processId: DuplexProcessId;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Whether to merge the host environment into `environment`. Defaults to
   * `true`. Compute launches pass a complete sanitized environment with
   * `extendEnv: false`.
   */
  readonly extendEnv?: boolean;
}

export class DuplexProcessError extends Schema.TaggedErrorClass<DuplexProcessError>()(
  "DuplexProcessError",
  {
    operation: Schema.Literals(["spawn", "output", "exit", "cancel", "write"]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * A long-lived child process Scient both writes to and reads from.
 *
 * `ExecutionProcessHandle` answers one question — what did this command print
 * before it exited — so it decodes text and merges the two output streams. A
 * process that speaks a request/reply protocol needs the opposite: bytes kept
 * intact, `stdout` kept separate from the diagnostics on `stderr`, a way to
 * send a request, and the pid that owns the tree. Both handles come from the
 * same spawn and are stopped the same way; they differ only in what they
 * expose, so a one-shot caller never acquires an input channel it cannot use.
 *
 * `write` resolves once the bytes have been accepted by the operating-system
 * stream; only the peer's protocol acknowledgement proves it received and
 * accepted a request. Writes serialize so two frames cannot arrive interleaved.
 * Consumers must start draining both `stdout` and `stderr` concurrently as
 * soon as the handle is created. The port deliberately does not add an
 * unbounded buffering layer, so a caller that waits to read can deadlock a
 * peer that is producing enough output to fill its pipe.
 *
 * `exitCode` fails when the operating system reports signal termination. A
 * caller that initiated `cancelProcessTree` should use that operation's
 * completion as the stop acknowledgement, not interpret the signal-shaped
 * `exitCode` failure as a second cancellation failure.
 * There is deliberately no way to close the input channel: a peer that answers
 * requests is asked to leave by a request it understands, and one that has
 * stopped answering is removed with `cancelProcessTree`.
 */
export interface DuplexProcessHandle {
  readonly pid: number;
  readonly stdout: Stream.Stream<Uint8Array, DuplexProcessError>;
  readonly stderr: Stream.Stream<Uint8Array, DuplexProcessError>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, DuplexProcessError>;
  readonly exitCode: Effect.Effect<number, DuplexProcessError>;
  readonly cancelProcessTree: Effect.Effect<void, DuplexProcessError>;
}

export interface DuplexProcessPort {
  readonly start: (
    request: DuplexProcessRequest,
  ) => Effect.Effect<DuplexProcessHandle, DuplexProcessError, Scope.Scope>;
}
