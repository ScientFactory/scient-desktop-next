// @effect-diagnostics nodeBuiltinImport:off -- fixture loader reads JSON from disk.
import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  COMPUTE_PROTOCOL_VERSION,
  ComputeRequestId,
  ComputeSessionGeneration,
  ComputeSessionId,
  decodeComputeProtocolMessage,
  makeComputeFrameDecoder,
} from "@scientfactory/compute";

import {
  BRIDGE_TO_SERVER_TYPES,
  SERVER_TO_BRIDGE_TYPES,
  decodeBridgeMessage,
  makeBridgeSequenceTracker,
  validateBridgeSequence,
  ErrorPayload,
  ExecutePayload,
  DisplayPayload,
  HelloAckPayload,
  HelloPayload,
  InterruptResultPayload,
  KernelReadyPayload,
  RestartedPayload,
  StreamPayload,
  WarningPayload,
  type BridgeDirection,
  type BridgeMessage,
} from "./BridgeProtocol.ts";

const here = Path.dirname(fileURLToPath(import.meta.url));

const sessionId = ComputeSessionId.make("session-test");
const generation = ComputeSessionGeneration.make(1);
const requestId = ComputeRequestId.make("request-1");

const envelope = (
  type: string,
  payload: unknown,
  overrides?: Partial<{
    readonly requestId: ComputeRequestId | null;
    readonly sequence: number;
  }>,
) => ({
  protocolVersion: COMPUTE_PROTOCOL_VERSION,
  type,
  sessionId,
  generation,
  requestId: overrides?.requestId ?? null,
  sequence: overrides?.sequence ?? 0,
  payload,
});

const loadFixture = (name: string): string =>
  FS.readFileSync(Path.join(here, "fixtures", "bridge", name), "utf-8");

