import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { REQUIRED_COMPUTE_CAPABILITIES } from "./capabilities.ts";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeRequestId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  nextComputeSessionGeneration,
  type ComputeDiagnostic,
  type ComputeExecutionStatus,
  type ComputeLanguageAdapter,
  type ComputeOutput,
  type ComputeRuntimeProfile,
  type ComputeSessionStatus,
  type ComputeTransportEvent,
} from "./contract.ts";
import { transitionComputeExecutionStatus } from "./executionStateMachine.ts";
import { transitionComputeSessionStatus } from "./sessionStateMachine.ts";
import { createSimulatedComputeTransport } from "./simulator.ts";

/**
 * A fake R adapter paired with the language-neutral simulated transport.
 *
 * This exit gate proves that session lifecycle is independent from Python and
 * that another adapter can provide discovery, launch preparation, diagnostics,
 * and fingerprints. It deliberately makes no claim that the Python-hosted
 * Jupyter bridge can launch R; a real R kernel is the proof for that later
 * transport-host/kernel boundary.
 */
const R_LANGUAGE = ComputeLanguageId.make("r");
const SIMULATED_TRANSPORT = ComputeTransportKind.make("simulated");

const profile: ComputeRuntimeProfile = {
  languageId: R_LANGUAGE,
  source: "path",
  executable: "/usr/local/bin/R",
  languageVersion: "4.4.1",
  architecture: "arm64",
  displayName: "R 4.4.1 (PATH)",
};

/** Its runtime numbers traceback lines and colours them; Scient shows neither. */
const stripFrameDecoration = (frame: string): string =>
  frame
    // eslint-disable-next-line no-control-regex -- matches the runtime's own colour codes.
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/^\s*\d+:\s*/, "")
    .trim();

const fakeRAdapter: ComputeLanguageAdapter = {
  languageId: R_LANGUAGE,
  transportKind: SIMULATED_TRANSPORT,
  discover: (request) =>
    Effect.succeed(
      request.configuredExecutable === null
        ? [profile]
        : [{ ...profile, source: "configured", executable: request.configuredExecutable }],
    ),
  verify: (request) =>
    Effect.succeed({
      profile: request.profile,
      readiness: "ready",
      missingRequirements: [],
      message: null,
    }),
  prepareLaunch: (request) =>
    Effect.succeed({
      executable: request.profile.executable,
      args: ["--vanilla"],
      cwd: request.cwd,
      environment: request.environment,
    }),
  normalizeDiagnostic: (report) => [
    {
      errorName: report.name,
      message: report.value,
      traceback: report.traceback.map(stripFrameDecoration).filter((frame) => frame.length > 0),
    },
  ],
  fingerprintEnvironment: (candidate) =>
    Effect.succeed({
      hash: `r-${candidate.languageVersion}-${candidate.executable}`,
      contributors: ["executable", "languageVersion"],
    }),
};

const textOutput = (sequence: number, text: string): ComputeOutput => ({
  _tag: "stream",
  sequence,
  observedAt: "2026-08-18T00:00:00.000Z",
  stream: "stdout",
  text,
});

const sessionId = ComputeSessionId.make("session-boundary");
const executionId = ComputeExecutionId.make("execution-1");

