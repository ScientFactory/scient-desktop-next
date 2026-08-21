// @effect-diagnostics nodeBuiltinImport:off -- transport hashes validated PNG bytes and owner tokens.
import * as NodeCrypto from "node:crypto";

import {
  COMPUTE_PROTOCOL_VERSION,
  ComputeLanguageId,
  ComputeSessionGeneration,
  ComputeTransportError,
  ComputeTransportKind,
  encodeComputeProtocolMessage,
  decodeComputeProtocolMessage,
  makeComputeFrameDecoder,
  nextComputeSessionGeneration,
  requireSupportedProtocolVersion,
  type ComputeCapability,
  type ComputeChannel,
  type ComputeInterruptOutcome,
  type ComputeOutput,
  type ComputeRequestId,
  type ComputeRuntimeIdentity,
  type ComputeTransport,
  type ComputeTransportEvent,
  type ComputeTransportOpenRequest,
  type ComputeVariableSnapshot,
} from "@scientfactory/compute";
import { DuplexProcessId, type DuplexProcessPort } from "@scientfactory/execution";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  decodeBridgeMessage,
  makeBridgeSequenceTracker,
  validateBridgeSequence,
  type BridgeMessage,
} from "./BridgeProtocol.ts";
import { inspectComputeStaticImage } from "./ComputeStaticImage.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_VARIABLES_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_FINALIZER_SHUTDOWN_MS = 5_000;
const DEFAULT_MAX_EVENT_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_LOST_REASON_LENGTH = 4096;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_PNG_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_SVG_DECODED_BYTES = 8 * 1024 * 1024;

/**
 * The transport does not need to know where the bridge script lives.
 *
 * A language adapter's `prepareLaunch` already produces the executable and
 * arguments that start a runtime, and that is the only place a bridge path
 * belongs: a transport that also resolved one could disagree with the plan it
 * was handed.
 */
export interface JupyterBridgeTransportOptions {
  readonly startupTimeoutMs?: number;
  /**
   * How many bytes of undelivered events one session may hold.
   *
   * This is the memory a consumer that stops reading can cost. Past it, output
   * is dropped and said to have been dropped; lifecycle events are always
   * delivered, so the real ceiling is this plus whatever is in flight. An
   * embedder running many sessions at once may want a smaller number than one
   * running a single interactive session.
   */
  readonly maxEventQueueBytes?: number;
}

interface WeightedEvent {
  readonly event: ComputeTransportEvent;
  readonly byteLength: number;
}

interface PendingResponse {
  readonly type: BridgeMessage["type"];
  readonly requestId: ComputeRequestId | null;
  readonly generation: ComputeSessionGeneration;
  readonly deferred: Deferred.Deferred<BridgeMessage, ComputeTransportError>;
}

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

function estimateTextBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function estimateOutputBytes(output: ComputeOutput): number {
  switch (output._tag) {
    case "stream":
      return estimateTextBytes(output.text);
    case "diagnostic":
      return (
        estimateTextBytes(output.diagnostic.errorName) +
        estimateTextBytes(output.diagnostic.message) +
        output.diagnostic.traceback.reduce((total, line) => total + estimateTextBytes(line), 0)
      );
    case "image":
      return 256;
    case "system":
      return output.detail === null ? 64 : 64 + estimateTextBytes(output.detail);
  }
}

function estimateEventBytes(event: ComputeTransportEvent): number {
  switch (event._tag) {
    case "output":
      return estimateOutputBytes(event.output) + (event.image?.bytes.byteLength ?? 0) + 64;
    case "runtime-error":
      return (
        estimateTextBytes(event.report.name) +
        estimateTextBytes(event.report.value) +
        event.report.traceback.reduce((total, line) => total + estimateTextBytes(line), 0) +
        64
      );
    case "lost":
      return estimateTextBytes(event.reason) + 64;
    default:
      return 256;
  }
}

/**
 * The bytes behind a base64 PNG payload, or a sentence saying why there are none.
 *
 * All three rejections are the same kind of thing -- an image that cannot be
 * shown -- so they come back the same way, and none of them ends the session.
 * What arrives here is whatever the user's code put in an `image/png` bundle: a
 * `_repr_png_` that returns a string of prose, a backend that emits a JPEG
 * under a PNG key, a figure too large to keep. Losing the session over any of
 * those would cost the user every variable they had built up in it, which is
 * the one thing a session exists to hold. A frame that breaks the protocol is
 * still fatal; this is a well-formed frame carrying contents we will not trust.
 */
