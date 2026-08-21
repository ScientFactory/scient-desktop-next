// @effect-diagnostics schemaSyncInEffect:off -- literal and payload decode are synchronous.
// @effect-diagnostics missingEffectContext:off -- sync decode does not require runtime services.
// @effect-diagnostics unknownInRequirementsChannel:off -- sync decode has no context requirements.
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  ComputeCapability,
  ComputeExecutionOutcome,
  ComputeLanguageId,
  ComputeOutputStream,
  ComputeRequestId,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeVariable,
  ComputeProtocolError,
  type ComputeProtocolMessage,
} from "@scientfactory/compute";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MaxCodeLength = 1024 * 1024;
const MaxStreamTextLength = 256 * 1024;
const MaxErrorNameLength = 256;
const MaxErrorValueLength = 16 * 1024;
const MaxTracebackLineLength = 4 * 1024;
const MaxTracebackLines = 200;
// Base64 is ASCII, so here the two readings are the same number. Eleven
// mebibytes of base64 is an eight mebibyte figure, which leaves the 16 MiB
// frame limit room for the envelope around it.
const MaxPngBase64Bytes = 11 * 1024 * 1024;
// Raw UTF-8 SVG stays below the decoded PNG ceiling and leaves ample room for
// the JSON envelope inside the 16 MiB bridge frame.
const MaxSvgTextBytes = 8 * 1024 * 1024;
const MaxOwnerTokenLength = 128;
const MaxPathLength = 4096;
const MaxDetailLength = 4096;
const MaxFatalReasonLength = 4096;
const utf8 = new TextEncoder();

const utf8Bound = (maximum: number) =>
  Schema.makeFilter((value: string) =>
    utf8.encode(value).byteLength <= maximum ? true : `Expected at most ${maximum} UTF-8 bytes.`,
  );

// ---------------------------------------------------------------------------
// Message type union
// ---------------------------------------------------------------------------

export const BridgeMessageType = Schema.Literals([
  "hello",
  "hello-ack",
  "start-kernel",
  "kernel-ready",
  "execute",
  "accepted",
  "stream",
  "display",
  "error",
  "warning",
  "execution-complete",
  "interrupt",
  "interrupt-result",
  "inspect-variables",
  "variables",
  "restart",
  "restarted",
  "shutdown",
  "shutdown-complete",
  "fatal",
]);
export type BridgeMessageType = typeof BridgeMessageType.Type;

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

export const SERVER_TO_BRIDGE_TYPES: ReadonlySet<BridgeMessageType> = new Set([
  "hello",
  "start-kernel",
  "execute",
  "interrupt",
  "inspect-variables",
  "restart",
  "shutdown",
]);

export const BRIDGE_TO_SERVER_TYPES: ReadonlySet<BridgeMessageType> = new Set([
  "hello-ack",
  "kernel-ready",
  "accepted",
  "stream",
  "display",
  "error",
  "warning",
  "execution-complete",
  "interrupt-result",
  "variables",
  "restarted",
  "shutdown-complete",
  "fatal",
]);

export type BridgeDirection = "server-to-bridge" | "bridge-to-server";

export function bridgeMessageDirection(type: BridgeMessageType): BridgeDirection {
  return SERVER_TO_BRIDGE_TYPES.has(type) ? "server-to-bridge" : "bridge-to-server";
}

// ---------------------------------------------------------------------------
// Request-ID requirement
// ---------------------------------------------------------------------------

/**
 * Types that must carry a non-null `requestId` because they are correlated
 * with a specific execution. Everything else must be null.
 */
const COMMAND_CORRELATED_TYPES: ReadonlySet<BridgeMessageType> = new Set([
  "execute",
  "accepted",
  "execution-complete",
  "interrupt",
  "interrupt-result",
  "inspect-variables",
  "variables",
]);

/**
 * Types that *may* carry a non-null `requestId` but allow null for
 * parentless/session-level messages.
 */
const NULLABLE_REQUEST_ID_TYPES: ReadonlySet<BridgeMessageType> = new Set([
  "stream",
  "display",
  "error",
  "warning",
]);

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

