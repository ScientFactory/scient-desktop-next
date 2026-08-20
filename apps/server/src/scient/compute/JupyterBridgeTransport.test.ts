import { describe, expect, it } from "@effect/vitest";
import {
  COMPUTE_PROTOCOL_VERSION,
  ComputeLanguageId,
  ComputeRequestId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  decodeComputeProtocolMessage,
  encodeComputeProtocolMessage,
  makeComputeFrameDecoder,
  nextComputeSessionGeneration,
  type ComputeChannel,
  type ComputeProtocolMessage,
  type ComputeSessionGeneration,
  type ComputeTransportEvent,
} from "@scientfactory/compute";
import {
  DuplexProcessError,
  type DuplexProcessHandle,
  type DuplexProcessPort,
} from "@scientfactory/execution";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeJupyterBridgeTransport } from "./JupyterBridgeTransport.ts";

// ---------------------------------------------------------------------------
// A bridge that never runs
// ---------------------------------------------------------------------------

const BRIDGE_PID = 4242;
const KERNEL_PID = 4243;
const sessionId = ComputeSessionId.make("transport-unit-session");
const python = ComputeLanguageId.make("python");
const transportKind = ComputeTransportKind.make("jupyter-bridge");
const capabilities = ["execute", "interrupt", "restart", "shutdown"] as const;

/** What a real bridge would answer, expressed as a pure function of the command. */
type Responder = (command: ComputeProtocolMessage) => ReadonlyArray<
  Pick<ComputeProtocolMessage, "type" | "payload"> & {
    readonly generation?: ComputeSessionGeneration;
    readonly requestId?: string | null;
  }
>;

interface FakeBridge {
  readonly port: DuplexProcessPort;
  readonly sent: () => ReadonlyArray<ComputeProtocolMessage>;
  /** Speaks one message on the bridge's behalf, minting the next sequence. */
  readonly say: (
    message: Pick<ComputeProtocolMessage, "type" | "payload"> & {
      readonly generation?: ComputeSessionGeneration;
      readonly requestId?: string | null;
    },
  ) => Effect.Effect<void>;
  readonly sayRaw: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly writeStderr: (text: string) => Effect.Effect<void>;
  readonly endStdout: Effect.Effect<void>;
  readonly exitWith: (code: number) => Effect.Effect<void>;
  readonly cancels: () => number;
  readonly respond: (responder: Responder) => void;
}

/**
 * The default answers, which are the ones a healthy bridge gives.
 *
 * A test that cares about a specific reply replaces this rather than scripting
 * every message: the interesting part of a case should be the only unusual
 * thing in it.
 */
const healthyResponder =
  (ownerTokenOf: (command: ComputeProtocolMessage) => string): Responder =>
  (command) => {
    switch (command.type) {
      case "hello":
        return [
          {
            type: "hello-ack",
            payload: {
              ownerToken: ownerTokenOf(command),
              pid: BRIDGE_PID,
              platform: "darwin",
              capabilities: [...capabilities],
            },
          },
        ];
      case "start-kernel":
        return [
          {
            type: "kernel-ready",
            payload: {
              kernelPid: KERNEL_PID,
              languageId: "python",
              languageVersion: "3.12.0",
              protocolVersion: COMPUTE_PROTOCOL_VERSION,
              capabilities: [...capabilities],
            },
          },
        ];
      case "execute":
        return [{ type: "accepted", payload: {}, requestId: command.requestId }];
      case "interrupt":
        return [
          {
            type: "interrupt-result",
            payload: { result: "interrupted" },
            requestId: command.requestId,
          },
        ];
      case "restart":
        return [
          {
            type: "restarted",
            payload: { kernelPid: KERNEL_PID + 1 },
            generation: (command.payload as { nextGeneration: ComputeSessionGeneration })
              .nextGeneration,
          },
        ];
      case "shutdown":
        return [{ type: "shutdown-complete", payload: {} }];
      default:
        return [];
    }
  };