describe("bridge protocol payload schemas", () => {
  it("accepts a valid hello payload", () => {
    const payload = Schema.decodeUnknownSync(HelloPayload)({
      buildId: "build-1",
      frameLimit: 16 * 1024 * 1024,
      requiredCapabilities: ["execute", "interrupt", "restart", "shutdown"],
      ownerToken: "token-abc",
    });
    expect(payload.buildId).toBe("build-1");
  });

  it("accepts a valid hello-ack payload", () => {
    const payload = Schema.decodeUnknownSync(HelloAckPayload)({
      ownerToken: "token-abc",
      pid: 12345,
      platform: "darwin",
      capabilities: ["execute", "interrupt", "restart", "shutdown"],
    });
    expect(payload.pid).toBe(12345);
  });

  it("rejects a hello-ack with non-positive pid", () => {
    expect(() =>
      Schema.decodeUnknownSync(HelloAckPayload)({
        ownerToken: "token-abc",
        pid: 0,
        platform: "darwin",
        capabilities: [],
      }),
    ).toThrow();
  });

  it("accepts a valid execute payload", () => {
    const payload = Schema.decodeUnknownSync(ExecutePayload)({
      code: "print('hello')\n",
      silent: false,
      storeHistory: true,
    });
    expect(payload.code).toBe("print('hello')\n");
  });

  it("rejects an execute payload with oversized code", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExecutePayload)({
        code: "x".repeat(1024 * 1024 + 1),
        silent: false,
        storeHistory: true,
      }),
    ).toThrow();
  });

  it("accepts a valid stream payload", () => {
    const payload = Schema.decodeUnknownSync(StreamPayload)({
      stream: "stdout",
      text: "output line\n",
    });
    expect(payload.stream).toBe("stdout");
  });

  it("rejects a stream payload with oversized text", () => {
    expect(() =>
      Schema.decodeUnknownSync(StreamPayload)({
        stream: "stdout",
        text: "x".repeat(256 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("accepts a valid PNG display payload", () => {
    const payload = Schema.decodeUnknownSync(DisplayPayload)({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(payload.mediaType).toBe("image/png");
  });

  it("accepts a valid text display payload", () => {
    const payload = Schema.decodeUnknownSync(DisplayPayload)({
      mediaType: "text/plain",
      text: "<Figure size 640x480>",
    });
    expect(payload.mediaType).toBe("text/plain");
  });

  it("rejects a display payload with unknown media type", () => {
    expect(() =>
      Schema.decodeUnknownSync(DisplayPayload)({
        mediaType: "text/html",
        text: "<b>bold</b>",
      }),
    ).toThrow();
  });

  it("accepts a valid error payload", () => {
    const payload = Schema.decodeUnknownSync(ErrorPayload)({
      name: "ValueError",
      value: "bad value",
      traceback: ["line 1", "line 2"],
    });
    expect(payload.name).toBe("ValueError");
  });

  it("rejects an error payload with too many traceback lines", () => {
    expect(() =>
      Schema.decodeUnknownSync(ErrorPayload)({
        name: "ValueError",
        value: "bad value",
        traceback: Array(201).fill("line"),
      }),
    ).toThrow();
  });

  it("accepts a valid warning payload", () => {
    const payload = Schema.decodeUnknownSync(WarningPayload)({
      code: "output-truncated",
      detail: "Stream text exceeded 256 KiB.",
    });
    expect(payload.code).toBe("output-truncated");
  });

  it("rejects a warning payload with unknown code", () => {
    expect(() =>
      Schema.decodeUnknownSync(WarningPayload)({
        code: "not-a-real-warning",
        detail: null,
      }),
    ).toThrow();
  });

  it("accepts a valid kernel-ready payload", () => {
    const payload = Schema.decodeUnknownSync(KernelReadyPayload)({
      kernelPid: 99999,
      languageId: "python",
      languageVersion: "3.12.0",
      protocolVersion: 1,
      capabilities: ["execute", "interrupt", "restart", "shutdown"],
    });
    expect(payload.kernelPid).toBe(99999);
  });

  it("accepts a valid interrupt-result payload", () => {
    const payload = Schema.decodeUnknownSync(InterruptResultPayload)({
      result: "interrupted",
    });
    expect(payload.result).toBe("interrupted");
  });

  it("accepts a valid restarted payload", () => {
    const payload = Schema.decodeUnknownSync(RestartedPayload)({
      kernelPid: 88888,
      generation: 2,
    });
    expect(payload.generation).toBe(2);
  });
});

describe("bridge protocol message decoding", () => {
  it.effect("decodes a valid hello message with correct direction", () =>
    Effect.gen(function* () {
      const message = yield* decodeBridgeMessage(
        envelope("hello", {
          buildId: "build-1",
          frameLimit: 16 * 1024 * 1024,
          requiredCapabilities: ["execute", "interrupt", "restart", "shutdown"],
          ownerToken: "token-abc",
        }),
        "server-to-bridge",
      );
      expect(message.type).toBe("hello");
      expect(message.direction).toBe("server-to-bridge");
    }),
  );

  it.effect("rejects an unknown message type", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeBridgeMessage(envelope("not-a-type", {})));
      expect(error.reason).toBe("malformed-payload");
      expect(error.message).toContain("Unknown bridge message type");
    }),
  );

  it.effect("rejects a wrong-direction message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBridgeMessage(
          envelope("hello", {
            buildId: "build-1",
            frameLimit: 16 * 1024 * 1024,
            requiredCapabilities: ["execute"],
            ownerToken: "token-abc",
          }),
          "bridge-to-server",
        ),
      );
      expect(error.message).toContain("server-to-bridge");
    }),
  );

  it.effect("rejects a command-correlated message with null requestId", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBridgeMessage(
          envelope(
            "execute",
            { code: "print(1)", silent: false, storeHistory: true },
            { requestId: null },
          ),
        ),
      );
      expect(error.message).toContain("non-null requestId");
    }),
  );

  it.effect("rejects a non-command message with non-null requestId", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBridgeMessage(
          envelope(
            "hello-ack",
            {
              ownerToken: "token-abc",
              pid: 12345,
              platform: "darwin",
              capabilities: [],
            },
            { requestId },
          ),
        ),
      );
      expect(error.message).toContain("null requestId");
    }),
  );

  it.effect("allows nullable-requestId types with null requestId", () =>
    Effect.gen(function* () {
      const message = yield* decodeBridgeMessage(
        envelope("stream", { stream: "stdout", text: "hi\n" }, { requestId: null }),
      );
      expect(message.type).toBe("stream");
    }),
  );

  it.effect("allows nullable-requestId types with non-null requestId", () =>
    Effect.gen(function* () {
      const message = yield* decodeBridgeMessage(
        envelope("stream", { stream: "stdout", text: "hi\n" }, { requestId }),
      );
      expect(message.type).toBe("stream");
    }),
  );

  it.effect("rejects a payload that does not match its type schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBridgeMessage(envelope("execute", { wrong: "shape" }, { requestId })),
      );
      expect(error.message).toContain("did not match");
    }),
  );
});