const Label = Schema.String.check(Schema.isMaxLength(256));
const ShortText = Schema.String.check(Schema.isMaxLength(MaxDetailLength));

export const HelloPayload = Schema.Struct({
  buildId: Label,
  frameLimit: Schema.Int.check(Schema.isGreaterThan(0)),
  requiredCapabilities: Schema.Array(ComputeCapability),
  ownerToken: Schema.NonEmptyString.check(Schema.isMaxLength(MaxOwnerTokenLength)),
});
export type HelloPayload = typeof HelloPayload.Type;

export const HelloAckPayload = Schema.Struct({
  ownerToken: Schema.NonEmptyString.check(Schema.isMaxLength(MaxOwnerTokenLength)),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  platform: Label,
  capabilities: Schema.Array(ComputeCapability),
});
export type HelloAckPayload = typeof HelloAckPayload.Type;

export const StartKernelPayload = Schema.Struct({
  workingDirectory: Schema.NonEmptyString.check(Schema.isMaxLength(MaxPathLength)),
  /**
   * Which kernel to start.
   *
   * `null` starts an `ipykernel` inside the bridge's own interpreter, which is
   * the Python case: the server already chose that interpreter when it spawned
   * the bridge, so no kernelspec lookup can redirect it.  A name selects an
   * installed Jupyter kernelspec instead, which is how a future non-Python
   * language reuses this transport without the bridge knowing the language.
   */
  kernelName: Schema.NullOr(Label),
});
export type StartKernelPayload = typeof StartKernelPayload.Type;

export const KernelReadyPayload = Schema.Struct({
  kernelPid: Schema.Int.check(Schema.isGreaterThan(0)),
  languageId: ComputeLanguageId,
  languageVersion: Label,
  protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  capabilities: Schema.Array(ComputeCapability),
});
export type KernelReadyPayload = typeof KernelReadyPayload.Type;

export const ExecutePayload = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(MaxCodeLength), utf8Bound(MaxCodeLength)),
  silent: Schema.Boolean,
  storeHistory: Schema.Boolean,
});
export type ExecutePayload = typeof ExecutePayload.Type;

export const AcceptedPayload = Schema.Struct({});
export type AcceptedPayload = typeof AcceptedPayload.Type;

export const StreamPayload = Schema.Struct({
  stream: ComputeOutputStream,
  text: Schema.String.check(
    Schema.isMaxLength(MaxStreamTextLength),
    utf8Bound(MaxStreamTextLength),
  ),
});
export type StreamPayload = typeof StreamPayload.Type;

export const DisplayPayload = Schema.Union([
  Schema.Struct({
    mediaType: Schema.Literal("image/png"),
    data: Schema.String.check(Schema.isMaxLength(MaxPngBase64Bytes)),
  }),
  Schema.Struct({
    mediaType: Schema.Literal("image/svg+xml"),
    data: Schema.String.check(Schema.isMaxLength(MaxSvgTextBytes), utf8Bound(MaxSvgTextBytes)),
  }),
  Schema.Struct({
    mediaType: Schema.Literal("text/plain"),
    text: Schema.String.check(
      Schema.isMaxLength(MaxStreamTextLength),
      utf8Bound(MaxStreamTextLength),
    ),
  }),
]);
export type DisplayPayload = typeof DisplayPayload.Type;

export const ErrorPayload = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(MaxErrorNameLength)),
  value: Schema.String.check(Schema.isMaxLength(MaxErrorValueLength)),
  traceback: Schema.Array(Schema.String.check(Schema.isMaxLength(MaxTracebackLineLength))).check(
    Schema.isMaxLength(MaxTracebackLines),
  ),
});
export type ErrorPayload = typeof ErrorPayload.Type;

export const BridgeWarningCode = Schema.Literals([
  "output-truncated",
  "input-unsupported",
  "runtime-warning",
]);
export type BridgeWarningCode = typeof BridgeWarningCode.Type;