const makeFakeBridge = Effect.fn("makeFakeBridge")(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, DuplexProcessError | Cause.Done>();
  const stderr = yield* Queue.unbounded<Uint8Array, DuplexProcessError | Cause.Done>();
  const exited = yield* Deferred.make<number, DuplexProcessError>();
  const received: ComputeProtocolMessage[] = [];
  const inboundDecoder = makeComputeFrameDecoder();
  let outboundSequence = 0;
  let cancels = 0;
  let responder: Responder = healthyResponder(
    (command) => (command.payload as { ownerToken: string }).ownerToken,
  );

  const say: FakeBridge["say"] = (message) =>
    Effect.gen(function* () {
      const frame = yield* encodeComputeProtocolMessage({
        protocolVersion: COMPUTE_PROTOCOL_VERSION,
        type: message.type,
        sessionId,
        generation: message.generation ?? INITIAL_COMPUTE_SESSION_GENERATION,
        requestId:
          message.requestId === undefined
            ? null
            : message.requestId === null
              ? null
              : ComputeRequestId.make(message.requestId),
        sequence: outboundSequence++,
        payload: message.payload,
      }).pipe(Effect.orDie);
      yield* Queue.offer(stdout, frame);
    });

  const handle: DuplexProcessHandle = {
    pid: BRIDGE_PID,
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.fromQueue(stderr),
    write: (bytes) =>
      Effect.gen(function* () {
        const frames = yield* inboundDecoder.push(bytes).pipe(Effect.orDie);
        for (const frame of frames) {
          const command = yield* decodeComputeProtocolMessage(frame).pipe(Effect.orDie);
          received.push(command);
          for (const reply of responder(command)) {
            yield* say({ generation: command.generation, ...reply });
          }
        }
      }),
    exitCode: Deferred.await(exited),
    cancelProcessTree: Effect.sync(() => {
      cancels += 1;
    }),
  };

  return {
    port: { start: () => Effect.succeed(handle) },
    sent: () => received,
    say,
    sayRaw: (bytes) => Queue.offer(stdout, bytes).pipe(Effect.asVoid),
    writeStderr: (text) => Queue.offer(stderr, new TextEncoder().encode(text)).pipe(Effect.asVoid),
    endStdout: Queue.end(stdout).pipe(Effect.asVoid),
    exitWith: (code) => Deferred.succeed(exited, code).pipe(Effect.asVoid),
    cancels: () => cancels,
    respond: (next) => {
      responder = next;
    },
  } satisfies FakeBridge;
});

const openChannel = Effect.fn("openChannel")(function* (
  bridge: FakeBridge,
  options: { readonly maxEventQueueBytes?: number } = {},
) {
  const transport = makeJupyterBridgeTransport(bridge.port, {
    startupTimeoutMs: 2_000,
    ...options,
  });
  return yield* transport.open({
    sessionId,
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    languageId: python,
    transportKind,
    launch: {
      executable: "/usr/bin/python3",
      args: ["-I", "-u", "/app/bridge.py"],
      cwd: "/project",
      environment: {},
    },
    requiredCapabilities: [...capabilities],
  });
});

/** Reads events one at a time without ending the stream. */
const makeReader = Effect.fn("makeReader")(function* (channel: ComputeChannel) {
  const queue = yield* Queue.unbounded<ComputeTransportEvent>();
  yield* channel.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    next: Queue.take(queue),
    until: (tag: ComputeTransportEvent["_tag"]) =>
      Effect.gen(function* () {
        const seen: ComputeTransportEvent[] = [];
        for (;;) {
          const event = yield* Queue.take(queue);
          seen.push(event);
          if (event._tag === tag) return seen;
        }
      }),
  };
});

const harness = Effect.fn("harness")(function* () {
  const bridge = yield* makeFakeBridge();
  const channel = yield* openChannel(bridge);
  const reader = yield* makeReader(channel);
  return { bridge, channel, reader };
});

