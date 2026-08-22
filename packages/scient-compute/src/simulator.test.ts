import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { REQUIRED_COMPUTE_CAPABILITIES } from "./capabilities.ts";
import {
  ComputeLanguageId,
  ComputeRequestId,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeCapability,
  type ComputeChannel,
  type ComputeExecutionStatus,
  type ComputeRuntimeIdentity,
  type ComputeTransportEvent,
  type ComputeTransportOpenRequest,
} from "./contract.ts";
import { transitionComputeExecutionStatus } from "./executionStateMachine.ts";
import { createSimulatedComputeTransport, type SimulatedComputeExecution } from "./simulator.ts";

const runtime: ComputeRuntimeIdentity = {
  languageId: ComputeLanguageId.make("fictional"),
  transportKind: ComputeTransportKind.make("simulated"),
  protocolVersion: 1,
  languageVersion: "0.1.0",
  platform: "simulated",
  transportProcessId: null,
  runtimeProcessId: null,
};

const openRequest: ComputeTransportOpenRequest = {
  sessionId: ComputeSessionId.make("session-1"),
  generation: INITIAL_COMPUTE_SESSION_GENERATION,
  languageId: runtime.languageId,
  transportKind: runtime.transportKind,
  launch: { executable: "/nowhere", args: [], cwd: "/project", environment: {} },
  requiredCapabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
};

const requestId = ComputeRequestId.make("request-1");

const observe = (channel: ComputeChannel) =>
  Effect.gen(function* () {
    const observed = yield* Queue.unbounded<ComputeTransportEvent>();
    // Drain once into a queue the test owns: reading a chunked stream in
    // instalments would discard whatever arrived in the same pull.
    yield* channel.events.pipe(
      Stream.runForEach((event) => Queue.offer(observed, event)),
      Effect.forkScoped,
    );
    return { next: Queue.take(observed) };
  });

const openSimulated = (
  resolveExecution: (code: string) => SimulatedComputeExecution,
  options?: { readonly capabilities?: ReadonlyArray<ComputeCapability> },
) =>
  createSimulatedComputeTransport({
    runtime,
    capabilities: options?.capabilities ?? [...REQUIRED_COMPUTE_CAPABILITIES],
    resolveExecution,
  }).open(openRequest);

