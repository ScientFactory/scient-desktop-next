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

  it.effect("ends work that a restart destroyed the namespace of", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* openSimulated(() => ({
          _tag: "runs-until-interrupted",
          outputs: [],
        }));
        const events = yield* observe(channel);
        yield* events.next;
        let status: ComputeExecutionStatus = transitionComputeExecutionStatus(
          "queued",
          "submitting",
        );
        yield* channel.execute({
          requestId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "sleep()",
        });
        expect(yield* events.next).toEqual({ _tag: "accepted", requestId });
        status = transitionComputeExecutionStatus(status, "running");

        yield* channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration: ComputeSessionGeneration.make(2),
        });

        expect(yield* events.next).toEqual({ _tag: "completed", requestId, outcome: "cancelled" });
        status = transitionComputeExecutionStatus(status, "cancelled");
        expect(yield* events.next).toEqual({ _tag: "restarted", generation: 2 });
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
        expect(yield* events.next).toEqual({ _tag: "accepted", requestId });
        expect(yield* events.next).toEqual({
          _tag: "completed",
          requestId,
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
        expect(yield* events.next).toEqual({ _tag: "accepted", requestId: nextRequestId });
        expect(yield* events.next).toEqual({
          _tag: "completed",
          requestId: nextRequestId,
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