function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const request = (id: string) => ComputeRequestId.make(id);

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe("jupyter bridge handshake", () => {
  it.effect("greets, starts a kernel by interpreter, and reports the runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const channel = yield* openChannel(bridge);
        const reader = yield* makeReader(channel);
        const ready = yield* reader.next;

        expect(ready._tag).toBe("ready");
        if (ready._tag !== "ready") return;
        expect(ready.runtime.languageId).toBe("python");
        expect(ready.runtime.transportProcessId).toBe(BRIDGE_PID);
        expect(ready.runtime.runtimeProcessId).toBe(KERNEL_PID);
        expect(ready.capabilities).toEqual([...capabilities]);

        const sent = bridge.sent();
        expect(sent.map((message) => message.type)).toEqual(["hello", "start-kernel"]);
        expect(sent.map((message) => message.sequence)).toEqual([0, 1]);
        expect(sent[1]?.payload).toEqual({ workingDirectory: "/project", kernelName: null });
      }),
    ),
  );

  it.effect("gives up on a bridge that never says hello", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge();
      // Silence, which is what a wedged interpreter looks like from here: the
      // process is up, the pipe is open, and nothing is ever going to arrive.
      // Only a deadline distinguishes that from a slow start.
      bridge.respond(() => []);
      const opening = yield* Effect.scoped(openChannel(bridge)).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const failure = yield* Fiber.join(opening);
      expect(failure.operation).toBe("handshake");
      expect(failure.message).toContain("Timed out waiting for hello-ack.");
      // A bridge that will not talk still has to be taken down, or every failed
      // start would leak an interpreter.
      expect(bridge.cancels()).toBeGreaterThan(0);
    }),
  );

  it.effect("refuses a bridge that cannot echo the owner token", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge();
      bridge.respond(healthyResponder(() => "not-the-token"));
      const failure = yield* Effect.flip(Effect.scoped(openChannel(bridge)));
      expect(failure.operation).toBe("handshake");
      expect(failure.message).toContain("Owner token");
    }),
  );

  it.effect("refuses a kernel speaking another language", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge();
      const healthy = healthyResponder(
        (command) => (command.payload as { ownerToken: string }).ownerToken,
      );
      bridge.respond((command) =>
        command.type === "start-kernel"
          ? [
              {
                type: "kernel-ready",
                payload: {
                  kernelPid: KERNEL_PID,
                  languageId: "r",
                  languageVersion: "4.3.0",
                  protocolVersion: COMPUTE_PROTOCOL_VERSION,
                  capabilities: [...capabilities],
                },
              },
            ]
          : healthy(command),
      );
      const failure = yield* Effect.flip(Effect.scoped(openChannel(bridge)));
      expect(failure.message).toContain("received 'r'");
    }),
  );

  it.effect("refuses a kernel missing a required capability", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge();
      const healthy = healthyResponder(
        (command) => (command.payload as { ownerToken: string }).ownerToken,
      );
      bridge.respond((command) =>
        command.type === "start-kernel"
          ? [
              {
                type: "kernel-ready",
                payload: {
                  kernelPid: KERNEL_PID,
                  languageId: "python",
                  languageVersion: "3.12.0",
                  protocolVersion: COMPUTE_PROTOCOL_VERSION,
                  capabilities: ["execute"],
                },
              },
            ]
          : healthy(command),
      );
      const failure = yield* Effect.flip(Effect.scoped(openChannel(bridge)));
      expect(failure.message).toContain("capabilities are incomplete");
    }),
  );
});

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