describe("bridge protocol direction sets", () => {
  it("places every type in exactly one direction", () => {
    const allTypes = new Set([...SERVER_TO_BRIDGE_TYPES, ...BRIDGE_TO_SERVER_TYPES]);
    expect(allTypes.size).toBe(SERVER_TO_BRIDGE_TYPES.size + BRIDGE_TO_SERVER_TYPES.size);
    expect(SERVER_TO_BRIDGE_TYPES.size).toBe(6);
    expect(BRIDGE_TO_SERVER_TYPES.size).toBe(12);
  });
});

describe("bridge protocol sequence tracking", () => {
  const msg = (
    type: string,
    sequence: number,
    payload: unknown,
    reqId: ComputeRequestId | null = null,
  ): BridgeMessage => ({
    type: type as any,
    sessionId,
    generation,
    requestId: reqId,
    sequence,
    direction: SERVER_TO_BRIDGE_TYPES.has(type as any) ? "server-to-bridge" : "bridge-to-server",
    payload,
  });

  it.effect("accepts contiguous sequence values", () =>
    Effect.gen(function* () {
      const tracker = makeBridgeSequenceTracker("bridge-to-server");
      yield* validateBridgeSequence(tracker, msg("hello-ack", 0, {}));
      yield* validateBridgeSequence(tracker, msg("kernel-ready", 1, {}));
      expect(tracker.nextExpected).toBe(2);
    }),
  );

  it.effect("rejects a gap in sequence", () =>
    Effect.gen(function* () {
      const tracker = makeBridgeSequenceTracker("bridge-to-server");
      yield* validateBridgeSequence(tracker, msg("hello-ack", 0, {}));
      const error = yield* Effect.flip(validateBridgeSequence(tracker, msg("kernel-ready", 2, {})));
      expect(error.message).toContain("Expected sequence 1");
    }),
  );

  it.effect("rejects a duplicate sequence", () =>
    Effect.gen(function* () {
      const tracker = makeBridgeSequenceTracker("bridge-to-server");
      yield* validateBridgeSequence(tracker, msg("hello-ack", 0, {}));
      const error = yield* Effect.flip(validateBridgeSequence(tracker, msg("kernel-ready", 0, {})));
      expect(error.message).toContain("Expected sequence 1");
    }),
  );

  it.effect("rejects a wrong-direction message", () =>
    Effect.gen(function* () {
      const tracker = makeBridgeSequenceTracker("bridge-to-server");
      const error = yield* Effect.flip(validateBridgeSequence(tracker, msg("hello", 0, {})));
      expect(error.message).toContain("Expected bridge-to-server");
    }),
  );
});

describe("bridge protocol golden fixtures", () => {
  const decodeFromWire = (json: string) =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const frameBytes = encoder.encode(json);
      const framed = new Uint8Array(4 + frameBytes.byteLength);
      new DataView(framed.buffer).setUint32(0, frameBytes.byteLength, false);
      framed.set(frameBytes, 4);
      const [decoded] = yield* makeComputeFrameDecoder().push(framed);
      const message = yield* decodeComputeProtocolMessage(decoded!);
      return yield* decodeBridgeMessage(message);
    });

  it.effect("decodes the hello golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("hello.json"));
      expect(message.type).toBe("hello");
      expect(message.direction).toBe("server-to-bridge");
    }),
  );

  it.effect("decodes the hello-ack golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("hello-ack.json"));
      expect(message.type).toBe("hello-ack");
      expect(message.direction).toBe("bridge-to-server");
    }),
  );

  it.effect("decodes the stream golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("stream.json"));
      expect(message.type).toBe("stream");
    }),
  );

  it.effect("decodes the error golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("error.json"));
      expect(message.type).toBe("error");
    }),
  );

  it.effect("decodes the execution-complete golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("execution-complete.json"));
      expect(message.type).toBe("execution-complete");
    }),
  );

  it.effect("decodes the interrupt-result golden fixture", () =>
    Effect.gen(function* () {
      const message = yield* decodeFromWire(loadFixture("interrupt-result.json"));
      expect(message.type).toBe("interrupt-result");
    }),
  );
});
