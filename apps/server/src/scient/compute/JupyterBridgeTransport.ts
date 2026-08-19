// @effect-diagnostics nodeBuiltinImport:off -- transport uses node:crypto for SHA-256 and owner tokens.
// @effect-diagnostics globalDate:off -- observedAt timestamps use ISO strings for durable records.
// @effect-diagnostics globalTimers:off -- command response timeouts use Effect.timeout on queue takes.
// @effect-diagnostics preferSchemaOverJson:off -- byte estimate uses field lengths, not JSON.stringify.
// @effect-diagnostics schemaSyncInEffect:off -- PNG signature check is a synchronous byte comparison.
// @effect-diagnostics tryCatchInEffectGen:off -- probe parsing and PNG decoding are synchronous byte ops.
// @effect-diagnostics missingEffectContext:off -- transport open requires DuplexProcess from caller context.
// @effect-diagnostics missingEffectError:off -- Effect.timeout introduces TimeoutError in the error channel.
// @effect-diagnostics unknownInRequirementsChannel:off -- pending queue take inherits context from caller.
// @effect-diagnostics unnecessaryFailYieldableError:off -- explicit Effect.fail aids readability.
// @effect-diagnostics unsafeEffectTypeAssertion:off -- DuplexProcess is provided by caller context.
import * as Crypto from "node:crypto";

import {
  ComputeCapability,
  ComputeRequestId,
  ComputeSessionGeneration,
  ComputeTransportError,
  ComputeLanguageId,
  type ComputeChannel,
  type ComputeExecutionOutcome,
  type ComputeOutput,
  type ComputeRuntimeIdentity,
  type ComputeTransport,
  type ComputeTransportEvent,
  type ComputeTransportImageEvent,
  type ComputeTransportOpenRequest,
  COMPUTE_PROTOCOL_VERSION,
  encodeComputeProtocolMessage,
  decodeComputeProtocolMessage,
  makeComputeFrameDecoder,
} from "@scientfactory/compute";
import { DuplexProcess } from "../execution/LocalDuplexProcess.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { decodeBridgeMessage, type BridgeMessage } from "./BridgeProtocol.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const MAX_EVENT_QUEUE_COUNT = 256;
const MAX_EVENT_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_PNG_DECODED_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

export interface JupyterBridgeTransportOptions {
  readonly bridgePath: string;
  readonly startupTimeoutMs?: number;
}

export class JupyterBridgeTransportService extends Context.Service<
  JupyterBridgeTransportService,
  JupyterBridgeTransportOptions
