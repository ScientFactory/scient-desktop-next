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
  ComputeProtocolError,
  type ComputeProtocolMessage,
} from "@scientfactory/compute";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MaxCodeBytes = 1024 * 1024;
const MaxStreamTextBytes = 256 * 1024;
const MaxErrorNameBytes = 256;
const MaxErrorValueBytes = 16 * 1024;
const MaxTracebackLineBytes = 4 * 1024;
const MaxTracebackLines = 200;
const MaxPngBase64Bytes = 11 * 1024 * 1024;
const MaxOwnerTokenLength = 128;
const MaxPathLength = 4096;
const MaxDetailLength = 4096;
const MaxFatalReasonLength = 4096;

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
  code: Schema.String.check(Schema.isMaxLength(MaxCodeBytes)),
  silent: Schema.Boolean,
  storeHistory: Schema.Boolean,
});
export type ExecutePayload = typeof ExecutePayload.Type;

export const AcceptedPayload = Schema.Struct({});
export type AcceptedPayload = typeof AcceptedPayload.Type;

export const StreamPayload = Schema.Struct({
  stream: ComputeOutputStream,
  text: Schema.String.check(Schema.isMaxLength(MaxStreamTextBytes)),
});
export type StreamPayload = typeof StreamPayload.Type;

export const DisplayPayload = Schema.Union([
  Schema.Struct({
    mediaType: Schema.Literal("image/png"),
    data: Schema.String.check(Schema.isMaxLength(MaxPngBase64Bytes)),
  }),
  Schema.Struct({
    mediaType: Schema.Literal("text/plain"),
    text: Schema.String.check(Schema.isMaxLength(MaxStreamTextBytes)),
  }),
]);
export type DisplayPayload = typeof DisplayPayload.Type;

export const ErrorPayload = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(MaxErrorNameBytes)),
  value: Schema.String.check(Schema.isMaxLength(MaxErrorValueBytes)),
  traceback: Schema.Array(Schema.String.check(Schema.isMaxLength(MaxTracebackLineBytes))).check(
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

export const RestartPayload = Schema.Struct({
  nextGeneration: ComputeSessionGeneration,
});
export type RestartPayload = typeof RestartPayload.Type;

export const RestartedPayload = Schema.Struct({
  kernelPid: Schema.Int.check(Schema.isGreaterThan(0)),
  generation: ComputeSessionGeneration,
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
// Payload schema registry
// ---------------------------------------------------------------------------

const PAYLOAD_SCHEMAS: Readonly<Record<BridgeMessageType, Schema.Schema<any>>> = {
  hello: HelloPayload,
  "hello-ack": HelloAckPayload,
  "start-kernel": StartKernelPayload,
  "kernel-ready": KernelReadyPayload,
  execute: ExecutePayload,
  accepted: AcceptedPayload,
  stream: StreamPayload,
  display: DisplayPayload,
  error: ErrorPayload,
  warning: WarningPayload,
  "execution-complete": ExecutionCompletePayload,
  interrupt: InterruptPayload,
  "interrupt-result": InterruptResultPayload,
  restart: RestartPayload,
  restarted: RestartedPayload,
  shutdown: ShutdownPayload,
  "shutdown-complete": ShutdownCompletePayload,
  fatal: FatalPayload,
} as const;

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
  let type: BridgeMessageType;
  try {
    type = Schema.decodeUnknownSync(BridgeMessageType)(message.type);
  } catch {
    return Effect.fail(
      bridgeProtocolError("malformed-payload", `Unknown bridge message type '${message.type}'.`),
    );
  }

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
    // The union of payload schemas from the record cannot be statically
    // narrowed to ConstraintDecoder<unknown, never>; the cast is safe
    // because every entry is a self-contained Schema.Struct with R = never.
    const decode = Schema.decodeUnknownSync(PAYLOAD_SCHEMAS[type] as never);
    payload = decode(message.payload);
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