describe("simulated compute transport", () => {
  it.effect("refuses to open when the runtime cannot do what the session needs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          openSimulated(() => ({ _tag: "completes", outputs: [], outcome: "succeeded" }), {
            capabilities: ["execute", "shutdown"],
          }),
        );

        expect(error.operation).toBe("handshake");
        expect(error.message).toBe("The runtime does not support interrupt, restart.");
      }),
    ),
  );

  it.effect("announces itself before it is asked anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "succeeded",
        }));
        const events = yield* observe(channel);

        expect(yield* events.next).toEqual({
          _tag: "ready",
          runtime,
          capabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
        });
      }),
    ),
  );

  it.effect("keeps optional variable inspection generation-scoped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(
          () => ({ _tag: "completes", outputs: [], outcome: "succeeded" }),
          { capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, "variables"] },
        );
        expect(
          yield* channel.inspectVariables({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        ).toEqual({
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          variables: [],
          truncated: false,
        });
        const stale = yield* Effect.flip(
          channel.inspectVariables({
            requestId,
            expectedGeneration: ComputeSessionGeneration.make(2),
          }),
        );
        expect(stale.operation).toBe("variables");
      }),
    ),
  );

  it.effect("runs one execution at a time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "runs-until-interrupted",
          outputs: [],
        }));
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "sleep()",
        });

        const error = yield* Effect.flip(
          channel.execute({
            requestId: ComputeRequestId.make("request-2"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "sleep()",
          }),
        );

        expect(error.operation).toBe("execute");
      }),
    ),
  );

  it.effect("hands image bytes over once, beside the metadata that describes them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [
            {
              _tag: "image",
              sequence: 4,
              observedAt: "2026-08-19T00:00:00.000Z",
              mediaType: "image/png",
              contentHash: "sha256:abc",
              byteLength: bytes.byteLength,
              width: 1,
              height: 1,
            },
          ],
          outcome: "succeeded",
          imageBytes: new Map([[4, bytes]]),
        }));
        const events = yield* observe(channel);
        yield* events.next;
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "plot()",
        });

        expect(yield* events.next).toMatchObject({ _tag: "accepted" });
        expect(yield* events.next).toMatchObject({
          _tag: "output",
          image: { bytes },
          output: { _tag: "image", sequence: 4 },
        });
        expect(yield* events.next).toMatchObject({ _tag: "completed", outcome: "succeeded" });
      }),
    ),
  );

  it.effect("reports the raw error and the end of the execution as two facts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "failed",
          runtimeError: {
            sequence: 2,
            observedAt: "2026-08-19T00:00:00.000Z",
            report: { name: "ValueError", value: "bad input", traceback: ["Traceback ..."] },
          },
        }));
        const events = yield* observe(channel);
        yield* events.next;
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "raise ValueError",
        });

        expect(yield* events.next).toMatchObject({ _tag: "accepted" });
        expect(yield* events.next).toEqual({
          _tag: "runtime-error",
          sequence: 2,
          observedAt: "2026-08-19T00:00:00.000Z",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          report: { name: "ValueError", value: "bad input", traceback: ["Traceback ..."] },
        });
        expect(yield* events.next).toMatchObject({ _tag: "completed", outcome: "failed" });
      }),
    ),
  );

  it.effect("says whether an interrupt had anything left to stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "runs-until-interrupted",
          outputs: [],
        }));
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "sleep()",
        });

        expect(
          yield* channel.interrupt({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        ).toBe("interrupted");
        // The same request a second time: the execution it named is over, and
        // saying so is not the same as saying the interrupt worked.
        expect(
          yield* channel.interrupt({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        ).toBe("terminal");
      }),
    ),
  );

  it.effect("ends work that a restart destroyed the namespace of", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "runs-until-interrupted",
          outputs: [],
        }));
        const events = yield* observe(channel);
        yield* events.next;
        let status: ComputeExecutionStatus = yield* transitionComputeExecutionStatus(
          "queued",
          "submitting",
        );
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "sleep()",
        });
        expect(yield* events.next).toEqual({
          _tag: "accepted",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        status = yield* transitionComputeExecutionStatus(status, "running");

        yield* channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration: ComputeSessionGeneration.make(2),
        });

        expect(yield* events.next).toEqual({
          _tag: "completed",
          sequence: 0,
          observedAt: "1970-01-01T00:00:00.000Z",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          outcome: "cancelled",
        });
        status = yield* transitionComputeExecutionStatus(status, "cancelled");
        expect(yield* events.next).toEqual({ _tag: "restarted", generation: 2, runtime });
        expect(status).toBe("cancelled");
      }),
    ),
  );

  it.effect("rejects every mutating command written against the namespace before a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "succeeded",
        }));
        yield* channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration: ComputeSessionGeneration.make(2),
        });

        const executeError = yield* Effect.flip(
          channel.execute({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "stale()",
          }),
        );
        const interruptError = yield* Effect.flip(
          channel.interrupt({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        );
        const restartError = yield* Effect.flip(
          channel.restart({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            nextGeneration: ComputeSessionGeneration.make(2),
          }),
        );
        const shutdownError = yield* Effect.flip(
          channel.shutdown({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        );

        expect(
          [executeError, interruptError, restartError, shutdownError].map(
            (error) => error.operation,
          ),
        ).toEqual(["execute", "interrupt", "restart", "shutdown"]);
        expect(executeError.message).toContain("session is at generation 2");
      }),
    ),
  );

  it.effect("requires a restart to advance by exactly one generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "succeeded",
        }));

        const error = yield* Effect.flip(
          channel.restart({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            nextGeneration: ComputeSessionGeneration.make(3),
          }),
        );

        expect(error.operation).toBe("restart");
        expect(error.message).toContain("must create generation 2");
      }),
    ),
  );

  it.effect("refuses to interrupt a different active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "runs-until-interrupted",
          outputs: [],
        }));
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "sleep()",
        });

        const error = yield* Effect.flip(
          channel.interrupt({
            requestId: ComputeRequestId.make("request-2"),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        );

        expect(error.operation).toBe("interrupt");
        expect(error.message).toContain("is not the active execution");
      }),
    ),
  );

  it.effect("treats an interrupt that lost the completion race as a no-op", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "succeeded",
        }));
        const events = yield* observe(channel);
        yield* events.next;
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "fast()",
        });
        expect(yield* events.next).toEqual({
          _tag: "accepted",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        expect(yield* events.next).toEqual({
          _tag: "completed",
          sequence: 0,
          observedAt: "1970-01-01T00:00:00.000Z",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          outcome: "succeeded",
        });

        yield* channel.interrupt({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        });

        const nextRequestId = ComputeRequestId.make("request-2");
        yield* channel.execute({
          requestId: nextRequestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "next()",
        });
        expect(yield* events.next).toEqual({
          _tag: "accepted",
          requestId: nextRequestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        expect(yield* events.next).toEqual({
          _tag: "completed",
          sequence: 0,
          observedAt: "1970-01-01T00:00:00.000Z",
          requestId: nextRequestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          outcome: "succeeded",
        });
      }),
    ),
  );

  it.effect("emits output events with null image bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [
            {
              _tag: "stream",
              sequence: 0,
              observedAt: "2026-08-18T00:00:00.000Z",
              stream: "stdout",
              text: "hi\n",
            },
          ],
          outcome: "succeeded",
        }));
        const events = yield* observe(channel);
        yield* events.next;

        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "greet()",
        });
        expect(yield* events.next).toEqual({
          _tag: "accepted",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        expect(yield* events.next).toEqual({
          _tag: "output",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          output: {
            _tag: "stream",
            sequence: 0,
            observedAt: "2026-08-18T00:00:00.000Z",
            stream: "stdout",
            text: "hi\n",
          },
          image: null,
        });
        expect(yield* events.next).toEqual({
          _tag: "completed",
          sequence: 1,
          observedAt: "2026-08-18T00:00:00.000Z",
          requestId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          outcome: "succeeded",
        });
      }),
    ),
  );

  it.effect("reports a runtime that disappeared and then answers nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "loses-runtime",
          reason: "The runtime stopped without exiting.",
        }));
        const events = yield* observe(channel);
        yield* events.next;
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "crash()",
        });
        yield* events.next;

        expect(yield* events.next).toEqual({
          _tag: "lost",
          reason: "The runtime stopped without exiting.",
        });
        const error = yield* Effect.flip(
          channel.execute({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "anything()",
          }),
        );
        expect(error.operation).toBe("execute");
      }),
    ),
  );

  it.effect("stops when the scope that owns it closes", () =>
    Effect.gen(function* () {
      const channel = yield* Effect.scoped(
        openSimulated(() => ({ _tag: "completes", outputs: [], outcome: "succeeded" })),
      );

      // Outliving its scope is the one thing a session must not do: the events
      // still buffered are readable, and nothing further arrives.
      expect(yield* Stream.runCollect(channel.events)).toEqual([
        { _tag: "ready", runtime, capabilities: [...REQUIRED_COMPUTE_CAPABILITIES] },
      ]);
    }),
  );

  it.effect("closes its event stream when it shuts down", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "completes",
          outputs: [],
          outcome: "succeeded",
        }));

        yield* channel.shutdown({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        });

        expect(yield* Stream.runCollect(channel.events)).toEqual([
          { _tag: "ready", runtime, capabilities: [...REQUIRED_COMPUTE_CAPABILITIES] },
        ]);
        expect(
          yield* channel.shutdown({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          }),
        ).toBeUndefined();
      }),
    ),
  );
});