>()("t3/scient/compute/JupyterBridgeTransport/JupyterBridgeTransportService") {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transportError(
  operation: ComputeTransportError["operation"],
  message: string,
  cause?: unknown,
): ComputeTransportError {
  return new ComputeTransportError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function estimateEventBytes(event: ComputeTransportEvent): number {
  let total = 64;
  if (event._tag === "output") {
    total += estimateOutputBytes(event.output);
    if (event.image !== null) total += event.image.bytes.byteLength;
  } else if (event._tag === "lost") {
    total += event.reason.length;
  }
  return total;
}

function estimateOutputBytes(output: ComputeOutput): number {
  switch (output._tag) {
    case "stream":
      return output.text.length;
    case "diagnostic":
      return output.diagnostic.message.length + output.diagnostic.traceback.join("").length;
    case "image":
      return 256;
    case "system":
      return output.detail?.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// PNG header parser (dependency-free, bounded)
// ---------------------------------------------------------------------------

function readPngWidth(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16, false) || null;
}

function readPngHeight(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(20, false) || null;
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

export function makeJupyterBridgeTransport(
  options: JupyterBridgeTransportOptions,
): ComputeTransport {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return {
    open(request: ComputeTransportOpenRequest) {
      return Effect.gen(function* () {
        const processes = yield* DuplexProcess;
        const ownerToken = Crypto.randomBytes(32).toString("hex");

        // 1. Spawn the bridge process.
        const handle = yield* processes
          .start({
            processId: "bridge" as any,
            executable: request.launch.executable,
            args: [...request.launch.args],
            cwd: request.launch.cwd,
            environment: request.launch.environment,
            extendEnv: false,
          })
          .pipe(
            Effect.mapError((cause) =>
              transportError("open", "Failed to start the bridge process.", cause),
            ),
          );

        const decoder = makeComputeFrameDecoder();
        const events = yield* Queue.unbounded<ComputeTransportEvent, Cause.Done>();
        const eventBytes = MutableRef.make(0);
        const generation = MutableRef.make(request.generation);
        const closed = MutableRef.make(false);
        const lost = MutableRef.make(false);

        // Pending command response queue (one at a time).
        const pendingQueue = yield* Queue.bounded<BridgeMessage>(1);
        let pendingTypes: ReadonlySet<string> | null = null;

        const waitForResponse = (
          types: ReadonlySet<string>,
          timeoutMs: number,
        ): Effect.Effect<BridgeMessage, ComputeTransportError> =>
          Effect.suspend((): Effect.Effect<BridgeMessage, ComputeTransportError> => {
            pendingTypes = types;
            return Queue.take(pendingQueue).pipe(
              Effect.timeout(timeoutMs),
              Effect.mapError(() =>
                transportError("receive", `Timed out waiting for ${[...types].join("/")}.`),
              ),
              Effect.tap(
                Effect.sync(() => {
                  pendingTypes = null;
                }),
              ),
            );
          });

        // -- Event mapping ------------------------------------------------

        const emit = (event: ComputeTransportEvent): Effect.Effect<void, ComputeTransportError> =>
          Effect.suspend(() => {
            if (MutableRef.get(lost) || MutableRef.get(closed)) return Effect.void;
            const estimate = estimateEventBytes(event);
            if (MutableRef.get(eventBytes) + estimate > MAX_EVENT_QUEUE_BYTES) {
              return Effect.fail(transportError("receive", "Event queue byte budget exceeded."));
            }
            MutableRef.set(eventBytes, MutableRef.get(eventBytes) + estimate);
            return Queue.offer(events, event).pipe(Effect.asVoid);
          });

        const mapBridgeMessage = (msg: BridgeMessage): Effect.Effect<void, ComputeTransportError> =>
          Effect.suspend(() => {
            // Check if this is a pending command response.
            if (pendingTypes !== null && pendingTypes.has(msg.type)) {
              pendingTypes = null;
              return Queue.offer(pendingQueue, msg).pipe(Effect.asVoid);
            }

            switch (msg.type) {
              case "accepted":
                return emit({ _tag: "accepted", requestId: msg.requestId! });

              case "stream": {
                const p = msg.payload as { stream: string; text: string };
                return emit({
                  _tag: "output",
                  requestId: msg.requestId,
                  output: {
                    _tag: "stream",
                    sequence: msg.sequence,
                    observedAt: nowIso(),
                    stream: p.stream as "stdout" | "stderr",
                    text: p.text,
                  },
                  image: null,
                });
              }

              case "display": {
                const p = msg.payload as { mediaType: string; data?: string; text?: string };
                if (p.mediaType === "image/png" && p.data) {
                  const bytes = Buffer.from(p.data, "base64") as unknown as Uint8Array;
                  if (bytes.byteLength > MAX_PNG_DECODED_BYTES) {
                    return emit({
                      _tag: "output",
                      requestId: msg.requestId,
                      output: {
                        _tag: "system",
                        sequence: msg.sequence,
                        observedAt: nowIso(),
                        event: "output-truncated" as const,
                        detail: "PNG exceeded decoded byte limit.",
                      },
                      image: null,
                    });
                  }
                  if (bytes.byteLength >= 8 && bytes[0] === PNG_SIGNATURE[0]) {
                    const hash = Crypto.createHash("sha256").update(bytes).digest("hex");
                    return emit({
                      _tag: "output",
                      requestId: msg.requestId,
                      output: {
                        _tag: "image",
                        sequence: msg.sequence,
                        observedAt: nowIso(),
                        mediaType: "image/png",
                        contentHash: `sha256:${hash}`,
                        byteLength: bytes.byteLength,
                        width: readPngWidth(bytes),
                        height: readPngHeight(bytes),
                      },
                      image: { bytes: new Uint8Array(bytes) } as ComputeTransportImageEvent,
                    });
                  }
                  return emit({
                    _tag: "output",
                    requestId: msg.requestId,
                    output: {
                      _tag: "stream",
                      sequence: msg.sequence,
                      observedAt: nowIso(),
                      stream: "stdout",
                      text: "[invalid PNG data]",
                    },
                    image: null,
                  });
                }
                return emit({
                  _tag: "output",
                  requestId: msg.requestId,
                  output: {
                    _tag: "stream",
                    sequence: msg.sequence,
                    observedAt: nowIso(),
                    stream: "stdout",
                    text: p.text ?? "",
                  },
                  image: null,
                });
              }

              case "error": {
                const p = msg.payload as { name: string; value: string; traceback: string[] };
                return emit({
                  _tag: "output",
                  requestId: msg.requestId,
                  output: {
                    _tag: "diagnostic",
                    sequence: msg.sequence,
                    observedAt: nowIso(),
                    diagnostic: {
                      errorName: p.name.slice(0, 256),
                      message: p.value.slice(0, 4096),
                      traceback: p.traceback.map((t) => t.slice(0, 4096)).slice(0, 200),
                    },
                  },
                  image: null,
                });
              }

              case "warning": {
                const p = msg.payload as { code: string; detail: string | null };
                const systemEvents: Record<
                  string,
                  "output-truncated" | "input-unsupported" | "runtime-warning"
                > = {
                  "output-truncated": "output-truncated",
                  "input-unsupported": "input-unsupported",
                  "runtime-warning": "runtime-warning",
                };
                const event = systemEvents[p.code];
                if (!event) {
                  return Effect.fail(transportError("receive", `Unknown warning code: ${p.code}`));
                }
                return emit({
                  _tag: "output",
                  requestId: msg.requestId,
                  output: {
                    _tag: "system",
                    sequence: msg.sequence,
                    observedAt: nowIso(),
                    event,
                    detail: p.detail,
                  },
                  image: null,
                });
              }

              case "execution-complete": {
                const p = msg.payload as { outcome: ComputeExecutionOutcome };
                return emit({
                  _tag: "completed",
                  requestId: msg.requestId!,
                  outcome: p.outcome,
                });
              }

              case "restarted": {
                const p = msg.payload as { kernelPid: number; generation: number };
                MutableRef.set(generation, ComputeSessionGeneration.make(p.generation));
                return emit({
                  _tag: "restarted",
                  generation: ComputeSessionGeneration.make(p.generation),
                });
              }

              case "fatal": {
                const p = msg.payload as { reason: string };
                MutableRef.set(lost, true);
                return emit({ _tag: "lost", reason: p.reason }).pipe(
                  Effect.andThen(Queue.end(events)),
                  Effect.asVoid,
                );
              }

              default:
                return Effect.void;
            }
          });

        // -- Stdout reader ------------------------------------------------

        yield* Stream.runForEach(handle.stdout, (chunk: Uint8Array) =>
          Effect.gen(function* () {
            const frames = yield* decoder.push(chunk);
            for (const frame of frames) {
              const message = yield* decodeComputeProtocolMessage(frame).pipe(
                Effect.mapError((cause) =>
                  transportError("receive", "Protocol decode error.", cause),
                ),
              );
              const bridgeMsg = yield* decodeBridgeMessage(message, "bridge-to-server").pipe(
                Effect.mapError((cause) =>
                  transportError("receive", "Bridge protocol error.", cause),
                ),
              );
              yield* mapBridgeMessage(bridgeMsg);
            }
          }),
        ).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (!MutableRef.get(lost) && !MutableRef.get(closed)) {
                  MutableRef.set(lost, true);
                  yield* emit({ _tag: "lost", reason: error.message }).pipe(
                    Effect.andThen(Queue.end(events)),
                    Effect.asVoid,
                  );
                }
              }),
            onSuccess: () => Effect.void,
          }),
          Effect.forkScoped,
        );

        // -- Stderr drain -------------------------------------------------

        const stderrTail = MutableRef.make("");
        yield* Stream.runForEach(handle.stderr, (chunk: Uint8Array) =>
          Effect.sync(() => {
            const text = new TextDecoder().decode(chunk);
            let tail = MutableRef.get(stderrTail) + text;
            if (tail.length > MAX_STDERR_TAIL_BYTES) {
              tail = tail.slice(tail.length - MAX_STDERR_TAIL_BYTES);
            }
            MutableRef.set(stderrTail, tail);
          }),
        ).pipe(Effect.forkScoped);

        // -- Command sending ----------------------------------------------

        const sendCommand = (
          type: string,
          payload: unknown,
          requestId: ComputeRequestId | null = null,
        ): Effect.Effect<void, ComputeTransportError> =>
          Effect.gen(function* () {
            const message = {
              protocolVersion: COMPUTE_PROTOCOL_VERSION,
              type,
              sessionId: request.sessionId,
              generation: MutableRef.get(generation),
              requestId,
              sequence: 0,
              payload,
            };
            const frame = yield* encodeComputeProtocolMessage(message).pipe(
              Effect.mapError((cause) =>
                transportError("execute", "Failed to encode command.", cause),
              ),
            );
            yield* handle
              .write(frame)
              .pipe(
                Effect.mapError((cause) =>
                  transportError("execute", "Failed to send command to bridge.", cause),
                ),
              );
          });

        // -- Handshake ----------------------------------------------------

        const handshake = Effect.gen(function* () {
          yield* sendCommand("hello", {
            buildId: "scient-server",
            frameLimit: 16 * 1024 * 1024,
            requiredCapabilities: [...request.requiredCapabilities],
            ownerToken,
          });

          const ack = yield* waitForResponse(new Set(["hello-ack"]), startupTimeoutMs);
          const ackPayload = ack.payload as { pid: number; ownerToken: string };
          if (ackPayload.ownerToken !== ownerToken) {
            return yield* Effect.fail(
              transportError("handshake", "Owner token mismatch in hello-ack."),
            );
          }

          yield* sendCommand("start-kernel", { workingDirectory: request.launch.cwd });

          const ready = yield* waitForResponse(new Set(["kernel-ready"]), startupTimeoutMs);
          const readyPayload = ready.payload as {
            kernelPid: number;
            languageId: string;
            languageVersion: string;
            protocolVersion: number;
            capabilities: string[];
          };

          const identity: ComputeRuntimeIdentity = {
            languageId: ComputeLanguageId.make(readyPayload.languageId),
            transportKind: request.transportKind,
            protocolVersion: readyPayload.protocolVersion,
            languageVersion: readyPayload.languageVersion,
            platform: process.platform,
            transportProcessId: ackPayload.pid,
            runtimeProcessId: readyPayload.kernelPid,
          };
          yield* emit({
            _tag: "ready",
            runtime: identity,
            capabilities: readyPayload.capabilities as ComputeCapability[],
          });
        }).pipe(
          Effect.timeout(startupTimeoutMs),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* handle.cancelProcessTree.pipe(Effect.ignore);
                const isTransportError = Schema.is(ComputeTransportError);
                return yield* Effect.fail(
                  isTransportError(error)
                    ? error
                    : transportError("handshake", "Startup timed out."),
                );
              }),
            onSuccess: () => Effect.void,
          }),
        );

        yield* handshake;

        // -- Channel methods ----------------------------------------------

        const execute: ComputeChannel["execute"] = (executeRequest) =>
          Effect.gen(function* () {
            if (MutableRef.get(closed) || MutableRef.get(lost)) {
              return yield* Effect.fail(
                transportError("execute", "The runtime is no longer reachable."),
              );
            }
            if (executeRequest.expectedGeneration !== MutableRef.get(generation)) {
              return yield* Effect.fail(
                transportError(
                  "execute",
                  `The command expected generation ${executeRequest.expectedGeneration}, but the session is at generation ${MutableRef.get(generation)}.`,
                ),
              );
            }
            yield* sendCommand(
              "execute",
              {
                code: executeRequest.code,
                silent: true,
                storeHistory: true,
              },
              executeRequest.requestId,
            );
            yield* waitForResponse(new Set(["accepted"]), DEFAULT_INTERRUPT_TIMEOUT_MS);
          });

        const interrupt: ComputeChannel["interrupt"] = (interruptRequest) =>
          Effect.gen(function* () {
            if (MutableRef.get(closed) || MutableRef.get(lost)) {
              return yield* Effect.fail(
                transportError("interrupt", "The runtime is no longer reachable."),
              );
            }
            yield* sendCommand("interrupt", {}, interruptRequest.requestId);
            const result = yield* waitForResponse(
              new Set(["interrupt-result"]),
              DEFAULT_INTERRUPT_TIMEOUT_MS,
            );
            const r = result.payload as { result: string };
            if (r.result === "rejected" || r.result === "timeout") {
              return yield* Effect.fail(transportError("interrupt", `Interrupt ${r.result}.`));
            }
          });

        const restart: ComputeChannel["restart"] = (restartRequest) =>
          Effect.gen(function* () {
            if (MutableRef.get(closed) || MutableRef.get(lost)) {
              return yield* Effect.fail(
                transportError("restart", "The runtime is no longer reachable."),
              );
            }
            yield* sendCommand("restart", { nextGeneration: restartRequest.nextGeneration });
            yield* waitForResponse(new Set(["restarted"]), DEFAULT_STARTUP_TIMEOUT_MS);
          });

        const shutdown: ComputeChannel["shutdown"] = () =>
          Effect.gen(function* () {
            if (MutableRef.get(closed)) return;
            MutableRef.set(closed, true);
            yield* sendCommand("shutdown", {});
            yield* waitForResponse(
              new Set(["shutdown-complete"]),
              DEFAULT_SHUTDOWN_TIMEOUT_MS,
            ).pipe(Effect.ignore);
            yield* Queue.end(events);
          });

        // -- Finalization -------------------------------------------------

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!MutableRef.get(closed) && !MutableRef.get(lost)) {
              MutableRef.set(closed, true);
              yield* sendCommand("shutdown", {}).pipe(Effect.ignore);
              yield* waitForResponse(new Set(["shutdown-complete"]), 5000).pipe(Effect.ignore);
              yield* Queue.end(events).pipe(Effect.ignore);
            }
            yield* handle.cancelProcessTree.pipe(Effect.ignore);
          }),
        );

        return {
          events: Stream.fromQueue(events),
          execute,
          interrupt,
          restart,
          shutdown,
        } satisfies ComputeChannel;
      }) as Effect.Effect<ComputeChannel, ComputeTransportError, Scope.Scope>;
    },
  };
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  JupyterBridgeTransportService,
  Effect.gen(function* () {
    const bridgePath = new URL("bridge/scient_compute_bridge.py", import.meta.url).pathname;
    return JupyterBridgeTransportService.of({ bridgePath });
  }),
);
