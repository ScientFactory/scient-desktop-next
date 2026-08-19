import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ComputeOutput, ComputeTransportEvent } from "./contract.ts";

const decodeOutput = Schema.decodeUnknownSync(ComputeOutput);
const decodeTransportEvent = Schema.decodeUnknownSync(ComputeTransportEvent);

describe("compute contract", () => {
  it("accepts observed timestamps only when they are ISO-8601 instants", () => {
    expect(
      decodeOutput({
        _tag: "stream",
        sequence: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        stream: "stdout",
        text: "ready\n",
      }).observedAt,
    ).toBe("2026-08-19T00:00:00.000Z");

    expect(() =>
      decodeOutput({
        _tag: "stream",
        sequence: 0,
        observedAt: "eventually",
        stream: "stdout",
        text: "ready\n",
      }),
    ).toThrow();
  });

  it("accepts a runtime-warning system event", () => {
    const output = decodeOutput({
      _tag: "system",
      sequence: 0,
      observedAt: "2026-08-19T00:00:00.000Z",
      event: "runtime-warning",
      detail: "Inconsistent kernel metadata.",
    });
    if (output._tag === "system") {
      expect(output.event).toBe("runtime-warning");
    }
  });

  it("rejects an unknown system event", () => {
    expect(() =>
      decodeOutput({
        _tag: "system",
        sequence: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        event: "not-a-real-event",
        detail: null,
      }),
    ).toThrow();
  });

  it("carries transient image bytes alongside durable image metadata", () => {
    const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const event = decodeTransportEvent({
      _tag: "output",
      requestId: "request-1",
      output: {
        _tag: "image",
        sequence: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        mediaType: "image/png",
        contentHash: "sha256:abc123",
        byteLength: 8,
        width: 1,
        height: 1,
      },
      image: { bytes: pngSignature },
    });
    if (event._tag === "output" && event.image !== null) {
      expect(event.image.bytes).toEqual(pngSignature);
    }
  });

  it("accepts null image bytes for non-image outputs", () => {
    const event = decodeTransportEvent({
      _tag: "output",
      requestId: null,
      output: {
        _tag: "stream",
        sequence: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        stream: "stdout",
        text: "hello\n",
      },
      image: null,
    });
    if (event._tag === "output") {
      expect(event.image).toBeNull();
    }
  });
});
