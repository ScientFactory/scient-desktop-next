import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ComputeRequestId, ComputeSessionGeneration, ComputeSessionId } from "./contract.ts";
import {
  COMPUTE_FRAME_HEADER_BYTE_LENGTH,
  COMPUTE_PROTOCOL_VERSION,
  MAX_COMPUTE_FRAME_BYTE_LENGTH,
  decodeComputeProtocolMessage,
  encodeComputeFrame,
  encodeComputeProtocolMessage,
  makeComputeFrameDecoder,
  requireSupportedProtocolVersion,
  type ComputeProtocolMessage,
} from "./protocolCodec.ts";

const message: ComputeProtocolMessage = {
  protocolVersion: COMPUTE_PROTOCOL_VERSION,
  type: "execute",
  sessionId: ComputeSessionId.make("session-1"),
  generation: ComputeSessionGeneration.make(1),
  requestId: ComputeRequestId.make("request-1"),
  sequence: 7,
  payload: { code: "value = 1\n" },
};

const encoder = new TextEncoder();

const frameOf = (payload: string): Uint8Array => {
  const bytes = encoder.encode(payload);
  const frame = new Uint8Array(COMPUTE_FRAME_HEADER_BYTE_LENGTH + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
  frame.set(bytes, COMPUTE_FRAME_HEADER_BYTE_LENGTH);
  return frame;
};

const announcedLength = (byteLength: number): Uint8Array => {
  const header = new Uint8Array(COMPUTE_FRAME_HEADER_BYTE_LENGTH);
  new DataView(header.buffer).setUint32(0, byteLength, false);
  return header;
};

describe("compute protocol frames", () => {
  it.effect("prefixes a payload with its big-endian length", () =>
    Effect.gen(function* () {
      const frame = yield* encodeComputeFrame(encoder.encode("hi"));

      expect([...frame]).toEqual([0, 0, 0, 2, 0x68, 0x69]);
    }),
  );

  it.effect("refuses to send a message above the protocol limit", () =>
    Effect.gen(function* () {
      const oversized = new Uint8Array(MAX_COMPUTE_FRAME_BYTE_LENGTH + 1);

      const error = yield* Effect.flip(encodeComputeFrame(oversized));

      expect(error.reason).toBe("frame-too-large");
    }),
  );

  it.effect("round-trips a message through the wire form", () =>
    Effect.gen(function* () {
      const frame = yield* encodeComputeProtocolMessage(message);
      const [decoded] = yield* makeComputeFrameDecoder().push(frame);

      expect(yield* decodeComputeProtocolMessage(decoded!)).toEqual(message);
    }),
  );
});

describe("compute frame decoder", () => {
  it.effect("waits for a frame that arrives one byte at a time", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      const frame = frameOf('{"a":1}');
      const completed: Array<Uint8Array> = [];

      for (const byte of frame) {
        completed.push(...(yield* decoder.push(Uint8Array.of(byte))));
      }

      // Split inside the length header as well as inside the payload.
      expect(completed).toHaveLength(1);
      expect(new TextDecoder().decode(completed[0])).toBe('{"a":1}');
    }),
  );

  it.effect("returns every frame a single chunk completed, in order", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      const first = frameOf('{"a":1}');
      const second = frameOf('{"b":2}');
      const combined = new Uint8Array(first.byteLength + second.byteLength);
      combined.set(first);
      combined.set(second, first.byteLength);

      const frames = yield* decoder.push(combined);

      expect(frames.map((frame) => new TextDecoder().decode(frame))).toEqual([
        '{"a":1}',
        '{"b":2}',
      ]);
    }),
  );

  it.effect("keeps the tail of a chunk that ended mid-frame", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      const first = frameOf('{"a":1}');
      const second = frameOf('{"b":2}');
      const chunk = new Uint8Array(first.byteLength + 3);
      chunk.set(first);
      chunk.set(second.subarray(0, 3), first.byteLength);

      expect(yield* decoder.push(chunk)).toHaveLength(1);
      expect(yield* decoder.push(second.subarray(3))).toHaveLength(1);
    }),
  );

  it.effect("accepts a stream that ends exactly between frames", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();

      expect(yield* decoder.push(frameOf('{"a":1}'))).toHaveLength(1);
      expect(yield* decoder.finish).toBeUndefined();
      expect(yield* decoder.finish).toBeUndefined();

      const error = yield* Effect.flip(decoder.push(frameOf('{"b":2}')));
      expect(error.reason).toBe("decoder-finished");
    }),
  );

  it.effect("rejects a stream that ends inside a frame header", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();

      expect(yield* decoder.push(Uint8Array.of(0, 0, 0))).toEqual([]);
      const error = yield* Effect.flip(decoder.finish);

      expect(error.reason).toBe("truncated-frame");
      expect(error.message).toContain("1 bytes before");
    }),
  );

  it.effect("rejects a stream that ends inside an announced payload", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      const partial = new Uint8Array(COMPUTE_FRAME_HEADER_BYTE_LENGTH + 3);
      new DataView(partial.buffer).setUint32(0, 8, false);
      partial.set(encoder.encode("abc"), COMPUTE_FRAME_HEADER_BYTE_LENGTH);

      expect(yield* decoder.push(partial)).toEqual([]);
      const error = yield* Effect.flip(decoder.finish);

      expect(error.reason).toBe("truncated-frame");
      expect(error.message).toContain("3 of 8 announced payload bytes");
    }),
  );

  it.effect("grows past its initial capacity for a large frame", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      const payload = "x".repeat(256 * 1024);
      const frame = frameOf(payload);
      const chunkSize = 4096;
      const completed: Array<Uint8Array> = [];

      for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
        completed.push(...(yield* decoder.push(frame.subarray(offset, offset + chunkSize))));
      }

      expect(completed).toHaveLength(1);
      expect(completed[0]!.byteLength).toBe(payload.length);
    }),
  );

  it.effect("refuses an announced length above the limit before reserving it", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();

      const error = yield* Effect.flip(
        decoder.push(announcedLength(MAX_COMPUTE_FRAME_BYTE_LENGTH + 1)),
      );

      expect(error.reason).toBe("frame-too-large");
    }),
  );

  it.effect("stays failed once a stream can no longer be resynchronized", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder({ maxFrameByteLength: 8 });

      yield* Effect.flip(decoder.push(announcedLength(9)));
      const error = yield* Effect.flip(decoder.push(frameOf("ok")));

      expect(error.reason).toBe("stream-desynchronized");
    }),
  );
});