describe("compute language boundary", () => {
  it.effect("drives a full session through a fake R adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [discovered] = yield* fakeRAdapter.discover({
          projectRoot: "/project",
          configuredExecutable: null,
        });
        const verification = yield* fakeRAdapter.verify({
          profile: discovered!,
          cwd: "/project",
          environment: { LANG: "C" },
        });
        expect(verification.readiness).toBe("ready");

        const fingerprint = yield* fakeRAdapter.fingerprintEnvironment(discovered!);
        const launch = yield* fakeRAdapter.prepareLaunch({
          profile: discovered!,
          cwd: "/project",
          environment: { LANG: "C" },
        });
        expect(launch.args).toEqual(["--vanilla"]);
        const openRequest = {
          sessionId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          languageId: fakeRAdapter.languageId,
          transportKind: fakeRAdapter.transportKind,
          launch,
          requiredCapabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
        };

        const runtime = {
          languageId: R_LANGUAGE,
          transportKind: SIMULATED_TRANSPORT,
          protocolVersion: 1,
          languageVersion: discovered!.languageVersion,
          platform: "simulated",
          transportProcessId: 4242,
          runtimeProcessId: 4243,
        };
        const transport = createSimulatedComputeTransport({
          runtime,
          capabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
          resolveExecution: (code) =>
            code === "loop()"
              ? { _tag: "runs-until-interrupted", outputs: [textOutput(1, "working\n")] }
              : {
                  _tag: "completes",
                  outputs: [textOutput(1, "42\n")],
                  outcome: "succeeded",
                },
        });

        let session: ComputeSessionStatus = "starting";
        let generation = INITIAL_COMPUTE_SESSION_GENERATION;
        const channel = yield* transport.open(openRequest);
        const observed = yield* Queue.unbounded<ComputeTransportEvent>();
        yield* channel.events.pipe(
          Stream.runForEach((event) => Queue.offer(observed, event)),
          Effect.forkScoped,
        );
        const next = Queue.take(observed);

        const ready = yield* next;
        expect(ready._tag).toBe("ready");
        session = yield* transitionComputeSessionStatus(session, "ready");

        // Repeated work reuses one channel. The simulator proves the
        // language-neutral lifecycle boundary; it deliberately does not claim
        // to execute code or model a runtime namespace.
        const firstRequest = ComputeRequestId.make(executionId);
        let execution: ComputeExecutionStatus = yield* transitionComputeExecutionStatus(
          "queued",
          "submitting",
        );
        yield* channel.execute({
          requestId: firstRequest,
          expectedGeneration: generation,
          code: "answer <- 42; answer",
        });
        expect((yield* next)._tag).toBe("accepted");
        execution = yield* transitionComputeExecutionStatus(execution, "running");
        const output = yield* next;
        expect(output).toEqual({
          _tag: "output",
          requestId: firstRequest,
          generation,
          output: textOutput(1, "42\n"),
          image: null,
        });
        const completed = yield* next;
        expect(completed).toEqual({
          _tag: "completed",
          requestId: firstRequest,
          generation,
          outcome: "succeeded",
        });
        execution = yield* transitionComputeExecutionStatus(execution, "succeeded");
        expect(execution).toBe("succeeded");

        // Work a user gives up on ends as cancelled, and the session survives it.
        const runawayRequest = ComputeRequestId.make("execution-2");
        let runaway: ComputeExecutionStatus = yield* transitionComputeExecutionStatus(
          "queued",
          "submitting",
        );
        yield* channel.execute({
          requestId: runawayRequest,
          expectedGeneration: generation,
          code: "loop()",
        });
        expect((yield* next)._tag).toBe("accepted");
        runaway = yield* transitionComputeExecutionStatus(runaway, "running");
        expect((yield* next)._tag).toBe("output");
        runaway = yield* transitionComputeExecutionStatus(runaway, "interrupting");
        yield* channel.interrupt({
          requestId: runawayRequest,
          expectedGeneration: generation,
        });
        expect(yield* next).toEqual({
          _tag: "completed",
          requestId: runawayRequest,
          generation,
          outcome: "cancelled",
        });
        runaway = yield* transitionComputeExecutionStatus(runaway, "cancelled");
        expect(runaway).toBe("cancelled");
        expect(session).toBe("ready");

        // A restart replaces the namespace, so the generation moves with it.
        session = yield* transitionComputeSessionStatus(session, "restarting");
        generation = nextComputeSessionGeneration(generation);
        yield* channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration: generation,
        });
        expect(yield* next).toEqual({ _tag: "restarted", generation: 2, runtime });
        session = yield* transitionComputeSessionStatus(session, "ready");

        session = yield* transitionComputeSessionStatus(session, "stopping");
        yield* channel.shutdown({ expectedGeneration: generation });
        session = yield* transitionComputeSessionStatus(session, "stopped");

        expect(session).toBe("stopped");
        expect(fingerprint.contributors).toEqual(["executable", "languageVersion"]);
      }),
    ),
  );

  it("normalizes a runtime error nothing else in Scient understands", () => {
    const diagnostics = fakeRAdapter.normalizeDiagnostic({
      name: "simpleError",
      value: "object 'answer' not found",
      traceback: ["1: \u001B[31mread(answer)\u001B[0m", "2: eval(expr)", "   "],
    });

    expect(diagnostics).toEqual([
      {
        errorName: "simpleError",
        message: "object 'answer' not found",
        traceback: ["read(answer)", "eval(expr)"],
      },
    ] satisfies ReadonlyArray<ComputeDiagnostic>);
  });
});
