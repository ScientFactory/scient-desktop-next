import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputeRequestId, ComputeSessionGeneration, ComputeSessionId } from "./contract.ts";

/**
 * The version of the framing and envelope described in this module.
 *
 * A peer states its version during the handshake and Scient refuses a version
 * it does not implement, before any user code runs. Guessing compatibility
 * would risk a peer that silently drops the fields Scient depends on.
 */
export const COMPUTE_PROTOCOL_VERSION = 1;

/** Bytes of big-endian unsigned length that precede every payload. */
export const COMPUTE_FRAME_HEADER_BYTE_LENGTH = 4;

/**
 * The largest payload either side will send or accept.
 *
 * A length prefix is a promise from an untrusted peer, so the limit is checked
 * against the prefix rather than against what arrives: a corrupt or hostile
 * length is refused before Scient reserves memory for it. Sixteen mebibytes
 * holds a large figure with room to spare while keeping one message far below
 * anything that would threaten the server.
 */
export const MAX_COMPUTE_FRAME_BYTE_LENGTH = 16 * 1024 * 1024;

// Most control messages fit comfortably here. Larger frames grow on demand,
// while an idle session does not retain 64 KiB for a four-byte header.
const INITIAL_DECODER_CAPACITY = 4 * 1024;

export class ComputeProtocolError extends Schema.TaggedErrorClass<ComputeProtocolError>()(
  "ComputeProtocolError",
  {
    reason: Schema.Literals([
      "frame-too-large",
      "truncated-frame",
      "decoder-finished",
      "malformed-payload",
      "unsupported-version",
      "stream-desynchronized",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The stable shape of every message on the wire.
 *
 * `payload` stays unvalidated here on purpose. Framing and routing are one
 * concern with one lifetime; the meaning of a payload belongs to whatever
 * handles that message type, and coupling the two would make every new message
 * type a change to the transport.
 */
export const ComputeProtocolMessage = Schema.Struct({
  protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  type: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  sessionId: ComputeSessionId,
  generation: ComputeSessionGeneration,
  // Null for anything a peer says on its own behalf rather than in answer.
  requestId: Schema.NullOr(ComputeRequestId),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  payload: Schema.Unknown,
});
export type ComputeProtocolMessage = typeof ComputeProtocolMessage.Type;

const ComputeProtocolMessageJson = Schema.fromJsonString(ComputeProtocolMessage);
const decodeMessageJson = Schema.decodeUnknownEffect(ComputeProtocolMessageJson);
const encodeMessageJson = Schema.encodeEffect(ComputeProtocolMessageJson);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function protocolError(
  reason: ComputeProtocolError["reason"],
  message: string,
  cause?: unknown,
): ComputeProtocolError {
  return new ComputeProtocolError({ reason, message, cause });
}

/** Prefixes a payload with its length, refusing one no peer is allowed to send. */
export function encodeComputeFrame(
  payload: Uint8Array,
): Effect.Effect<Uint8Array, ComputeProtocolError> {
  if (payload.byteLength > MAX_COMPUTE_FRAME_BYTE_LENGTH) {
    return Effect.fail(
      protocolError(
        "frame-too-large",
        `A ${payload.byteLength} byte message exceeds the ${MAX_COMPUTE_FRAME_BYTE_LENGTH} byte protocol limit.`,
      ),
    );
  }
  const frame = new Uint8Array(COMPUTE_FRAME_HEADER_BYTE_LENGTH + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, COMPUTE_FRAME_HEADER_BYTE_LENGTH);
  return Effect.succeed(frame);
}

export function encodeComputeProtocolMessage(
  message: ComputeProtocolMessage,
): Effect.Effect<Uint8Array, ComputeProtocolError> {
  return encodeMessageJson(message).pipe(
    Effect.mapError((cause) =>
      protocolError("malformed-payload", "The protocol message could not be encoded.", cause),
    ),
    Effect.flatMap((json) => encodeComputeFrame(textEncoder.encode(json))),
  );
}

export function decodeComputeProtocolMessage(
  frame: Uint8Array,
): Effect.Effect<ComputeProtocolMessage, ComputeProtocolError> {
  return Effect.suspend(() => {
    let json: string;
    try {
      json = textDecoder.decode(frame);
    } catch (cause) {
      return Effect.fail(
        protocolError("malformed-payload", "A protocol message was not valid UTF-8.", cause),
      );
    }
    return decodeMessageJson(json).pipe(
      Effect.mapError((cause) =>
        protocolError("malformed-payload", "A protocol message did not match the envelope.", cause),
      ),
    );
  });
}

/**
 * Confirms a peer speaks the protocol this build implements.
 *
 * Kept apart from decoding so a mismatch can be reported precisely: the
 * envelope of a future version still decodes, which is exactly what makes a
 * clear "this peer speaks version N" message possible instead of a parse error.
 */
export function requireSupportedProtocolVersion(
  message: ComputeProtocolMessage,
): Effect.Effect<ComputeProtocolMessage, ComputeProtocolError> {
  if (message.protocolVersion !== COMPUTE_PROTOCOL_VERSION) {
    return Effect.fail(
      protocolError(
        "unsupported-version",
        `The peer speaks protocol version ${message.protocolVersion}; this build implements version ${COMPUTE_PROTOCOL_VERSION}.`,
      ),
    );
  }
  return Effect.succeed(message);
}

/**
 * Reassembles frames from however a pipe happens to deliver bytes.
 *
 * A pipe splits and joins writes freely, so a decoder that assumed one read is
 * one message would fail the first time a figure crossed a buffer boundary.
 *
 * The buffer grows and is compacted in place rather than being rebuilt on every
 * chunk: a megabyte figure arrives as hundreds of small reads, and re-copying
 * everything received so far on each of them would turn a linear amount of work
 * into a quadratic one.
 */
export interface ComputeFrameDecoder {
  /** Frames completed by this chunk, in arrival order. */
  readonly push: (
    chunk: Uint8Array,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, ComputeProtocolError>;
  /**
   * Validates the decoder when its byte stream ends.
   *
   * A clean end has no buffered bytes. Any remainder is a truncated header or
   * payload, never an orderly shutdown, and must fail before the transport can
   * mistake a missing reply for successful completion.
   */
  readonly finish: Effect.Effect<void, ComputeProtocolError>;
}

type FrameScan =
  | { readonly _tag: "frames"; readonly frames: ReadonlyArray<Uint8Array> }
  | { readonly _tag: "refused"; readonly byteLength: number };

export function makeComputeFrameDecoder(options?: {
  readonly maxFrameByteLength?: number;
}): ComputeFrameDecoder {
  const maxFrameByteLength = options?.maxFrameByteLength ?? MAX_COMPUTE_FRAME_BYTE_LENGTH;
  let buffer = new Uint8Array(INITIAL_DECODER_CAPACITY);
  let start = 0;
  let end = 0;
  // A refused length tells us nothing about where the next frame begins, so the
  // stream cannot be resynchronized and every later chunk is refused too.
  let desynchronized: ComputeProtocolError | undefined;
  let finished = false;
  const maximumSingleFrameByteLength = COMPUTE_FRAME_HEADER_BYTE_LENGTH + maxFrameByteLength;

  const append = (chunk: Uint8Array): void => {
    const pending = end - start;
    if (pending + chunk.byteLength > buffer.byteLength) {
      let capacity = buffer.byteLength;
      while (capacity < pending + chunk.byteLength && capacity < maximumSingleFrameByteLength) {
        capacity = Math.min(capacity * 2, maximumSingleFrameByteLength);
      }
      // A read may contain several complete frames. Preserve that valid case
      // without doubling a maximum-size single frame to 32 MiB.
      capacity = Math.max(capacity, pending + chunk.byteLength);
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(start, end));
      buffer = grown;
    } else if (start > 0) {
      buffer.set(buffer.subarray(start, end));
    }
    start = 0;
    end = pending;
    buffer.set(chunk, end);
    end += chunk.byteLength;
  };

  const compactAfterScan = (): void => {
    const pending = end - start;
    if (
      start === 0 ||
      buffer.byteLength <= INITIAL_DECODER_CAPACITY ||
      buffer.byteLength <= pending * 2
    ) {
      return;
    }
    const compacted = new Uint8Array(Math.max(INITIAL_DECODER_CAPACITY, pending));
    compacted.set(buffer.subarray(start, end));
    buffer = compacted;
    start = 0;
    end = pending;
  };

  const releaseBuffer = (): void => {
    buffer = new Uint8Array(INITIAL_DECODER_CAPACITY);
    start = 0;
    end = 0;
  };

  const scanFrames = (): FrameScan => {
    const frames: Array<Uint8Array> = [];
    for (;;) {
      if (end - start < COMPUTE_FRAME_HEADER_BYTE_LENGTH) return { _tag: "frames", frames };
      const byteLength = new DataView(buffer.buffer, buffer.byteOffset + start).getUint32(0, false);
      if (byteLength > maxFrameByteLength) return { _tag: "refused", byteLength };
      const frameEnd = start + COMPUTE_FRAME_HEADER_BYTE_LENGTH + byteLength;
      if (end < frameEnd) return { _tag: "frames", frames };
      frames.push(buffer.slice(start + COMPUTE_FRAME_HEADER_BYTE_LENGTH, frameEnd));
      start = frameEnd;
    }
  };

  const finish = Effect.suspend(() => {
    if (desynchronized !== undefined) return Effect.fail(desynchronized);
    if (finished) return Effect.void;
    const pendingByteLength = end - start;
    if (pendingByteLength === 0) {
      finished = true;
      releaseBuffer();
      return Effect.void;
    }

    let message: string;
    if (pendingByteLength < COMPUTE_FRAME_HEADER_BYTE_LENGTH) {
      message =
        `The protocol stream ended ${String(COMPUTE_FRAME_HEADER_BYTE_LENGTH - pendingByteLength)} ` +
        "bytes before its next frame header was complete.";
    } else {
      const announcedByteLength = new DataView(buffer.buffer, buffer.byteOffset + start).getUint32(
        0,
        false,
      );
      const receivedPayloadByteLength = pendingByteLength - COMPUTE_FRAME_HEADER_BYTE_LENGTH;
      message =
        `The protocol stream ended after ${String(receivedPayloadByteLength)} of ` +
        `${String(announcedByteLength)} announced payload bytes.`;
    }

    desynchronized = protocolError(
      "stream-desynchronized",
      "The message stream cannot be reused after ending with an incomplete frame.",
    );
    releaseBuffer();
    return Effect.fail(protocolError("truncated-frame", message));
  });

  return {
    push: (chunk) =>
      Effect.suspend(() => {
        if (desynchronized !== undefined) return Effect.fail(desynchronized);
        if (finished) {
          return Effect.fail(
            protocolError(
              "decoder-finished",
              "The protocol decoder cannot accept bytes after its stream ended.",
            ),
          );
        }
        append(chunk);
        const scan = scanFrames();
        if (scan._tag === "refused") {
          desynchronized = protocolError(
            "stream-desynchronized",
            "The message stream cannot be resynchronized after an oversized message.",
          );
          releaseBuffer();
          return Effect.fail(
            protocolError(
              "frame-too-large",
              `A peer announced a ${scan.byteLength} byte message, above the ${maxFrameByteLength} byte protocol limit.`,
            ),
          );
        }
        compactAfterScan();
        return Effect.succeed(scan.frames);
      }),
    finish,
  };
}