export const WarningPayload = Schema.Struct({
  code: BridgeWarningCode,
  detail: Schema.NullOr(ShortText),
});
export type WarningPayload = typeof WarningPayload.Type;

export const ExecutionCompletePayload = Schema.Struct({
  outcome: ComputeExecutionOutcome,
});
export type ExecutionCompletePayload = typeof ExecutionCompletePayload.Type;

export const InterruptPayload = Schema.Struct({});
export type InterruptPayload = typeof InterruptPayload.Type;

export const InterruptResultPayload = Schema.Struct({
  result: Schema.Literals(["interrupted", "terminal", "rejected", "timeout"]),
});
export type InterruptResultPayload = typeof InterruptResultPayload.Type;

export const InspectVariablesPayload = Schema.Struct({});
export type InspectVariablesPayload = typeof InspectVariablesPayload.Type;

export const VariablesPayload = Schema.Struct({
  variables: Schema.Array(ComputeVariable).check(Schema.isMaxLength(200)),
  truncated: Schema.Boolean,
  error: Schema.NullOr(ShortText),
});
export type VariablesPayload = typeof VariablesPayload.Type;

export const RestartPayload = Schema.Struct({
  nextGeneration: ComputeSessionGeneration,
});
export type RestartPayload = typeof RestartPayload.Type;

/**
 * The new generation is not in here on purpose.
 *
 * Every message already carries a `generation` in its envelope, and that is the
 * one the sequence and identity checks validate. A second copy in the payload
 * could disagree with it, and there would be no principled way to say which one
 * the session is actually at.
 */