describe("jupyter bridge output mapping", () => {
  it.effect("maps a stream message to ordered output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, channel, reader } = yield* harness();
        yield* reader.next;
        yield* channel.execute({
          requestId: request("run-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "print('hi')",
        });
        yield* bridge.say({
          type: "stream",
          payload: { stream: "stdout", text: "hi\n" },
          requestId: "run-1",
        });
        yield* bridge.say({
          type: "execution-complete",
          payload: { outcome: "succeeded" },
          requestId: "run-1",
        });

        const seen = yield* reader.until("completed");
        expect(seen.map((event) => event._tag)).toEqual(["accepted", "output", "completed"]);
        const output = seen[1];
        if (output?._tag !== "output" || output.output._tag !== "stream") {
          throw new Error("Expected a stream output.");
        }
        expect(output.output.text).toBe("hi\n");
        expect(output.output.stream).toBe("stdout");
      }),
    ),
  );

  it.effect("reduces a text/plain representation to stream text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.say({
          type: "display",
          payload: { mediaType: "text/plain", text: "42" },
          requestId: null,
        });
        const event = yield* reader.next;
        if (event._tag !== "output" || event.output._tag !== "stream") {
          throw new Error("Expected a stream output.");
        }
        expect(event.output.text).toBe("42");
        expect(event.requestId).toBeNull();
      }),
    ),
  );

  it.effect("hashes and measures a PNG, and carries its bytes once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        const bytes = pngBytes(120, 90);
        yield* bridge.say({
          type: "display",
          payload: { mediaType: "image/png", data: Buffer.from(bytes).toString("base64") },
          requestId: null,
        });
        const event = yield* reader.next;
        if (event._tag !== "output" || event.output._tag !== "image") {
          throw new Error("Expected an image output.");
        }
        expect(event.output.width).toBe(120);
        expect(event.output.height).toBe(90);
        expect(event.output.byteLength).toBe(bytes.byteLength);
        expect(event.output.contentHash.startsWith("sha256:")).toBe(true);
        expect(event.image?.bytes.byteLength).toBe(bytes.byteLength);
      }),
    ),
  );

  it.effect("drops an image it cannot trust and keeps the session running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        // The first is what a `_repr_png_` returning prose looks like on the
        // wire; the second is what a JPEG mislabelled `image/png` looks like.
        // Both are frames the protocol accepts carrying contents we will not
        // render, and neither is worth a user's whole namespace.
        for (const data of ["not base64!!", Buffer.from("plainly not a png").toString("base64")]) {
          yield* bridge.say({
            type: "display",
            payload: { mediaType: "image/png", data },
            requestId: null,
          });
          const dropped = yield* reader.next;
          if (dropped._tag !== "output" || dropped.output._tag !== "system") {
            throw new Error("Expected a system output.");
          }
          expect(dropped.output.event).toBe("output-truncated");
          expect(dropped.output.detail).toContain("An image output was dropped");
          expect(dropped.image).toBeNull();
        }
        // Same session, same channel, and still able to carry the next figure.
        const bytes = pngBytes(4, 4);
        yield* bridge.say({
          type: "display",
          payload: { mediaType: "image/png", data: Buffer.from(bytes).toString("base64") },
          requestId: null,
        });
        const event = yield* reader.next;
        if (event._tag !== "output" || event.output._tag !== "image") {
          throw new Error("Expected an image output.");
        }
        expect(event.image?.bytes.byteLength).toBe(bytes.byteLength);
      }),
    ),
  );

  it.effect("carries a runtime error at the point in the stream where it happened", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.say({
          type: "error",
          payload: { name: "ZeroDivisionError", value: "division by zero", traceback: ["line"] },
          requestId: "run-1",
        });
        const event = yield* reader.next;
        if (event._tag !== "runtime-error") throw new Error("Expected a runtime error.");
        expect(event.report.name).toBe("ZeroDivisionError");
        // The sequence is the bridge's, not the transport's: it is what puts the
        // diagnostic a language adapter derives from this back in order. The
        // bridge has already spoken hello-ack and kernel-ready.
        expect(event.sequence).toBe(2);
        expect(Number.isNaN(Date.parse(event.observedAt))).toBe(false);
      }),
    ),
  );

  it.effect("names a warning as a system output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.say({
          type: "warning",
          payload: { code: "input-unsupported", detail: "stdin is not available" },
          requestId: "run-1",
        });
        const event = yield* reader.next;
        if (event._tag !== "output" || event.output._tag !== "system") {
          throw new Error("Expected a system output.");
        }
        expect(event.output.event).toBe("input-unsupported");
        expect(event.output.detail).toBe("stdin is not available");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe("jupyter bridge commands", () => {
  it.effect("refuses concurrent executions before they reach the bridge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, channel, reader } = yield* harness();
        yield* reader.next;
        yield* channel.execute({
          requestId: request("run-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "pass",
        });
        const failure = yield* Effect.flip(
          channel.execute({
            requestId: request("run-2"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "pass",
          }),
        );
        expect(failure.message).toContain("already active");
        expect(bridge.sent().filter((message) => message.type === "execute")).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses multi-byte code above the byte limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, channel, reader } = yield* harness();
        yield* reader.next;
        const failure = yield* Effect.flip(
          channel.execute({
            requestId: request("run-1"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "é".repeat(600_000),
          }),
        );
        expect(failure.message).toContain("byte limit");
        expect(bridge.sent().filter((message) => message.type === "execute")).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses a command from a generation the session has left", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, channel, reader } = yield* harness();
        yield* reader.next;
        const stale = nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION);
        const failure = yield* Effect.flip(
          channel.execute({ requestId: request("run-1"), expectedGeneration: stale, code: "pass" }),
        );
        expect(failure.operation).toBe("execute");
        expect(failure.message).toContain("expected generation");
        expect(bridge.sent()).toHaveLength(2);
      }),
    ),
  );

  it.effect("reports every interrupt outcome as an answer", () =>
    Effect.forEach(["interrupted", "terminal", "rejected", "timeout"] as const, (result) =>
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* makeFakeBridge();
          const healthy = healthyResponder(
            (command) => (command.payload as { ownerToken: string }).ownerToken,
          );
          bridge.respond((command) =>
            command.type === "interrupt"
              ? [
                  {
                    type: "interrupt-result",
                    payload: { result },
                    requestId: command.requestId,
                  },
                ]
              : healthy(command),
          );
          const channel = yield* openChannel(bridge);
          const outcome = yield* channel.interrupt({
            requestId: request("run-1"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          expect(outcome).toBe(result);
        }),
      ),
    ),
  );

  it.effect("advances the generation from the envelope on restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { channel, reader } = yield* harness();
        yield* reader.next;
        const next = nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION);
        yield* channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration: next,
        });
        const event = yield* reader.next;
        if (event._tag !== "restarted") throw new Error("Expected a restart.");
        expect(event.generation).toBe(next);
        expect(event.runtime.runtimeProcessId).toBe(KERNEL_PID + 1);

        // The session is now at the new generation, so the old one is refused
        // and the new one is accepted.
        const failure = yield* Effect.flip(
          channel.execute({
            requestId: request("run-1"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "pass",
          }),
        );
        expect(failure.message).toContain("generation");
        yield* channel.execute({
          requestId: request("run-2"),
          expectedGeneration: next,
          code: "pass",
        });
      }),
    ),
  );

  it.effect("refuses execution while a restart is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const healthy = healthyResponder(
          (command) => (command.payload as { ownerToken: string }).ownerToken,
        );
        bridge.respond((command) => (command.type === "restart" ? [] : healthy(command)));
        const channel = yield* openChannel(bridge);
        const reader = yield* makeReader(channel);
        yield* reader.next;
        const next = nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION);
        const restarting = yield* channel
          .restart({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            nextGeneration: next,
          })
          .pipe(Effect.forkChild);
        while (!bridge.sent().some((message) => message.type === "restart")) {
          yield* Effect.yieldNow;
        }

        const failure = yield* Effect.flip(
          channel.execute({
            requestId: request("run-1"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "pass",
          }),
        );
        expect(failure.message).toContain("changing generation");
        expect(bridge.sent().filter((message) => message.type === "execute")).toHaveLength(0);

        yield* bridge.say({
          type: "restarted",
          payload: { kernelPid: KERNEL_PID + 1 },
          generation: next,
        });
        yield* Fiber.join(restarting);
      }),
    ),
  );

  it.effect("treats an unsolicited restart acknowledgement as protocol loss", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.say({
          type: "restarted",
          payload: { kernelPid: KERNEL_PID + 1 },
          generation: nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION),
        });
        const event = yield* reader.next;
        expect(event._tag).toBe("lost");
        if (event._tag === "lost") expect(event.reason).toContain("unsolicited restarted");
      }),
    ),
  );

  it.effect("refuses a restart that does not advance exactly one generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { channel, reader } = yield* harness();
        yield* reader.next;
        const failure = yield* Effect.flip(
          channel.restart({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            nextGeneration: nextComputeSessionGeneration(
              nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION),
            ),
          }),
        );
        expect(failure.message).toContain("exactly one session generation");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Loss and shutdown
