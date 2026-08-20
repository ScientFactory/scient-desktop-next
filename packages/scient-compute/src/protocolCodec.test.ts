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

/**
 * The decoder's buffer grows, compacts, and slides in place, and that is the
 * one piece of this module where an off-by-one would be invisible in a
 * hand-written case and corrupting in a real pipe. So it is driven with
 * arbitrary frame sizes cut at arbitrary boundaries, from a fixed seed so a
 * failure is a failure anyone can reproduce.
 */
describe("compute frame decoder under load", () => {
  const nextRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  it.effect("reassembles a thousand frames however a pipe happens to split them", () =>
    Effect.gen(function* () {
      const random = nextRandom(20260820);
      const payloads: Array<Uint8Array> = [];
      const frames: Array<Uint8Array> = [];
      for (let index = 0; index < 1000; index += 1) {
        // Zero-length, tiny, and past the 4 KiB initial capacity, in the
        // proportions a real session produces: mostly small control messages
        // with the occasional figure.
        const size =
          random() < 0.05
            ? 0
            : random() < 0.9
              ? Math.floor(random() * 200)
              : Math.floor(random() * 20_000);
        const payload = new Uint8Array(size);
        for (let byte = 0; byte < size; byte += 1) payload[byte] = Math.floor(random() * 256);
        payloads.push(payload);
        frames.push(yield* encodeComputeFrame(payload));
      }

      const wire = new Uint8Array(frames.reduce((total, frame) => total + frame.byteLength, 0));
      let offset = 0;
      for (const frame of frames) {
        wire.set(frame, offset);
        offset += frame.byteLength;
      }

      const decoder = makeComputeFrameDecoder();
      const received: Array<Uint8Array> = [];
      let cursor = 0;
      while (cursor < wire.byteLength) {
        // A pipe delivers whatever it likes: one byte, a header split in two,
        // several whole frames at once.
        const chunkSize = Math.max(1, Math.floor(random() * 9000));
        const chunk = wire.subarray(cursor, Math.min(cursor + chunkSize, wire.byteLength));
        cursor += chunk.byteLength;
        received.push(...(yield* decoder.push(chunk)));
      }
      yield* decoder.finish;

      expect(received).toHaveLength(payloads.length);
      for (let index = 0; index < payloads.length; index += 1) {
        expect(received[index]).toEqual(payloads[index]);
      }
    }),
  );

  it.effect("holds one frame's worth of memory, not one stream's", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder({ maxFrameByteLength: 64 * 1024 });
      const large = new Uint8Array(60 * 1024).fill(7);
      // Two hundred large frames through one decoder: a buffer that only ever
      // grew would be holding twelve megabytes by the end of this.
      for (let round = 0; round < 200; round += 1) {
        const frame = yield* encodeComputeFrame(large);
        const half = Math.floor(frame.byteLength / 2);
        expect(yield* decoder.push(frame.subarray(0, half))).toEqual([]);
        const completed = yield* decoder.push(frame.subarray(half));
        expect(completed).toHaveLength(1);
        expect(completed[0]?.byteLength).toBe(large.byteLength);
      }
      yield* decoder.finish;
    }),
  );

  it.effect("refuses a hostile length before it reserves anything for it", () =>
    Effect.gen(function* () {
      const decoder = makeComputeFrameDecoder();
      // The largest length a four-byte prefix can announce, from a peer that
      // then sends nothing. Reserving it first would be four gibibytes.
      const error = yield* Effect.flip(decoder.push(announcedLength(0xffffffff)));

      expect(error.reason).toBe("frame-too-large");
      const after = yield* Effect.flip(decoder.push(frameOf("{}")));
      expect(after.reason).toBe("stream-desynchronized");
    }),
  );
});