export const RestartedPayload = Schema.Struct({
  kernelPid: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type RestartedPayload = typeof RestartedPayload.Type;

export const ShutdownPayload = Schema.Struct({});
export type ShutdownPayload = typeof ShutdownPayload.Type;

export const ShutdownCompletePayload = Schema.Struct({});
export type ShutdownCompletePayload = typeof ShutdownCompletePayload.Type;

export const FatalPayload = Schema.Struct({
  reason: Schema.String.check(Schema.isMaxLength(MaxFatalReasonLength)),
});
export type FatalPayload = typeof FatalPayload.Type;

// ---------------------------------------------------------------------------
// Payload decoder registry
// ---------------------------------------------------------------------------

/**
 * Compiled once at module load, keyed by message type.
 *
 * Every stream chunk, display and diagnostic the kernel produces passes through
 * this table, so compiling a decoder per message would put schema compilation
 * on the output hot path.  The `Record<BridgeMessageType, ...>` type makes a
 * new message type a compile error until it has a payload schema.
 */
const PAYLOAD_DECODERS: Readonly<Record<BridgeMessageType, (input: unknown) => unknown>> = {
  hello: Schema.decodeUnknownSync(HelloPayload),
  "hello-ack": Schema.decodeUnknownSync(HelloAckPayload),
  "start-kernel": Schema.decodeUnknownSync(StartKernelPayload),
  "kernel-ready": Schema.decodeUnknownSync(KernelReadyPayload),
  execute: Schema.decodeUnknownSync(ExecutePayload),
  accepted: Schema.decodeUnknownSync(AcceptedPayload),
  stream: Schema.decodeUnknownSync(StreamPayload),
  display: Schema.decodeUnknownSync(DisplayPayload),
  error: Schema.decodeUnknownSync(ErrorPayload),
  warning: Schema.decodeUnknownSync(WarningPayload),
  "execution-complete": Schema.decodeUnknownSync(ExecutionCompletePayload),
  interrupt: Schema.decodeUnknownSync(InterruptPayload),
  "interrupt-result": Schema.decodeUnknownSync(InterruptResultPayload),
  "inspect-variables": Schema.decodeUnknownSync(InspectVariablesPayload),
  variables: Schema.decodeUnknownSync(VariablesPayload),
  restart: Schema.decodeUnknownSync(RestartPayload),
  restarted: Schema.decodeUnknownSync(RestartedPayload),
  shutdown: Schema.decodeUnknownSync(ShutdownPayload),
  "shutdown-complete": Schema.decodeUnknownSync(ShutdownCompletePayload),
  fatal: Schema.decodeUnknownSync(FatalPayload),
};

/** Compiled once, for the same reason. */
const isBridgeMessageType = Schema.is(BridgeMessageType);

// ---------------------------------------------------------------------------
// Decoded bridge message
// ---------------------------------------------------------------------------

export interface BridgeMessage {
  readonly type: BridgeMessageType;
  readonly sessionId: ComputeSessionId;
  readonly generation: ComputeSessionGeneration;
  readonly requestId: ComputeRequestId | null;
  readonly sequence: number;
  readonly direction: BridgeDirection;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function bridgeProtocolError(
  reason: ComputeProtocolError["reason"],
  message: string,
  cause?: unknown,
): ComputeProtocolError {
  return new ComputeProtocolError({ reason, message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Validates a decoded protocol envelope against the bridge message schemas.
 *
 * Checks type membership, direction, request-ID requirement, and payload
 * structure. Does not check sequence contiguity or session/generation
 * matching — those require transport state.
 */
export function decodeBridgeMessage(
  message: ComputeProtocolMessage,
  expectedDirection?: BridgeDirection,
): Effect.Effect<BridgeMessage, ComputeProtocolError> {
  // All schema decodes happen synchronously outside any Effect context,
  // then the function returns a pure Effect.succeed or Effect.fail.

  // 1. Type membership.
  if (!isBridgeMessageType(message.type)) {
    return Effect.fail(
      bridgeProtocolError("malformed-payload", `Unknown bridge message type '${message.type}'.`),
    );
  }
  const type: BridgeMessageType = message.type;

  // 2. Direction
  const direction = bridgeMessageDirection(type);
  if (expectedDirection !== undefined && direction !== expectedDirection) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Message type '${type}' is ${direction}, expected ${expectedDirection}.`,
      ),
    );
  }

  // 3. Request-ID requirement
  if (COMMAND_CORRELATED_TYPES.has(type) && message.requestId === null) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Message type '${type}' requires a non-null requestId.`,
      ),
    );
  }
  if (
    !COMMAND_CORRELATED_TYPES.has(type) &&
    !NULLABLE_REQUEST_ID_TYPES.has(type) &&
    message.requestId !== null
  ) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Message type '${type}' must have a null requestId.`,
      ),
    );
  }

  // 4. Payload schema.
  let payload: unknown;
  try {
    payload = PAYLOAD_DECODERS[type](message.payload);
  } catch (cause) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Payload for '${type}' did not match its schema.`,
        cause,
      ),
    );
  }

  return Effect.succeed({
    type,
    sessionId: message.sessionId,
    generation: message.generation,
    requestId: message.requestId,
    sequence: message.sequence,
    direction,
    payload,
  } satisfies BridgeMessage);
}

// ---------------------------------------------------------------------------
// Sequence tracking
// ---------------------------------------------------------------------------

export interface BridgeSequenceTracker {
  readonly expectedDirection: BridgeDirection;
  nextExpected: number;
}

export function makeBridgeSequenceTracker(direction: BridgeDirection): BridgeSequenceTracker {
  return { expectedDirection: direction, nextExpected: 0 };
}

/**
 * Validates that a message's sequence is the next contiguous value for its
 * direction. Pipes preserve order, so a gap is corruption, not a retry case.
 */
export function validateBridgeSequence(
  tracker: BridgeSequenceTracker,
  message: BridgeMessage,
): Effect.Effect<BridgeMessage, ComputeProtocolError> {
  if (message.direction !== tracker.expectedDirection) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Expected ${tracker.expectedDirection} message but received ${message.direction}.`,
      ),
    );
  }
  if (message.sequence !== tracker.nextExpected) {
    return Effect.fail(
      bridgeProtocolError(
        "malformed-payload",
        `Expected sequence ${tracker.nextExpected} but received ${message.sequence} for ${message.direction}.`,
      ),
    );
  }
  tracker.nextExpected += 1;
  return Effect.succeed(message);
}