// ---------------------------------------------------------------------------

describe("jupyter bridge loss", () => {
  it.effect("reports a fatal message as the reason the session was lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.say({ type: "fatal", payload: { reason: "The kernel process exited." } });
        const event = yield* reader.next;
        if (event._tag !== "lost") throw new Error("Expected loss.");
        expect(event.reason).toContain("The kernel process exited.");
      }),
    ),
  );

  it.effect("keeps the bridge's own diagnostics in the reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.writeStderr("Traceback: ipykernel is not installed\n");
        // The stderr pump is a separate fibre; let it land before the loss.
        yield* Effect.yieldNow;
        yield* bridge.endStdout;
        const event = yield* reader.next;
        if (event._tag !== "lost") throw new Error("Expected loss.");
        expect(event.reason).toContain("closed unexpectedly");
        expect(event.reason).toContain("ipykernel is not installed");
      }),
    ),
  );

  it.effect("reports an unexpected exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bridge, reader } = yield* harness();
        yield* reader.next;
        yield* bridge.exitWith(9);
        const event = yield* reader.next;
        if (event._tag !== "lost") throw new Error("Expected loss.");
        expect(event.reason).toContain("code 9");
      }),
    ),
  );

  it.effect("fails a command in flight when the session is lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const healthy = healthyResponder(
          (command) => (command.payload as { ownerToken: string }).ownerToken,
        );
        bridge.respond((command) => (command.type === "interrupt" ? [] : healthy(command)));
        const channel = yield* openChannel(bridge);
        const interrupting = yield* Effect.forkChild(
          channel.interrupt({
            requestId: request("run-1"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        );
        yield* Effect.yieldNow;
        yield* bridge.exitWith(1);
        const failure = yield* Effect.flip(Fiber.join(interrupting));
        expect(failure.operation).toBe("receive");
      }),
    ),
  );

  it.effect("says nothing about loss for a shutdown it asked for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const healthy = healthyResponder(
          (command) => (command.payload as { ownerToken: string }).ownerToken,
        );
        // A real bridge answers and then goes away, which is exactly the shape
        // that would otherwise be read as a runtime that vanished.
        bridge.respond((command) =>
          command.type === "shutdown"
            ? [{ type: "shutdown-complete", payload: {} }]
            : healthy(command),
        );
        const channel = yield* openChannel(bridge);
        const collected = yield* Effect.forkChild(Stream.runCollect(channel.events));
        yield* channel.shutdown({ expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION });
        yield* bridge.endStdout;
        yield* bridge.exitWith(0);
        const events = yield* Fiber.join(collected);
        expect([...events].map((event) => event._tag)).toEqual(["ready"]);
        expect(bridge.cancels()).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("reports loss when a shutdown it asked for does not complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const healthy = healthyResponder(
          (command) => (command.payload as { ownerToken: string }).ownerToken,
        );
        // Answering a goodbye with a fatal is the bridge saying it cannot leave
        // cleanly.  The shutdown must not sit out its timeout waiting for a
        // reply that is never coming, and the session must not be left looking
        // alive to whoever is reading its events.
        bridge.respond((command) =>
          command.type === "shutdown"
            ? [{ type: "fatal", payload: { reason: "The kernel would not stop." } }]
            : healthy(command),
        );
        const channel = yield* openChannel(bridge);
        const reader = yield* makeReader(channel);
        yield* reader.next;
        const failure = yield* Effect.flip(
          channel.shutdown({ expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION }),
        );
        expect(failure.message).toContain("would not stop");
        const event = yield* reader.next;
        if (event._tag !== "lost") throw new Error("Expected loss.");
        expect(event.reason).toContain("would not stop");
      }),
    ),
  );

  it.effect("asks the bridge to leave when its scope closes", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* openChannel(bridge);
          const reader = yield* makeReader(channel);
          yield* reader.next;
        }),
      );
      expect(bridge.sent().map((message) => message.type)).toEqual([
        "hello",
        "start-kernel",
        "shutdown",
      ]);
      expect(bridge.cancels()).toBeGreaterThan(0);
    }),
  );
});