function decodePngPayload(data: string): Uint8Array | string {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return "An image output was dropped: its data was not readable base64.";
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_PNG_DECODED_BYTES) {
    return "An image output was dropped: it exceeded the decoded byte limit.";
  }
  if (inspectComputeStaticImage("image/png", bytes) === null) {
    return "An image output was dropped: its data was not a PNG.";
  }
  return bytes;
}

function decodeSvgPayload(data: string): Uint8Array | string {
  const bytes = new TextEncoder().encode(data);
  if (bytes.byteLength > MAX_SVG_DECODED_BYTES) {
    return "An image output was dropped: it exceeded the decoded byte limit.";
  }
  if (inspectComputeStaticImage("image/svg+xml", bytes) === null) {
    return "An image output was dropped: its data was not an SVG.";
  }
  return bytes;
}

function hasCapabilities(
  offered: ReadonlyArray<ComputeCapability>,
  required: ReadonlyArray<ComputeCapability>,
): boolean {
  const available = new Set(offered);
  return required.every((capability) => available.has(capability));
}

function pendingKey(
  type: BridgeMessage["type"],
  requestId: ComputeRequestId | null,
  generation: ComputeSessionGeneration,
): string {
  return `${type}:${requestId ?? ""}:${generation}`;
}

export function makeJupyterBridgeTransport(
  processes: DuplexProcessPort,
  options: JupyterBridgeTransportOptions,
): ComputeTransport {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const maxEventQueueBytes = options.maxEventQueueBytes ?? DEFAULT_MAX_EVENT_QUEUE_BYTES;
  /**
   * Where dropping output stops, as opposed to where it starts.
   *
   * A single threshold would flap: one dequeued event would let one more output
   * through, drop the next, and turn a burst into an alternating stream of
   * output and truncation markers.
   */
  const resumeEventQueueBytes = Math.floor(maxEventQueueBytes / 2);

  return {
    open(request: ComputeTransportOpenRequest) {
      return Effect.gen(function* () {
        const ownerToken = NodeCrypto.randomBytes(32).toString("hex");
        const handle = yield* processes
          .start({
            processId: DuplexProcessId.make(request.sessionId),
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
        const inboundSequence = makeBridgeSequenceTracker("bridge-to-server");
        const outboundSequence = MutableRef.make(0);
        const generation = MutableRef.make(request.generation);
        const runtimeIdentity = MutableRef.make<ComputeRuntimeIdentity | null>(null);
        const closed = MutableRef.make(false);
        const lost = MutableRef.make(false);
        const transitioning = MutableRef.make(false);
        const activeRequestId = MutableRef.make<ComputeRequestId | null>(null);
        const inspectingVariables = MutableRef.make(false);
        /**
         * A shutdown this transport asked for, as opposed to one it suffered.
         *
         * Between sending `shutdown` and receiving `shutdown-complete` the
         * bridge legitimately stops: it cancels in-flight work, closes its
         * stdout and exits. Without this flag every one of those looks like a
         * runtime that vanished, and the session would report itself lost at the
         * exact moment it was closing cleanly.
         */
        const stopping = MutableRef.make(false);
        const eventBytes = MutableRef.make(0);
        const droppingOutput = MutableRef.make(false);
        const stderrTail = MutableRef.make("");
        const pending = new Map<string, PendingResponse>();
        const commandGate = yield* Semaphore.make(1);
        const writeGate = yield* Semaphore.make(1);
        /**
         * Unbounded on purpose.
         *
         * A bounded queue makes `emit` suspend once a chatty cell fills it, and
         * `emit` runs on the single fibre that also resolves command replies --
         * so a full queue would mean `interrupt-result` could never be delivered
         * and a runaway cell could never be stopped, which is precisely when
         * interrupt matters. Memory is bounded by the byte budget below instead,
         * which drops droppable output rather than blocking the reader.
         */
        const events = yield* Queue.unbounded<WeightedEvent, ComputeTransportError | Cause.Done>();

        const failPending = (error: ComputeTransportError) =>
          Effect.forEach(pending.values(), (entry) => Deferred.fail(entry.deferred, error), {
            discard: true,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pending.clear();
              }),
            ),
          );

        const offer = (event: ComputeTransportEvent) => {
          const byteLength = estimateEventBytes(event);
          MutableRef.set(eventBytes, MutableRef.get(eventBytes) + byteLength);
          return Queue.offer(events, { event, byteLength }).pipe(Effect.asVoid);
        };

        /**
         * Queue one event, dropping only what can be dropped.
         *
         * When a consumer falls far enough behind to threaten the byte budget,
         * the honest thing to shed is output: a truncation marker in the stream
         * tells the user exactly what happened. Runtime diagnostics are output
         * too: an adversarial traceback must not bypass the same memory bound.
         * Everything else -- `ready`, `accepted`, `completed`, `restarted`,
         * `lost` -- is a lifecycle fact, and a consumer that misses one waits forever for
         * something that already happened. So those are always queued, and the
         * budget is a target rather than a hard ceiling for them.
         */
        const emit = (event: ComputeTransportEvent): Effect.Effect<void, ComputeTransportError> =>
          Effect.suspend(() => {
            if (MutableRef.get(closed) || MutableRef.get(lost)) return Effect.void;
            if (event._tag !== "output" && event._tag !== "runtime-error") return offer(event);
            const overBudget =
              MutableRef.get(eventBytes) + estimateEventBytes(event) > maxEventQueueBytes;
            if (!overBudget && !MutableRef.get(droppingOutput)) return offer(event);
            // One marker per episode: repeating it for every dropped chunk would
            // replace the output the user lost with noise about losing it.
            if (MutableRef.get(droppingOutput)) return Effect.void;
            MutableRef.set(droppingOutput, true);
            const sequence = event._tag === "output" ? event.output.sequence : event.sequence;
            const observedAt = event._tag === "output" ? event.output.observedAt : event.observedAt;
            return offer({
              _tag: "output",
              requestId: event.requestId,
              generation: event.generation,
              output: {
                _tag: "system",
                sequence,
                observedAt,
                event: "output-truncated",
                detail: "Output was dropped because the consumer fell behind.",
              },
              image: null,
            });
          });

        /**
         * Builds the reason a session was lost, with the bridge's own words.
         *
         * The transport only ever sees the shape of a failure -- a closed pipe,
         * an exit code -- while the explanation is on the bridge's stderr. This
         * is the last moment either is still available, so they are reported
         * together, and the tail is trimmed rather than the message so the
         * newest diagnostics survive.
         */
        const lostReason = (error: ComputeTransportError): string => {
          const tail = MutableRef.get(stderrTail).trim();
          if (tail === "") return error.message.slice(0, MAX_LOST_REASON_LENGTH);
          const budget = MAX_LOST_REASON_LENGTH - error.message.length - 1;
          if (budget <= 0) return error.message.slice(0, MAX_LOST_REASON_LENGTH);
          return `${error.message}\n${tail.slice(Math.max(0, tail.length - budget))}`;
        };

        const lose = (error: ComputeTransportError) =>
          Effect.suspend(() => {
            if (MutableRef.get(lost) || MutableRef.get(closed)) return Effect.void;
            if (MutableRef.get(stopping)) {
              // A shutdown this transport asked for is in flight, so this is
              // probably just the bridge leaving as instructed and no `lost`
              // event is owed. A command still waiting for a reply is failed
              // anyway: that is what lets the shutdown stop waiting and decide,
              // instead of sitting out its whole timeout for a bridge that has
              // already stopped answering.
              return failPending(error).pipe(Effect.ignore);
            }
            MutableRef.set(lost, true);
            const lostEvent: ComputeTransportEvent = { _tag: "lost", reason: lostReason(error) };
            const byteLength = estimateEventBytes(lostEvent);
            return failPending(error).pipe(
              Effect.andThen(Queue.offer(events, { event: lostEvent, byteLength })),
              Effect.andThen(Queue.fail(events, error)),
              Effect.andThen(handle.cancelProcessTree.pipe(Effect.ignore)),
              Effect.asVoid,
            );
          });

        /**
         * Every failure names the command that was in flight, not the machinery
         * that noticed. A caller deciding whether to retry, restart or give up
         * reads `operation`, and "receive" would tell it only that some reply
         * never came.
         */
        const registerResponse = (
          operation: ComputeTransportError["operation"],
          type: BridgeMessage["type"],
          requestId: ComputeRequestId | null,
          expectedGeneration: ComputeSessionGeneration,
        ) =>
          Effect.gen(function* () {
            const key = pendingKey(type, requestId, expectedGeneration);
            if (pending.has(key)) {
              return yield* transportError(
                operation,
                `A response waiter already exists for ${type}.`,
              );
            }
            const deferred = yield* Deferred.make<BridgeMessage, ComputeTransportError>();
            pending.set(key, { type, requestId, generation: expectedGeneration, deferred });
            return {
              await: (timeoutMs: number) =>
                Deferred.await(deferred).pipe(
                  Effect.timeoutOrElse({
                    duration: timeoutMs,
                    orElse: () =>
                      Effect.fail(transportError(operation, `Timed out waiting for ${type}.`)),
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      pending.delete(key);
                    }),
                  ),
                ),
              remove: Effect.sync(() => {
                pending.delete(key);
              }),
            };
          });

        const resolveResponse = (message: BridgeMessage) => {
          const key = pendingKey(message.type, message.requestId, message.generation);
          const entry = pending.get(key);
          return entry === undefined
            ? Effect.void
            : Deferred.succeed(entry.deferred, message).pipe(Effect.asVoid);
        };

        const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

        const mapBridgeMessage = (message: BridgeMessage) =>
          Effect.gen(function* () {
            const responseOnly = new Set<BridgeMessage["type"]>([
              "hello-ack",
              "kernel-ready",
              "interrupt-result",
              "variables",
              "restarted",
              "shutdown-complete",
            ]);
            if (
              responseOnly.has(message.type) &&
              !pending.has(pendingKey(message.type, message.requestId, message.generation))
            ) {
              return yield* transportError("receive", `Bridge sent unsolicited ${message.type}.`);
            }
            switch (message.type) {
              case "accepted": {
                if (MutableRef.get(activeRequestId) !== message.requestId) {
                  return yield* transportError("receive", "Bridge accepted an unknown execution.");
                }
                yield* emit({
                  _tag: "accepted",
                  requestId: message.requestId!,
                  generation: message.generation,
                });
                break;
              }

              case "stream": {
                const payload = message.payload as { stream: "stdout" | "stderr"; text: string };
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "stream",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    stream: payload.stream,
                    text: payload.text,
                  },
                  image: null,
                });
                break;
              }

              case "display": {
                const payload = message.payload as
                  | { mediaType: "image/png"; data: string }
                  | { mediaType: "image/svg+xml"; data: string }
                  | { mediaType: "text/plain"; text: string };
                if (payload.mediaType === "text/plain") {
                  yield* emit({
                    _tag: "output",
                    requestId: message.requestId,
                    generation: message.generation,
                    output: {
                      _tag: "stream",
                      sequence: message.sequence,
                      observedAt: yield* timestamp,
                      stream: "stdout",
                      text: payload.text,
                    },
                    image: null,
                  });
                  break;
                }
                const imageBytes =
                  payload.mediaType === "image/png"
                    ? decodePngPayload(payload.data)
                    : decodeSvgPayload(payload.data);
                if (typeof imageBytes === "string") {
                  yield* emit({
                    _tag: "output",
                    requestId: message.requestId,
                    generation: message.generation,
                    output: {
                      _tag: "system",
                      sequence: message.sequence,
                      observedAt: yield* timestamp,
                      event: "output-truncated",
                      detail: imageBytes,
                    },
                    image: null,
                  });
                  break;
                }
                const dimensions =
                  payload.mediaType === "image/png"
                    ? inspectComputeStaticImage("image/png", imageBytes)
                    : null;
                const hash = NodeCrypto.createHash("sha256").update(imageBytes).digest("hex");
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "image",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    mediaType: payload.mediaType,
                    contentHash: `sha256:${hash}`,
                    byteLength: imageBytes.byteLength,
                    width: dimensions?.width ?? null,
                    height: dimensions?.height ?? null,
                    origin: { _tag: "runtime-display" },
                  },
                  image: { bytes: imageBytes },
                });
                break;
              }

              case "error": {
                const payload = message.payload as {
                  name: string;
                  value: string;
                  traceback: string[];
                };
                yield* emit({
                  _tag: "runtime-error",
                  sequence: message.sequence,
                  observedAt: yield* timestamp,
                  requestId: message.requestId,
                  generation: message.generation,
                  report: payload,
                });
                break;
              }

              case "warning": {
                const payload = message.payload as {
                  code: "output-truncated" | "input-unsupported" | "runtime-warning";
                  detail: string | null;
                };
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "system",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    event: payload.code,
                    detail: payload.detail,
                  },
                  image: null,
                });
                break;
              }

              case "execution-complete": {
                if (MutableRef.get(activeRequestId) !== message.requestId) {
                  return yield* transportError("receive", "Bridge completed an unknown execution.");
                }
                const payload = message.payload as {
                  outcome: "succeeded" | "failed" | "cancelled";
                };
                yield* emit({
                  _tag: "completed",
                  sequence: message.sequence,
                  observedAt: yield* timestamp,
                  requestId: message.requestId!,
                  generation: message.generation,
                  outcome: payload.outcome,
                });
                MutableRef.set(activeRequestId, null);
                break;
              }

              case "restarted": {
                // The generation comes from the envelope, which `validateInbound`
                // has already checked advances by exactly one. A copy in the
                // payload would be a second source of truth that could disagree
                // with the one the sequence and identity checks ran against.
                const payload = message.payload as { kernelPid: number };
                const previous = MutableRef.get(runtimeIdentity);
                if (previous === null) {
                  return yield* transportError(
                    "receive",
                    "Restart arrived before runtime identity was established.",
                  );
                }
                const runtime = { ...previous, runtimeProcessId: payload.kernelPid };
                MutableRef.set(generation, message.generation);
                MutableRef.set(runtimeIdentity, runtime);
                MutableRef.set(transitioning, false);
                yield* emit({ _tag: "restarted", generation: message.generation, runtime });
                break;
              }

              case "fatal": {
                const payload = message.payload as { reason: string };
                return yield* transportError("receive", payload.reason);
              }
            }

            yield* resolveResponse(message);
          });

        const validateInbound = (message: BridgeMessage) =>
          Effect.gen(function* () {
            if (message.sessionId !== request.sessionId) {
              return yield* transportError("receive", "Bridge session identity changed.");
            }
            const current = MutableRef.get(generation);
            const expected =
              message.type === "restarted" ? nextComputeSessionGeneration(current) : current;
            if (message.generation !== expected) {
              return yield* transportError(
                "receive",
                `Expected bridge generation ${expected}, received ${message.generation}.`,
              );
            }
            return message;
          });

        const isTransportError = Schema.is(ComputeTransportError);
        const readStdout = Stream.runForEach(handle.stdout, (chunk) =>
          Effect.gen(function* () {
            const frames = yield* decoder.push(chunk);
            for (const frame of frames) {
              const envelope = yield* decodeComputeProtocolMessage(frame);
              yield* requireSupportedProtocolVersion(envelope);
              const bridgeMessage = yield* decodeBridgeMessage(envelope, "bridge-to-server");
              yield* validateBridgeSequence(inboundSequence, bridgeMessage);
              yield* validateInbound(bridgeMessage);
              yield* mapBridgeMessage(bridgeMessage);
            }
          }).pipe(
            Effect.mapError((cause) =>
              isTransportError(cause)
                ? cause
                : transportError("receive", "Bridge protocol failed.", cause),
            ),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            isTransportError(cause)
              ? cause
              : transportError("receive", "Bridge stdout failed.", cause),
          ),
          Effect.andThen(
            decoder.finish.pipe(
              Effect.mapError((cause) =>
                transportError("receive", "Bridge stdout ended with a partial frame.", cause),
              ),
            ),
          ),
          Effect.andThen(
            Effect.suspend(() =>
              MutableRef.get(closed) || MutableRef.get(stopping)
                ? Effect.void
                : Effect.fail(transportError("receive", "Bridge stdout closed unexpectedly.")),
            ),
          ),
          Effect.catch((error) => lose(error)),
        );
        yield* Effect.forkScoped(readStdout);

        yield* Stream.runForEach(handle.stderr, (chunk) =>
          Effect.sync(() => {
            const text = new TextDecoder().decode(chunk);
            const combined = MutableRef.get(stderrTail) + text;
            const bytes = Buffer.from(combined, "utf8");
            MutableRef.set(
              stderrTail,
              bytes.byteLength <= MAX_STDERR_TAIL_BYTES
                ? combined
                : bytes.subarray(bytes.byteLength - MAX_STDERR_TAIL_BYTES).toString("utf8"),
            );
          }),
        ).pipe(Effect.ignore, Effect.forkScoped);

        yield* handle.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.suspend(() =>
              MutableRef.get(closed) || MutableRef.get(stopping)
                ? Effect.void
                : lose(
                    transportError(
                      "receive",
                      `Bridge process exited unexpectedly with code ${code}.`,
                    ),
                  ),
            ),
          ),
          Effect.catch((cause) =>
            Effect.suspend(() =>
              MutableRef.get(closed) || MutableRef.get(stopping)
                ? Effect.void
                : lose(transportError("receive", "Bridge process terminated.", cause)),
            ),
          ),
          Effect.forkScoped,
        );

        /**
         * Sends one command frame, minting its sequence as it goes.
         *
         * The whole body holds `writeGate`, which is a separate permit from the
         * round-trip `commandGate`: two callers must not interleave halves of
         * two frames on one pipe, and the sequence the bridge validates must
         * increase in the same order the bytes arrive. `execute` runs outside
         * `commandGate` but still inside this gate, so it stays atomic without
         * waiting on a restart.
         */
        const sendCommand = (
          operation: ComputeTransportError["operation"],
          type: string,
          payload: unknown,
          expectedGeneration: ComputeSessionGeneration,
          requestId: ComputeRequestId | null = null,
        ) =>
          writeGate.withPermits(1)(
            Effect.gen(function* () {
              const sequence = MutableRef.get(outboundSequence);
              MutableRef.set(outboundSequence, sequence + 1);
              const frame = yield* encodeComputeProtocolMessage({
                protocolVersion: COMPUTE_PROTOCOL_VERSION,
                type,
                sessionId: request.sessionId,
                generation: expectedGeneration,
                requestId,
                sequence,
                payload,
              }).pipe(
                Effect.mapError((cause) =>
                  transportError(operation, "Failed to encode bridge command.", cause),
                ),
              );
              yield* handle
                .write(frame)
                .pipe(
                  Effect.mapError((cause) =>
                    transportError(operation, "Failed to send bridge command.", cause),
                  ),
                );
            }),
          );

        const requestResponse = (
          operation: ComputeTransportError["operation"],
          command: {
            readonly type: string;
            readonly payload: unknown;
            readonly generation: ComputeSessionGeneration;
            readonly requestId?: ComputeRequestId | null;
          },
          response: {
            readonly type: BridgeMessage["type"];
            readonly generation: ComputeSessionGeneration;
            readonly requestId?: ComputeRequestId | null;
          },
          timeoutMs: number,
        ) =>
          Effect.gen(function* () {
            const waiter = yield* registerResponse(
              operation,
              response.type,
              response.requestId ?? null,
              response.generation,
            );
            yield* sendCommand(
              operation,
              command.type,
              command.payload,
              command.generation,
              command.requestId ?? null,
            ).pipe(Effect.onError(() => waiter.remove));
            return yield* waiter.await(timeoutMs);
          });

        /**
         * One deadline for the whole startup, spent across its steps.
         *
         * Startup is two round trips, and giving each of them the full budget
         * would let a slow one push the total past the bound the caller was
         * promised. Wrapping the pair in a second timer of the same length
         * instead would leave two timers racing to describe one condition, so
         * the message a user got for a bad environment would depend on which
         * fired. The remaining budget keeps the total exact and lets the step
         * that actually stalled name itself.
         */
        const startupDeadline = (yield* Clock.currentTimeMillis) + startupTimeoutMs;
        const remainingStartupMs = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.max(1, startupDeadline - now)),
        );

        const handshake = commandGate
          .withPermits(1)(
            Effect.gen(function* () {
              const ack = yield* requestResponse(
                "handshake",
                {
                  type: "hello",
                  generation: request.generation,
                  payload: {
                    buildId: "scient-server",
                    frameLimit: 16 * 1024 * 1024,
                    requiredCapabilities: [...request.requiredCapabilities],
                    ownerToken,
                  },
                },
                { type: "hello-ack", generation: request.generation },
                yield* remainingStartupMs,
              );
              const ackPayload = ack.payload as {
                ownerToken: string;
                pid: number;
                platform: string;
                capabilities: ComputeCapability[];
              };
              if (ackPayload.ownerToken !== ownerToken) {
                return yield* transportError("handshake", "Owner token mismatch.");
              }
              if (ackPayload.pid !== handle.pid) {
                return yield* transportError("handshake", "Bridge PID mismatch.");
              }
              if (!hasCapabilities(ackPayload.capabilities, request.requiredCapabilities)) {
                return yield* transportError("handshake", "Bridge capabilities are incomplete.");
              }

              const ready = yield* requestResponse(
                "handshake",
                {
                  type: "start-kernel",
                  generation: request.generation,
                  // A null kernel name asks the bridge for the interpreter that
                  // is already running it, which is what a Python session wants.
                  // A future language ships its own kernel spec name here without
                  // the bridge having to guess from the launch plan.
                  payload: { workingDirectory: request.launch.cwd, kernelName: null },
                },
                { type: "kernel-ready", generation: request.generation },
                yield* remainingStartupMs,
              );
              const payload = ready.payload as {
                kernelPid: number;
                languageId: string;
                languageVersion: string;
                protocolVersion: number;
                capabilities: ComputeCapability[];
              };
              if (payload.protocolVersion !== COMPUTE_PROTOCOL_VERSION) {
                return yield* transportError("handshake", "Kernel protocol version mismatch.");
              }
              if (payload.languageId !== request.languageId) {
                return yield* transportError(
                  "handshake",
                  `Expected language '${request.languageId}', received '${payload.languageId}'.`,
                );
              }
              if (!hasCapabilities(payload.capabilities, request.requiredCapabilities)) {
                return yield* transportError("handshake", "Kernel capabilities are incomplete.");
              }
              const runtime: ComputeRuntimeIdentity = {
                languageId: ComputeLanguageId.make(payload.languageId),
                transportKind: ComputeTransportKind.make(request.transportKind),
                protocolVersion: payload.protocolVersion,
                languageVersion: payload.languageVersion,
                platform: ackPayload.platform,
                transportProcessId: ackPayload.pid,
                runtimeProcessId: payload.kernelPid,
              };
              MutableRef.set(runtimeIdentity, runtime);
              yield* emit({ _tag: "ready", runtime, capabilities: payload.capabilities });
            }),
          )
          .pipe(Effect.tapError(() => handle.cancelProcessTree.pipe(Effect.ignore)));
        yield* handshake;

        const ensureGeneration = (
          operation: ComputeTransportError["operation"],
          expected: ComputeSessionGeneration,
        ) =>
          Effect.suspend(() => {
            if (MutableRef.get(closed) || MutableRef.get(lost)) {
              return Effect.fail(transportError(operation, "The runtime is no longer reachable."));
            }
            const current = MutableRef.get(generation);
            return expected === current
              ? Effect.void
              : Effect.fail(
                  transportError(
                    operation,
                    `The command expected generation ${expected}, but the session is at generation ${current}.`,
                  ),
                );
          });

        /**
         * Deliberately outside `commandGate`.
         *
         * A restart holds that gate for up to the startup timeout, and an
         * execute queued behind it would sit there only to be rejected for a
         * stale generation the moment it woke up. Failing immediately tells the
         * caller the truth sooner. Ordering against other executes is still
         * guaranteed by `writeGate` inside `sendCommand`.
         */
        const execute: ComputeChannel["execute"] = (executeRequest) =>
          Effect.suspend(() => {
            if (MutableRef.get(transitioning)) {
              return Effect.fail(transportError("execute", "The runtime is changing generation."));
            }
            if (MutableRef.get(activeRequestId) !== null) {
              return Effect.fail(transportError("execute", "An execution is already active."));
            }
            if (MutableRef.get(inspectingVariables)) {
              return Effect.fail(
                transportError("execute", "The runtime is inspecting its current variables."),
              );
            }
            if (estimateTextBytes(executeRequest.code) > 1024 * 1024) {
              return Effect.fail(
                transportError("execute", "Execution code exceeds the 1048576 byte limit."),
              );
            }
            MutableRef.set(activeRequestId, executeRequest.requestId);
            return ensureGeneration("execute", executeRequest.expectedGeneration).pipe(
              Effect.andThen(
                sendCommand(
                  "execute",
                  "execute",
                  { code: executeRequest.code, silent: false, storeHistory: true },
                  executeRequest.expectedGeneration,
                  executeRequest.requestId,
                ),
              ),
              Effect.tapError(() =>
                Effect.sync(() => {
                  MutableRef.set(activeRequestId, null);
                }),
              ),
            );
          });

        const interrupt: ComputeChannel["interrupt"] = (interruptRequest) =>
          commandGate.withPermits(1)(
            ensureGeneration("interrupt", interruptRequest.expectedGeneration).pipe(
              Effect.andThen(
                requestResponse(
                  "interrupt",
                  {
                    type: "interrupt",
                    payload: {},
                    generation: interruptRequest.expectedGeneration,
                    requestId: interruptRequest.requestId,
                  },
                  {
                    type: "interrupt-result",
                    generation: interruptRequest.expectedGeneration,
                    requestId: interruptRequest.requestId,
                  },
                  DEFAULT_INTERRUPT_TIMEOUT_MS,
                ),
              ),
              // Every outcome is an answer, not an error: `rejected` and
              // `timeout` describe an execution that survived, and a caller
              // needs to know that to decide whether to escalate to a restart.
              // Failing here would collapse them into the same shape as a
              // broken pipe.
              Effect.map(
                (message) => (message.payload as { result: ComputeInterruptOutcome }).result,
              ),
            ),
          );

        const inspectVariables: ComputeChannel["inspectVariables"] = (variablesRequest) =>
          commandGate.withPermits(1)(
            Effect.suspend(() => {
              if (MutableRef.get(transitioning)) {
                return Effect.fail(
                  transportError("variables", "The runtime is changing generation."),
                );
              }
              if (MutableRef.get(activeRequestId) !== null) {
                return Effect.fail(transportError("variables", "An execution is already active."));
              }
              MutableRef.set(inspectingVariables, true);
              return ensureGeneration("variables", variablesRequest.expectedGeneration).pipe(
                Effect.andThen(
                  requestResponse(
                    "variables",
                    {
                      type: "inspect-variables",
                      payload: {},
                      generation: variablesRequest.expectedGeneration,
                      requestId: variablesRequest.requestId,
                    },
                    {
                      type: "variables",
                      generation: variablesRequest.expectedGeneration,
                      requestId: variablesRequest.requestId,
                    },
                    DEFAULT_VARIABLES_TIMEOUT_MS,
                  ),
                ),
                Effect.flatMap((message) => {
                  const payload = message.payload as {
                    variables: ComputeVariableSnapshot["variables"];
                    truncated: boolean;
                    error: string | null;
                  };
                  return payload.error === null
                    ? Effect.succeed({
                        generation: variablesRequest.expectedGeneration,
                        variables: payload.variables,
                        truncated: payload.truncated,
                      } satisfies ComputeVariableSnapshot)
                    : Effect.fail(transportError("variables", payload.error));
                }),
                Effect.ensuring(
                  Effect.sync(() => {
                    MutableRef.set(inspectingVariables, false);
                  }),
                ),
              );
            }),
          );

        const restart: ComputeChannel["restart"] = (restartRequest) =>
          commandGate.withPermits(1)(
            ensureGeneration("restart", restartRequest.expectedGeneration).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  restartRequest.nextGeneration ===
                  nextComputeSessionGeneration(restartRequest.expectedGeneration)
                    ? Effect.void
                    : Effect.fail(
                        transportError(
                          "restart",
                          "Restart must advance exactly one session generation.",
                        ),
                      ),
                ),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  MutableRef.set(transitioning, true);
                }),
              ),
              Effect.andThen(
                requestResponse(
                  "restart",
                  {
                    type: "restart",
                    payload: { nextGeneration: restartRequest.nextGeneration },
                    generation: restartRequest.expectedGeneration,
                  },
                  { type: "restarted", generation: restartRequest.nextGeneration },
                  startupTimeoutMs,
                ).pipe(Effect.tapError((error) => lose(error))),
              ),
              Effect.asVoid,
            ),
          );

        const shutdown: ComputeChannel["shutdown"] = (shutdownRequest) =>
          commandGate.withPermits(1)(
            Effect.suspend(() => {
              if (MutableRef.get(closed)) return Effect.void;
              return ensureGeneration("shutdown", shutdownRequest.expectedGeneration).pipe(
                // Set before the round trip, not after: the bridge closes its
                // stdout and exits as part of answering, and both of those
                // reach the watchers above before `shutdown-complete` reaches
                // this fibre. If the round trip fails the session really is in
                // trouble, so the flag is cleared and loss reporting resumes.
                Effect.andThen(
                  Effect.sync(() => {
                    MutableRef.set(stopping, true);
                  }),
                ),
                Effect.andThen(
                  requestResponse(
                    "shutdown",
                    {
                      type: "shutdown",
                      payload: {},
                      generation: shutdownRequest.expectedGeneration,
                    },
                    {
                      type: "shutdown-complete",
                      generation: shutdownRequest.expectedGeneration,
                    },
                    DEFAULT_SHUTDOWN_TIMEOUT_MS,
                  ).pipe(
                    // The bridge was asked to leave and did not answer. It is
                    // not shutting down cleanly, so the intent is withdrawn and
                    // the session is reported lost -- a consumer waiting on the
                    // event stream has to be told the session ended, and this
                    // is the only place that still knows why.
                    Effect.tapError((error) =>
                      Effect.sync(() => {
                        MutableRef.set(stopping, false);
                      }).pipe(Effect.andThen(lose(error))),
                    ),
                  ),
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    MutableRef.set(closed, true);
                  }),
                ),
                Effect.andThen(Queue.end(events)),
                Effect.andThen(handle.cancelProcessTree.pipe(Effect.ignore)),
                Effect.asVoid,
              );
            }),
          );

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Goes through `shutdown` rather than repeating its steps: a second
            // copy of the sequence would be the one that drifts, and it already
            // returns immediately when the session is closed. The scope is
            // closing either way, so a slow or failed goodbye is capped and
            // then ignored before the process tree is taken down.
            if (!MutableRef.get(lost)) {
              yield* shutdown({ expectedGeneration: MutableRef.get(generation) }).pipe(
                Effect.timeoutOrElse({
                  duration: DEFAULT_FINALIZER_SHUTDOWN_MS,
                  orElse: () => Effect.void,
                }),
                Effect.ignore,
              );
            }
            MutableRef.set(closed, true);
            yield* failPending(transportError("shutdown", "Transport scope closed.")).pipe(
              Effect.ignore,
            );
            yield* Queue.end(events).pipe(Effect.ignore);
            yield* handle.cancelProcessTree.pipe(Effect.ignore);
          }),
        );

        const eventStream = Stream.fromQueue(events).pipe(
          Stream.map((weighted) => {
            const remaining = Math.max(0, MutableRef.get(eventBytes) - weighted.byteLength);
            MutableRef.set(eventBytes, remaining);
            if (MutableRef.get(droppingOutput) && remaining <= resumeEventQueueBytes) {
              MutableRef.set(droppingOutput, false);
            }
            return weighted.event;
          }),
        );

        return {
          events: eventStream,
          execute,
          interrupt,
          inspectVariables,
          restart,
          shutdown,
        } satisfies ComputeChannel;
      });
    },
  };
}