describe("compute protocol messages", () => {
  it.effect("rejects a payload that is not JSON", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeComputeProtocolMessage(encoder.encode("not json")));

      expect(error.reason).toBe("malformed-payload");
    }),
  );

  it.effect("rejects a message that is missing envelope fields", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeComputeProtocolMessage(encoder.encode('{"type":"execute"}')),
      );

      expect(error.reason).toBe("malformed-payload");
    }),
  );

  it.effect("rejects bytes that are not valid UTF-8", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeComputeProtocolMessage(Uint8Array.of(0x7b, 0xff, 0x7d)),
      );

      expect(error.reason).toBe("malformed-payload");
    }),
  );

  it.effect("reads the envelope of a version it does not implement, then refuses it", () =>
    Effect.gen(function* () {
      const future = { ...message, protocolVersion: COMPUTE_PROTOCOL_VERSION + 1 };
      const [frame] = yield* makeComputeFrameDecoder().push(
        yield* encodeComputeProtocolMessage(future),
      );
      const decoded = yield* decodeComputeProtocolMessage(frame!);

      expect(decoded.protocolVersion).toBe(COMPUTE_PROTOCOL_VERSION + 1);

      const error = yield* Effect.flip(requireSupportedProtocolVersion(decoded));

      expect(error.reason).toBe("unsupported-version");
      expect(yield* requireSupportedProtocolVersion(message)).toEqual(message);
    }),
  );
});