// ---------------------------------------------------------------------------
// Back-pressure
// ---------------------------------------------------------------------------

describe("jupyter bridge back-pressure", () => {
  it.effect("drops output rather than lifecycle events, and says so once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        // A budget small enough that a single chunk of output cannot fit in it,
        // so the decision to drop does not depend on how the reader and the
        // protocol fibre happen to interleave.
        const channel = yield* openChannel(bridge, { maxEventQueueBytes: 1024 });
        yield* channel.execute({
          requestId: request("run-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "pass",
        });
        const tooBig = "x".repeat(2_000);
        for (const text of [tooBig, tooBig, tooBig]) {
          yield* bridge.say({
            type: "stream",
            payload: { stream: "stdout", text },
            requestId: "run-1",
          });
        }
        yield* bridge.say({
          type: "execution-complete",
          payload: { outcome: "succeeded" },
          requestId: "run-1",
        });

        const reader = yield* makeReader(channel);
        const seen = yield* reader.until("completed");
        const truncations = seen.filter(
          (event) =>
            event._tag === "output" &&
            event.output._tag === "system" &&
            event.output.event === "output-truncated",
        );
        // One marker for the episode, not one per dropped chunk: the point is to
        // tell the user output is missing, not to replace it with noise.
        expect(truncations).toHaveLength(1);
        expect(
          seen.filter((event) => event._tag === "output" && event.output._tag === "stream"),
        ).toHaveLength(0);
        // The lifecycle event still arrives. A consumer that missed it would
        // wait forever for an execution that already finished.
        expect(seen.at(-1)?._tag).toBe("completed");

        // Once the consumer has caught up, output flows again: the marker
        // describes an episode, not a permanent state.
        yield* bridge.say({
          type: "stream",
          payload: { stream: "stdout", text: "back" },
          requestId: "run-1",
        });
        const resumed = yield* reader.next;
        if (resumed._tag !== "output" || resumed.output._tag !== "stream") {
          throw new Error("Expected output to resume.");
        }
        expect(resumed.output.text).toBe("back");
      }),
    ),
  );

  it.effect("keeps every lifecycle event under a budget nothing fits in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeFakeBridge();
        const channel = yield* openChannel(bridge, { maxEventQueueBytes: 1 });
        yield* channel.execute({
          requestId: request("run-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "pass",
        });
        yield* bridge.say({
          type: "stream",
          payload: { stream: "stdout", text: "dropped" },
          requestId: "run-1",
        });
        yield* bridge.say({
          type: "execution-complete",
          payload: { outcome: "failed" },
          requestId: "run-1",
        });
        yield* bridge.say({ type: "fatal", payload: { reason: "gone" } });

        const reader = yield* makeReader(channel);
        const seen = yield* reader.until("lost");
        expect(seen.map((event) => event._tag)).toEqual([
          "ready",
          "accepted",
          "output",
          "completed",
          "lost",
        ]);
      }),
    ),
  );
});
