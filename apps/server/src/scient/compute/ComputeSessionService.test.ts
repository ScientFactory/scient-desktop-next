import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  type ComputeSessionJournalEvent,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  MAXIMUM_PENDING_COMPUTE_EXECUTIONS,
  nextComputeSessionGeneration,
  createSimulatedComputeTransport,
  type ComputeCapability,
  type ComputeLanguageAdapter,
  type ComputeExecutionSource,
  type ComputeOutput,
  type ComputeRuntimeIdentity,
  type ComputeRuntimeProfile,
  type ComputeRuntimeReadiness,
  type ComputeSessionRecord,
  type ComputeSessionStatus,
  type ComputeStartSessionInput,
  type ComputeTransport,
  type SimulatedComputeExecution,
} from "@scientfactory/compute";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import {
  ComputeSessionService,
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  layerWithRuntimes,
  type ComputeSessionServiceOptions,
} from "./ComputeSessionService.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const PROJECT_ID = ComputeProjectId.make("project-1");
const OTHER_PROJECT_ID = ComputeProjectId.make("project-2");
const SESSION_ID = ComputeSessionId.make("session-1");
const PYTHON = ComputeLanguageId.make("python");
const BRIDGE = ComputeTransportKind.make("jupyter-bridge");

const FULL_CAPABILITIES: ReadonlyArray<ComputeCapability> = [
  "execute",
  "interrupt",
  "restart",
  "shutdown",
  "variables",
];

const PROFILE: ComputeRuntimeProfile = {
  languageId: PYTHON,
  source: "path",
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Python 3.12.0",
};

const IDENTITY: ComputeRuntimeIdentity = {
  languageId: PYTHON,
  transportKind: BRIDGE,
  protocolVersion: 1,
  languageVersion: "3.12.0",
  platform: "darwin-arm64",
  transportProcessId: 4242,
  runtimeProcessId: 4243,
};

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
};

const PNG_HASH = await sha256(PNG_BYTES);

const streamOutput = (sequence: number, text: string): ComputeOutput => ({
  _tag: "stream",
  sequence,
  observedAt: OBSERVED_AT,
  stream: "stdout",
  text,
});

const imageOutput: ComputeOutput = {
  _tag: "image",
  sequence: 0,
  observedAt: OBSERVED_AT,
  mediaType: "image/png",
  contentHash: PNG_HASH,
  byteLength: PNG_BYTES.byteLength,
  width: 4,
  height: 3,
};

/**
 * The scripted runtime every test drives.
 *
 * Code is a keyword rather than a program: the coordinator never looks at what
 * it forwards, so a test that had to write real Python would only be testing
 * the adapter underneath it.
 */
const script = (code: string): SimulatedComputeExecution => {
  switch (code) {
    case "hold":
      return { _tag: "runs-until-interrupted", outputs: [streamOutput(0, "working\n")] };
    case "quiet-hold":
      return { _tag: "runs-until-interrupted", outputs: [] };
    case "boom":
      return {
        _tag: "completes",
        outputs: [],
        outcome: "failed",
        runtimeError: {
          sequence: 7,
          observedAt: OBSERVED_AT,
          report: {
            name: "ZeroDivisionError",
            value: "division by zero",
            traceback: ["Traceback (most recent call last):", "ZeroDivisionError"],
          },
        },
      };
    case "figure":
      return {
        _tag: "completes",
        outputs: [imageOutput],
        outcome: "succeeded",
        imageBytes: new Map([[0, PNG_BYTES]]),
      };
    // A transport breaking its own contract: an image line with no bytes under
    // it. Scripted rather than hypothetical because a real one is a mislabelled
    // media type or a bug in a future adapter, and either would arrive here.
    case "phantom-figure":
      return { _tag: "completes", outputs: [imageOutput], outcome: "succeeded" };
    case "flood":
      return {
        _tag: "completes",
        outputs: [
          streamOutput(0, "a".repeat(40)),
          streamOutput(1, "b".repeat(40)),
          streamOutput(2, "c".repeat(40)),
        ],
        outcome: "succeeded",
      };
    case "die":
      return { _tag: "loses-runtime", reason: "The kernel exited." };
    default:
      return { _tag: "completes", outputs: [streamOutput(0, "1\n")], outcome: "succeeded" };
  }
};

const adapterFor = (readiness: ComputeRuntimeReadiness): ComputeLanguageAdapter => ({
  languageId: PYTHON,
  transportKind: BRIDGE,
  discover: () => Effect.succeed([PROFILE]),
  verify: () =>
    Effect.succeed({
      profile: PROFILE,
      readiness,
      missingRequirements: readiness === "ready" ? [] : ["ipykernel"],
      message: readiness === "ready" ? null : "Install ipykernel to use this interpreter.",
    }),
  prepareLaunch: (request) =>
    Effect.succeed({
      executable: PROFILE.executable,
      args: ["-m", "scient_bridge"],
      cwd: request.cwd,
      environment: request.environment,
    }),
  normalizeDiagnostic: (report) => [
    {
      errorName: report.name,
      message: report.value,
      traceback: report.traceback,
      frames: [],
    },
  ],
  fingerprintEnvironment: () =>
    Effect.succeed({ hash: "sha256:environment", contributors: ["executable"] }),
});

/** Reports fewer capabilities than the handshake accepted, which a session must catch. */
const withReportedCapabilities = (
  base: ComputeTransport,
  capabilities: ReadonlyArray<ComputeCapability>,
): ComputeTransport => ({
  open: (request) =>
    base.open(request).pipe(
      Effect.map((channel) => ({
        ...channel,
        events: channel.events.pipe(
          Stream.map((event) => (event._tag === "ready" ? { ...event, capabilities } : event)),
        ),
      })),
    ),
});

interface HarnessOptions {
  readonly capabilities?: ReadonlyArray<ComputeCapability>;
  readonly reportedCapabilities?: ReadonlyArray<ComputeCapability>;
  readonly readiness?: ComputeRuntimeReadiness;
  readonly service?: Partial<ComputeSessionServiceOptions>;
}

/**
 * A coordinator over a throwaway state directory and a scripted runtime.
 *
 * `use` builds and tears down the whole service, so a test can prove a fact
 * survives the process that wrote it: a second `use` over the same directory is
 * the next run of the server, with an empty registry and only the disk to go
 * on.
 */
const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-session-" });
    const submitted: Array<string> = [];
    const opened: Array<ComputeSessionId> = [];
    const simulated = createSimulatedComputeTransport({
      runtime: IDENTITY,
      capabilities: options.capabilities ?? FULL_CAPABILITIES,
      resolveExecution: (code) => {
        submitted.push(code);
        return script(code);
      },
    });
    const reported = options.reportedCapabilities;
    const base = reported === undefined ? simulated : withReportedCapabilities(simulated, reported);
    const transport: ComputeTransport = {
      open: (request) => {
        opened.push(request.sessionId);
        return base.open(request);
      },
    };
    const serviceLayer = layerWithRuntimes(
      [{ adapter: adapterFor(options.readiness ?? "ready"), transport }],
      { ...DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS, ...options.service },
    ).pipe(
      // Merged rather than provided, so a test can read the disk the
      // coordinator wrote to and check that the two agree.
      Layer.provideMerge(LocalComputeStore.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const use = <A, E>(
      body: Effect.Effect<
        A,
        E,
        | ComputeSessionService
        | LocalComputeStore.LocalComputeStore
        | FileSystem.FileSystem
        | Scope.Scope
      >,
    ) => Effect.scoped(body.pipe(Effect.provide(serviceLayer)));
    return {
      submitted: () => [...submitted],
      opened: () => [...opened],
      use,
    };
  });

const startInput = (
  overrides: Partial<ComputeStartSessionInput> = {},
): ComputeStartSessionInput => ({
  projectId: PROJECT_ID,
  sessionId: SESSION_ID,
  languageId: PYTHON,
  label: "Analysis",
  workingDirectory: process.cwd(),
  configuredExecutable: null,
  ...overrides,
});

/**
 * Runs the coordinator forward until an expectation holds.
 *
 * The scripted runtime never sleeps, so every state a test waits for is a fixed
 * number of fiber turns away rather than a duration. Yielding rather than
 * sleeping keeps the suite honest under a test clock and keeps it from passing
 * for timing reasons.
 */
const waitUntil = <A, E, R>(check: Effect.Effect<A | null, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const value = yield* check;
      if (value !== null) return value;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(
      new Error("The compute session never reached the state the test waited for."),
    );
  });

const sessionAt = (status: ComputeSessionStatus) =>
  Effect.gen(function* () {
    const service = yield* ComputeSessionService;
    const session = yield* service.getSession({ projectId: PROJECT_ID, sessionId: SESSION_ID });
    return session !== null && session.status === status ? session : null;
  });

const executionAt = (executionId: ComputeExecutionId, status: string) =>
  Effect.gen(function* () {
    const service = yield* ComputeSessionService;
    const executions = yield* service.listExecutions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    const execution = executions.find((entry) => entry.request.executionId === executionId);
    return execution?.result?.status === status ? execution : null;
  });

const submit = (
  code: string,
  id: string,
  generation = INITIAL_COMPUTE_SESSION_GENERATION,
  source: ComputeExecutionSource = { _tag: "console" },
) =>
  Effect.gen(function* () {
    const service = yield* ComputeSessionService;
    return yield* service.submitExecution({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      executionId: ComputeExecutionId.make(id),
      expectedGeneration: generation,
      code,
      source,
    });
  });

/**
 * The journal reaches disk just after the record a reader polls, so a test that
 * asserts on it waits for it rather than racing it.
 */
const journalContaining = (event: ComputeSessionJournalEvent) =>
  Effect.gen(function* () {
    const events = yield* journalEvents;
    return events.includes(event) ? events : null;
  });

const journalEvents = Effect.gen(function* () {
  const service = yield* ComputeSessionService;
  const journal = yield* service.listJournal({ projectId: PROJECT_ID, sessionId: SESSION_ID });
  return journal.map((entry) => entry.event);
});

const outputsOf = (executionId: ComputeExecutionId | null) =>
  Effect.gen(function* () {
    const service = yield* ComputeSessionService;
    return yield* service.listOutputs({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      executionId,
    });
  });

const start = Effect.gen(function* () {
  const service = yield* ComputeSessionService;
  return yield* service.startSession(startInput());
});

describe("compute session startup", () => {
  it.effect("starts a session, records it, and reports the runtime it reached", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const session = yield* start;
          expect(session.status).toBe("ready");
          expect(session.identity).toEqual(IDENTITY);
          expect(session.runtime).toEqual(PROFILE);
          expect(session.generation).toBe(INITIAL_COMPUTE_SESSION_GENERATION);
          expect(session.environmentFingerprint?.hash).toBe("sha256:environment");
          expect(session.activity).toBe("idle");
          expect(yield* journalEvents).toEqual(["session-created", "session-ready"]);

          // The record a client is handed is the record on disk, not a view
          // assembled in memory.
          const store = yield* LocalComputeStore.LocalComputeStore;
          expect(yield* store.loadSession(PROJECT_ID, SESSION_ID)).toEqual(session);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("hands back the same session for a repeated start", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const first = yield* start;
          const second = yield* start;
          expect(second).toEqual(first);
          // A second runtime for the same panel would leak a process.
          expect(test.opened()).toEqual([SESSION_ID]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects reuse of a live session id for a different start request", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* service.startSession(startInput());
          const error = yield* Effect.flip(
            service.startSession(startInput({ configuredExecutable: "/different/python" })),
          );
          expect(error.reason).toBe("session-conflict");
          expect(test.opened()).toEqual([SESSION_ID]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("admits exactly one live session per project under a simultaneous start", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const ids = [ComputeSessionId.make("session-a"), ComputeSessionId.make("session-b")];
          const outcomes = yield* Effect.forEach(
            ids,
            (sessionId) =>
              service.startSession(startInput({ sessionId })).pipe(
                Effect.map((session) => ({ _tag: "started" as const, session })),
                Effect.catch((error) => Effect.succeed({ _tag: "failed" as const, error })),
              ),
            { concurrency: "unbounded" },
          );
          const started = outcomes.flatMap((outcome) =>
            outcome._tag === "started" ? [outcome.session] : [],
          );
          const failed = outcomes.flatMap((outcome) =>
            outcome._tag === "failed" ? [outcome.error] : [],
          );
          expect(started).toHaveLength(1);
          expect(failed.map((error) => error.reason)).toEqual(["session-conflict"]);
          expect(test.opened()).toHaveLength(1);

          const winner = started[0]!;
          yield* service.stopSession({
            projectId: PROJECT_ID,
            sessionId: winner.sessionId,
            expectedGeneration: winner.generation,
          });
          const next = yield* service.startSession(
            startInput({ sessionId: ComputeSessionId.make("session-c") }),
          );
          expect(next.status).toBe("ready");
          expect(test.opened()).toHaveLength(2);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a language nothing is registered for", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const error = yield* Effect.flip(
            service.startSession(startInput({ languageId: ComputeLanguageId.make("r") })),
          );
          expect(error.reason).toBe("runtime-missing");
          expect(error.message).toContain("'r'");
          expect(test.opened()).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a runtime verification says cannot be used, in its own words", () =>
    Effect.gen(function* () {
      const test = yield* harness({ readiness: "missing-requirement" });

      yield* test.use(
        Effect.gen(function* () {
          const error = yield* Effect.flip(start);
          expect(error.reason).toBe("runtime-unusable");
          expect(error.message).toBe("Install ipykernel to use this interpreter.");
          expect(test.opened()).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a transport that will not shake hands", () =>
    Effect.gen(function* () {
      const test = yield* harness({ capabilities: ["execute"] });

      yield* test.use(
        Effect.gen(function* () {
          const error = yield* Effect.flip(start);
          expect(error.reason).toBe("transport-failed");
          expect(error.message).toContain("interrupt");
          // Nothing was written, because nothing was ever running.
          const store = yield* LocalComputeStore.LocalComputeStore;
          expect(yield* store.loadSession(PROJECT_ID, SESSION_ID)).toBeNull();
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails a session whose runtime reports it cannot do what a session needs", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reportedCapabilities: ["execute", "restart", "shutdown"] });

      yield* test.use(
        Effect.gen(function* () {
          const error = yield* Effect.flip(start);
          expect(error.reason).toBe("capability-missing");
          expect(error.message).toContain("interrupt");
          const session = yield* waitUntil(sessionAt("failed"));
          expect(session.status).toBe("failed");
          // A session that failed is not then also lost: the first ending is
          // the only one, however the runtime's stream ends afterwards.
          expect(yield* journalEvents).toEqual(["session-created", "session-failed"]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to reuse the name of a session that has ended", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* service.stopSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: session.generation,
          });

          const error = yield* Effect.flip(start);
          expect(error.reason).toBe("session-terminal");
          expect(test.opened()).toEqual([SESSION_ID]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session execution", () => {
  it.effect("runs code, keeps its transcript, and records how it ended", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          const submitted = yield* submit("print(1)", "execution-1");
          // Nothing was ahead of it, so by the time the call returns it is on
          // its way to the runtime rather than waiting to be.
          expect(submitted.result?.status).toBe("submitting");
          expect(submitted.request.codeHash).toMatch(/^sha256:[0-9a-f]{64}$/);

          const finished = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "succeeded"),
          );
          expect(finished.result?.outcome).toBe("succeeded");
          expect(finished.result?.outputCount).toBe(1);
          expect(finished.result?.outputBytes).toBe(2);
          expect(finished.result?.truncated).toBe(false);
          expect(finished.result?.startedAt).not.toBeNull();
          expect(finished.result?.finishedAt).not.toBeNull();
          expect(finished.result?.queuePosition).toBeNull();

          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.corruptLineCount).toBe(0);
          expect(transcript.outputs).toEqual([streamOutput(0, "1\n")]);

          expect(yield* journalEvents).toEqual([
            "session-created",
            "session-ready",
            "execution-submitted",
            "execution-started",
            "execution-finished",
          ]);
          const session = yield* waitUntil(
            Effect.gen(function* () {
              const current = yield* sessionAt("ready");
              return current?.activity === "idle" ? current : null;
            }),
          );
          expect(session.activity).toBe("idle");
          expect(session.activeExecutionId).toBeNull();
          expect(session.pendingCount).toBe(0);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("queues a second submission behind the first and says where it is", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("hold", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "running"));
          const queued = yield* submit("print(1)", "execution-2");

          expect(queued.result?.status).toBe("queued");
          expect(queued.result?.queuePosition).toBe(1);
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.activity).toBe("busy");
          expect(session.activeExecutionId).toBe(ComputeExecutionId.make("execution-1"));
          expect(session.pendingCount).toBe(1);
          // Only the running execution ever reached the runtime.
          expect(test.submitted()).toEqual(["hold"]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("cancels a queued execution without sending it to the runtime", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* submit("hold", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "running"));
          yield* submit("print(1)", "execution-2");

          const cancelled = yield* service.cancelExecution({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: ComputeExecutionId.make("execution-2"),
            expectedGeneration: session.generation,
          });
          expect(cancelled.result?.status).toBe("cancelled");
          expect(cancelled.result?.outcome).toBe("cancelled");
          expect(test.submitted()).toEqual(["hold"]);
          const current = yield* waitUntil(sessionAt("ready"));
          expect(current.pendingCount).toBe(0);
          expect(current.activeExecutionId).toBe(ComputeExecutionId.make("execution-1"));
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("interrupts the running execution and then runs what was waiting", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* submit("hold", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "running"));
          yield* submit("print(1)", "execution-2");

          yield* service.cancelExecution({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: ComputeExecutionId.make("execution-1"),
            expectedGeneration: session.generation,
          });

          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "cancelled"));
          // The queue moves on by itself; nothing has to ask it to.
          const second = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-2"), "succeeded"),
          );
          expect(second.result?.outputCount).toBe(1);
          expect(test.submitted()).toEqual(["hold", "print(1)"]);
          // What the interrupted execution produced before it stopped is kept.
          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toEqual([streamOutput(0, "working\n")]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("interrupting an idle session is not an error", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          const current = yield* service.interruptSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: session.generation,
          });
          expect(current.status).toBe("ready");
          expect(current.activity).toBe("idle");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("records a runtime error where it happened and names the failure", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("boom", "execution-1");

          const failed = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "failed"),
          );
          expect(failed.result?.outcome).toBe("failed");
          expect(failed.result?.failureReason).toBe("ZeroDivisionError: division by zero");
          expect(failed.result?.diagnostics).toEqual([
            {
              errorName: "ZeroDivisionError",
              message: "division by zero",
              traceback: ["Traceback (most recent call last):", "ZeroDivisionError"],
              frames: [],
            },
          ]);

          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          // The diagnostic sits at the sequence the runtime reported, so it
          // reads where the failure actually happened.
          expect(transcript.outputs).toEqual([
            {
              _tag: "diagnostic",
              sequence: 7,
              observedAt: OBSERVED_AT,
              diagnostic: {
                errorName: "ZeroDivisionError",
                message: "division by zero",
                traceback: ["Traceback (most recent call last):", "ZeroDivisionError"],
                frames: [],
              },
            },
          ]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("applies output ceilings to runtime diagnostics", () =>
    Effect.gen(function* () {
      const test = yield* harness({ service: { maximumExecutionOutputBytes: 8 } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("boom", "execution-1");
          const failed = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "failed"),
          );
          expect(failed.result?.truncated).toBe(true);
          expect(failed.result?.diagnostics).toEqual([]);
          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toHaveLength(1);
          expect(transcript.outputs[0]).toMatchObject({
            _tag: "system",
            event: "output-truncated",
            sequence: 7,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stores image bytes so the line that names them can be resolved", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* start;
          yield* submit("figure", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));

          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toEqual([imageOutput]);

          const resolved = yield* service.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: ComputeExecutionId.make("execution-1"),
            contentHash: PNG_HASH,
          });
          expect(resolved?.byteLength).toBe(PNG_BYTES.byteLength);
          expect(resolved?.mediaType).toBe("image/png");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses an image line whose bytes never arrived", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* start;
          yield* submit("phantom-figure", "execution-1");
          const finished = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "succeeded"),
          );

          // The execution still succeeded -- the code ran -- but the transcript
          // holds a visible marker rather than a line pointing at an image that
          // was never stored, and it says it is incomplete.
          expect(finished.result?.truncated).toBe(true);
          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toHaveLength(1);
          expect(transcript.outputs[0]).toMatchObject({
            _tag: "system",
            event: "output-truncated",
            sequence: imageOutput.sequence,
          });

          const resolved = yield* service.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: ComputeExecutionId.make("execution-1"),
            contentHash: PNG_HASH,
          });
          expect(resolved).toBeNull();
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stops keeping output once an execution reaches its ceiling, and says so", () =>
    Effect.gen(function* () {
      const test = yield* harness({ service: { maximumExecutionOutputBytes: 60 } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("flood", "execution-1");

          // The execution still succeeds: a retention ceiling is a limit on
          // what is kept, not on what the user's code may do.
          const finished = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "succeeded"),
          );
          expect(finished.result?.truncated).toBe(true);

          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toHaveLength(2);
          expect(transcript.outputs[0]).toEqual(streamOutput(0, "a".repeat(40)));
          // The marker takes the dropped output's own place in the transcript,
          // and only one is written however much follows it.
          expect(transcript.outputs[1]).toMatchObject({
            _tag: "system",
            event: "output-truncated",
            sequence: 1,
            observedAt: OBSERVED_AT,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stops keeping output once a session reaches its ceiling, across executions", () =>
    Effect.gen(function* () {
      // Two bytes of output each, so the first execution fits and the second is
      // what crosses a ceiling neither of them could cross alone.
      const test = yield* harness({ service: { maximumSessionOutputBytes: 3 } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("print(1)", "execution-1");
          const first = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "succeeded"),
          );
          expect(first.result?.truncated).toBe(false);
          expect((yield* outputsOf(ComputeExecutionId.make("execution-1"))).outputs).toEqual([
            streamOutput(0, "1\n"),
          ]);

          yield* submit("print(1)", "execution-2");
          const second = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-2"), "succeeded"),
          );
          // The execution still ran and still succeeded; what it said was not
          // kept, and its own record says so rather than only the session's.
          expect(second.result?.truncated).toBe(true);

          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-2"));
          expect(transcript.outputs).toHaveLength(1);
          expect(transcript.outputs[0]).toMatchObject({
            _tag: "system",
            event: "output-truncated",
            sequence: 0,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps the session output ceiling spent across a runtime restart", () =>
    Effect.gen(function* () {
      const test = yield* harness({ service: { maximumSessionOutputBytes: 3 } });

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const original = yield* start;
          yield* submit("print(1)", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));
          const restarted = yield* service.restartSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: original.generation,
          });
          yield* submit("print(1)", "execution-2", restarted.generation);
          const second = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-2"), "succeeded"),
          );
          expect(second.result?.truncated).toBe(true);
          expect(
            (yield* outputsOf(ComputeExecutionId.make("execution-2"))).outputs[0],
          ).toMatchObject({ _tag: "system", event: "output-truncated" });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses more work than the queue can hold, and records the refusal", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("quiet-hold", "execution-0");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-0"), "running"));
          for (let index = 0; index < MAXIMUM_PENDING_COMPUTE_EXECUTIONS; index += 1) {
            yield* submit("print(1)", `execution-${index + 1}`);
          }

          const error = yield* Effect.flip(submit("print(1)", "execution-overflow"));
          expect(error.reason).toBe("queue-full");
          expect(yield* journalEvents).toContain("queue-rejected");
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.pendingCount).toBe(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns the same execution for a repeated submission", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("quiet-hold", "execution-0");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-0"), "running"));
          const first = yield* submit("print(1)", "execution-1");
          const second = yield* submit("print(1)", "execution-1");
          expect(second.request.submittedAt).toBe(first.request.submittedAt);
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.pendingCount).toBe(1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a finished execution id immutable and idempotent", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          const first = yield* submit("print(1)", "execution-1");
          const finished = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "succeeded"),
          );
          const retried = yield* submit("print(1)", "execution-1");
          expect(retried).toEqual(finished);
          expect(retried.request.submittedAt).toBe(first.request.submittedAt);
          expect(test.submitted()).toEqual(["print(1)"]);

          const conflict = yield* Effect.flip(submit("print(2)", "execution-1"));
          expect(conflict.reason).toBe("execution-conflict");
          expect(test.submitted()).toEqual(["print(1)"]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats submitted source provenance as part of execution identity", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          const savedSource = {
            _tag: "document",
            origin: "selection",
            path: "analysis.py",
            bufferState: "saved",
            revision: "sha256:saved",
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 },
          } satisfies Extract<ComputeExecutionSource, { readonly _tag: "document" }>;
          const dirtySource = {
            ...savedSource,
            bufferState: "dirty" as const,
            revision: "sha256:editor-base",
          };

          yield* submit("print(1)", "execution-1", INITIAL_COMPUTE_SESSION_GENERATION, savedSource);
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));

          const conflict = yield* Effect.flip(
            submit("print(1)", "execution-1", INITIAL_COMPUTE_SESSION_GENERATION, dirtySource),
          );
          expect(conflict.reason).toBe("execution-conflict");
          expect(test.submitted()).toEqual(["print(1)"]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session generations", () => {
  it.effect("restarts into a new generation, clears the queue, and keeps the history", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* submit("print(1)", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));
          yield* submit("hold", "execution-2");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-2"), "running"));
          yield* submit("print(1)", "execution-3");

          const restarted = yield* service.restartSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: session.generation,
          });
          expect(restarted.status).toBe("ready");
          expect(restarted.generation).toBe(session.generation + 1);
          expect(restarted.activeExecutionId).toBeNull();
          expect(restarted.pendingCount).toBe(0);

          // What was waiting never ran, because it was written for a namespace
          // that no longer exists.
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-3"), "cancelled"));
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-2"), "cancelled"));
          expect(test.submitted()).toEqual(["print(1)", "hold"]);

          // The history of the generation that ended is still the session's.
          const succeeded = yield* executionAt(ComputeExecutionId.make("execution-1"), "succeeded");
          expect(succeeded).not.toBeNull();
          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toEqual([streamOutput(0, "1\n")]);
          expect(yield* journalEvents).toContain("session-restarted");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses every mutating command that names a generation that has been replaced", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          const stale = session.generation;
          yield* service.restartSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: stale,
          });

          const sessionCommand = {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: stale,
          };
          const errors = [
            yield* Effect.flip(submit("print(1)", "execution-1", stale)),
            yield* Effect.flip(
              service.cancelExecution({
                ...sessionCommand,
                executionId: ComputeExecutionId.make("execution-1"),
              }),
            ),
            yield* Effect.flip(service.interruptSession(sessionCommand)),
            yield* Effect.flip(service.restartSession(sessionCommand)),
            yield* Effect.flip(service.stopSession(sessionCommand)),
          ];
          expect(errors.map((error) => error.reason)).toEqual([
            "generation-stale",
            "generation-stale",
            "generation-stale",
            "generation-stale",
            "generation-stale",
          ]);
          expect(errors[0]?.operation).toBe("submit");
          // Refusing is not the same as breaking: the session is still usable.
          const current = yield* waitUntil(sessionAt("ready"));
          expect(current.generation).toBe(stale + 1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session endings", () => {
  it.effect("stops a session, measures what it left behind, and refuses later commands", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* submit("print(1)", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));

          const stopped = yield* service.stopSession({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: session.generation,
          });
          expect(stopped.status).toBe("stopped");
          expect(stopped.closedAt).not.toBeNull();
          expect(stopped.lostReason).toBeNull();
          expect(stopped.storage.totalBytes).toBeGreaterThan(0);
          expect(yield* journalEvents).toContain("session-stopping");
          expect(yield* journalEvents).toContain("session-stopped");

          const error = yield* Effect.flip(submit("print(1)", "execution-2"));
          expect(error.reason).toBe("session-terminal");
          // A stopped session is still readable; only its runtime is gone.
          const transcript = yield* outputsOf(ComputeExecutionId.make("execution-1"));
          expect(transcript.outputs).toEqual([streamOutput(0, "1\n")]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("records a lost runtime and everything it was running", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("die", "execution-1");

          const lost = yield* waitUntil(sessionAt("lost"));
          expect(lost.lostReason).toBe("The kernel exited.");
          expect(lost.closedAt).not.toBeNull();
          expect(lost.activeExecutionId).toBeNull();
          const execution = yield* waitUntil(
            executionAt(ComputeExecutionId.make("execution-1"), "lost"),
          );
          expect(execution.result?.outcome).toBeNull();
          expect(execution.result?.failureReason).toBe("The kernel exited.");
          yield* waitUntil(journalContaining("session-lost"));
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stops a live session when the service itself goes away", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(start);

      // A second lifetime finds a stopped session rather than an orphan to
      // recover, because the first one closed its own runtimes.
      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const sessions = yield* service.listSessions({ projectId: PROJECT_ID });
          expect(sessions).toHaveLength(1);
          expect(sessions[0]?.status).toBe("stopped");
          expect(sessions[0]?.lostReason).toBeNull();
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stops a session that has been idle longer than it is allowed to be", () =>
    Effect.gen(function* () {
      const test = yield* harness({ service: { idleTimeoutMs: 60_000 } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* TestClock.adjust("60 seconds");
          const stopped = yield* waitUntil(sessionAt("stopped"));
          expect(stopped.closedAt).not.toBeNull();
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("leaves a busy session alone however long it has been running", () =>
    Effect.gen(function* () {
      const test = yield* harness({ service: { idleTimeoutMs: 60_000 } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("quiet-hold", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "running"));
          yield* TestClock.adjust("10 minutes");
          const session = yield* sessionAt("ready");
          expect(session?.activity).toBe("busy");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session recovery", () => {
  it.effect("reports what a previous run left behind as lost, and replays none of it", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      // A crash, written the only way it can be observed: records that never
      // reached a terminal status.
      yield* test.use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore.LocalComputeStore;
          const interrupted: ComputeSessionRecord = {
            sessionId: SESSION_ID,
            projectId: PROJECT_ID,
            label: "Analysis",
            languageId: PYTHON,
            transportKind: BRIDGE,
            workingDirectory: process.cwd(),
            runtime: PROFILE,
            identity: IDENTITY,
            environmentFingerprint: null,
            generation: INITIAL_COMPUTE_SESSION_GENERATION,
            status: "ready",
            activity: "busy",
            activeExecutionId: ComputeExecutionId.make("execution-1"),
            pendingCount: 1,
            storage: {
              status: "retained",
              outputBytes: 0,
              imageBytes: 0,
              totalBytes: 0,
              removedAt: null,
            },
            createdAt: OBSERVED_AT,
            lastActivityAt: OBSERVED_AT,
            closedAt: null,
            lostReason: null,
          };
          yield* store.writeSession(interrupted);
          for (const [executionId, status] of [
            ["execution-1", "running"],
            ["execution-2", "queued"],
          ] as const) {
            yield* store.writeExecutionRequest(PROJECT_ID, {
              executionId: ComputeExecutionId.make(executionId),
              sessionId: SESSION_ID,
              generation: INITIAL_COMPUTE_SESSION_GENERATION,
              code: "hold",
              codeHash: "sha256:hold",
              source: { _tag: "console" },
              submittedAt: OBSERVED_AT,
              environmentFingerprint: null,
            });
            yield* store.writeExecutionResult(PROJECT_ID, SESSION_ID, {
              executionId: ComputeExecutionId.make(executionId),
              status,
              outcome: null,
              queuePosition: status === "queued" ? 1 : null,
              startedAt: status === "running" ? OBSERVED_AT : null,
              finishedAt: null,
              diagnostics: [],
              outputCount: 0,
              imageCount: 0,
              outputBytes: 0,
              truncated: false,
              failureReason: null,
            });
          }
          yield* store.appendOutputs({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: ComputeExecutionId.make("execution-1"),
            outputs: [streamOutput(0, "working\n")],
          });
        }),
      );

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const sessions = yield* service.listSessions({ projectId: PROJECT_ID });
          expect(sessions).toHaveLength(1);
          expect(sessions[0]?.status).toBe("lost");
          expect(sessions[0]?.lostReason).toBe(
            "The server restarted while this session was running.",
          );
          expect(sessions[0]?.activeExecutionId).toBeNull();
          expect(sessions[0]?.pendingCount).toBe(0);
          expect(sessions[0]?.closedAt).not.toBeNull();

          const executions = yield* service.listExecutions({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
          });
          const byId = new Map(
            executions.map((execution) => [execution.request.executionId, execution] as const),
          );
          // What was in flight is lost; what was still waiting never ran.
          expect(byId.get(ComputeExecutionId.make("execution-1"))?.result).toMatchObject({
            status: "lost",
            outcome: null,
            failureReason: "The server restarted while this session was running.",
            // Counted from the transcript rather than trusted from a result
            // file that was being written when the server stopped.
            outputCount: 1,
            outputBytes: 8,
          });
          expect(byId.get(ComputeExecutionId.make("execution-2"))?.result).toMatchObject({
            status: "cancelled",
            outcome: "cancelled",
            queuePosition: null,
          });
          expect(yield* journalEvents).toEqual(["session-recovered"]);

          // The only thing worse than telling a user their code did not run is
          // running it again without being asked.
          expect(test.submitted()).toEqual([]);
          expect(test.opened()).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers a project once, however many readers ask", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore.LocalComputeStore;
          yield* store.writeSession({
            sessionId: SESSION_ID,
            projectId: PROJECT_ID,
            label: "Analysis",
            languageId: PYTHON,
            transportKind: BRIDGE,
            workingDirectory: process.cwd(),
            runtime: null,
            identity: null,
            environmentFingerprint: null,
            generation: INITIAL_COMPUTE_SESSION_GENERATION,
            status: "starting",
            activity: "idle",
            activeExecutionId: null,
            pendingCount: 0,
            storage: {
              status: "retained",
              outputBytes: 0,
              imageBytes: 0,
              totalBytes: 0,
              removedAt: null,
            },
            createdAt: OBSERVED_AT,
            lastActivityAt: OBSERVED_AT,
            closedAt: null,
            lostReason: null,
          });
        }),
      );

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* Effect.all(
            [
              service.listSessions({ projectId: PROJECT_ID }),
              service.listSessions({ projectId: PROJECT_ID }),
              service.getSession({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
            ],
            { concurrency: "unbounded" },
          );
          // One scan, so one recovery entry: a second would claim the session
          // was lost twice.
          expect(yield* journalEvents).toEqual(["session-recovered"]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session subscriptions", () => {
  it.effect("hands a subscriber a snapshot and then only its own project's events", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const events = yield* service.subscribeSessions({ projectId: PROJECT_ID });

          // A subscription buffers from the moment it is opened, so what
          // happens next is what a live client would have been sent.
          yield* service.startSession(
            startInput({
              projectId: OTHER_PROJECT_ID,
              sessionId: ComputeSessionId.make("session-other"),
            }),
          );
          yield* start;

          const observed = Array.from(yield* events.pipe(Stream.take(2), Stream.runCollect));
          // Another project's session is not this subscriber's business, so the
          // first two events it sees are its own session starting.
          expect(
            observed.map((event) =>
              event._tag === "session-updated" ? event.session.status : event._tag,
            ),
          ).toEqual(["starting", "ready"]);
          for (const event of observed) {
            expect(event._tag === "session-updated" ? event.session.projectId : null).toBe(
              PROJECT_ID,
            );
          }
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("opens a subscription with everything the project already has", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* start;
          const events = yield* service.subscribeSessions({ projectId: PROJECT_ID });
          const snapshot = Array.from(yield* events.pipe(Stream.take(1), Stream.runCollect));
          expect(snapshot).toHaveLength(1);
          const first = snapshot[0];
          expect(first?._tag).toBe("session-snapshot");
          if (first?._tag === "session-snapshot") {
            expect(first.session.sessionId).toBe(SESSION_ID);
            expect(first.session.status).toBe("ready");
          }
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute session reads", () => {
  it.effect("inspects only an idle live namespace at its current generation", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          expect(
            yield* service.inspectVariables({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              expectedGeneration: session.generation,
            }),
          ).toEqual({ generation: session.generation, variables: [], truncated: false });

          const stale = yield* Effect.flip(
            service.inspectVariables({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              expectedGeneration: nextComputeSessionGeneration(session.generation),
            }),
          );
          expect(stale.reason).toBe("generation-stale");

          yield* submit("quiet-hold", "variables-busy");
          yield* waitUntil(executionAt(ComputeExecutionId.make("variables-busy"), "running"));
          const busy = yield* Effect.flip(
            service.inspectVariables({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              expectedGeneration: session.generation,
            }),
          );
          expect(busy.reason).toBe("session-not-running");
          expect(busy.message).toContain("after the running code finishes");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps variable inspection optional for runtimes without the capability", () =>
    Effect.gen(function* () {
      const test = yield* harness({
        capabilities: FULL_CAPABILITIES.filter((one) => one !== "variables"),
      });

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          const failure = yield* Effect.flip(
            service.inspectVariables({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              expectedGeneration: session.generation,
            }),
          );
          expect(failure.reason).toBe("capability-missing");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("answers for a session that was never started", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          expect(yield* service.listSessions({ projectId: PROJECT_ID })).toEqual([]);
          expect(
            yield* service.getSession({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
          ).toBeNull();
          expect(
            yield* service.listExecutions({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
          ).toEqual([]);
          const error = yield* Effect.flip(
            service.interruptSession({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            }),
          );
          expect(error.reason).toBe("session-not-found");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a session's own output apart from any execution's", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("print(1)", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));
          const sessionScoped = yield* outputsOf(null);
          expect(sessionScoped.outputs).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports an execution that has already finished as finished", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const session = yield* start;
          yield* submit("print(1)", "execution-1");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-1"), "succeeded"));

          const command = {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            expectedGeneration: session.generation,
          };
          const finished = yield* Effect.flip(
            service.cancelExecution({
              ...command,
              executionId: ComputeExecutionId.make("execution-1"),
            }),
          );
          expect(finished.reason).toBe("execution-already-finished");
          const missing = yield* Effect.flip(
            service.cancelExecution({
              ...command,
              executionId: ComputeExecutionId.make("execution-nowhere"),
            }),
          );
          expect(missing.reason).toBe("execution-not-found");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

/**
 * The load this coordinator will actually meet.
 *
 * Each of these has a cheap wrong answer that a happy-path test cannot see: a
 * publisher that blocks, a queue that over-admits under a race, a transcript
 * that grows past what it promised to keep, a recovery that handles one session
 * because it was only ever shown one. So each test asserts the answer rather
 * than that nothing threw.
 */
describe("compute session under load", () => {
  it.effect("keeps running while a subscriber never reads a thing", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          yield* start;
          // Subscribed and deliberately never consumed: a background window, a
          // paused renderer, a socket that stopped draining. Publishing runs on
          // the fiber draining the runtime, so if a subscriber's buffer can
          // apply backpressure, this client stops every session on the server.
          yield* service.subscribeSessions({ projectId: PROJECT_ID }).pipe(Effect.asVoid);

          // Far more events than any per-subscriber buffer would hold.
          for (let index = 0; index < 200; index += 1) {
            const executionId = ComputeExecutionId.make(`flood-${index}`);
            yield* submit("flood", executionId);
            yield* waitUntil(executionAt(executionId, "succeeded"));
          }

          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.activity).toBe("idle");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("tells a subscriber that reads late everything it missed, in order", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const events = yield* service.subscribeSessions({ projectId: PROJECT_ID });
          yield* start;

          const count = 40;
          for (let index = 0; index < count; index += 1) {
            const executionId = ComputeExecutionId.make(`late-${index}`);
            yield* submit("flood", executionId);
            yield* waitUntil(executionAt(executionId, "succeeded"));
          }

          const lastId = ComputeExecutionId.make(`late-${count - 1}`);
          const observed = yield* events.pipe(
            Stream.takeUntil(
              (event) =>
                event._tag === "execution-updated" &&
                event.execution.request.executionId === lastId &&
                event.execution.result?.status === "succeeded",
            ),
            Stream.runCollect,
          );

          // Nothing reordered and nothing dropped: a transcript is built from
          // deltas, so a missing `execution-output` is a transcript that is
          // quietly wrong rather than one that is merely late.
          const sequences = observed.map((event) => event.eventSequence);
          expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
          expect(new Set(sequences).size).toBe(sequences.length);

          const succeeded = new Set(
            observed.flatMap((event) =>
              event._tag === "execution-updated" && event.execution.result?.status === "succeeded"
                ? [event.execution.request.executionId as string]
                : [],
            ),
          );
          expect(succeeded.size).toBe(count);
          const outputChunks = observed.flatMap((event) =>
            event._tag === "execution-output" ? [...event.outputs] : [],
          );
          expect(outputChunks.length).toBe(count * 3);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps many sessions in many projects apart", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const projects = Array.from({ length: 12 }, (_, index) =>
            ComputeProjectId.make(`load-project-${index}`),
          );
          const plan = projects.map((projectId) => ({
            projectId,
            sessionId: ComputeSessionId.make(`${projectId}-session`),
            executionId: ComputeExecutionId.make(`${projectId}-execution`),
          }));

          // Started and driven at once, because a per-session lock that is
          // really a per-service lock only shows up when they overlap.
          yield* Effect.forEach(
            plan,
            (entry) =>
              Effect.gen(function* () {
                const session = yield* service.startSession(
                  startInput({ projectId: entry.projectId, sessionId: entry.sessionId }),
                );
                yield* service.submitExecution({
                  projectId: entry.projectId,
                  sessionId: entry.sessionId,
                  executionId: entry.executionId,
                  expectedGeneration: session.generation,
                  code: "flood",
                  source: { _tag: "console" },
                });
              }),
            { concurrency: "unbounded" },
          );

          for (const entry of plan) {
            const executions = yield* waitUntil(
              Effect.gen(function* () {
                const found = yield* service.listExecutions({
                  projectId: entry.projectId,
                  sessionId: entry.sessionId,
                });
                return found.length > 0 && found.every((one) => one.result?.status === "succeeded")
                  ? found
                  : null;
              }),
            );
            // Exactly its own work, and only its own: a session that saw a
            // neighbour's execution would be a coordinator keyed too loosely.
            expect(executions.map((one) => one.request.executionId)).toEqual([entry.executionId]);
            const transcript = yield* service.listOutputs({
              projectId: entry.projectId,
              sessionId: entry.sessionId,
              executionId: entry.executionId,
            });
            expect(transcript.outputs).toHaveLength(3);
          }

          for (const projectId of projects) {
            const sessions = yield* service.listSessions({ projectId });
            expect(sessions).toHaveLength(1);
          }
          expect(test.opened()).toHaveLength(plan.length);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("admits exactly a queue's worth from a simultaneous burst", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          yield* submit("quiet-hold", "execution-blocking");
          yield* waitUntil(executionAt(ComputeExecutionId.make("execution-blocking"), "running"));

          const overflow = 8;
          const ids = Array.from(
            { length: MAXIMUM_PENDING_COMPUTE_EXECUTIONS + overflow },
            (_, index) => `burst-${index}`,
          );
          // All at once, so an admission check that reads the queue and then
          // writes it across a yield point would over-admit here.
          const outcomes = yield* Effect.forEach(
            ids,
            (id) =>
              submit("quiet-hold", id).pipe(
                Effect.map(() => "accepted" as const),
                Effect.catch((error) => Effect.succeed(error.reason)),
              ),
            { concurrency: "unbounded" },
          );

          const accepted = outcomes.filter((outcome) => outcome === "accepted");
          expect(accepted).toHaveLength(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
          expect(outcomes.filter((outcome) => outcome === "queue-full")).toHaveLength(overflow);
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.pendingCount).toBe(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a session's transcript inside its ceiling however much it produces", () =>
    Effect.gen(function* () {
      // A hundred executions of 120 bytes each against a 500 byte ceiling: the
      // ceiling is crossed early and then run at for a long time, which is when
      // an off-by-one in the accounting compounds instead of cancelling out.
      const ceiling = 500;
      const test = yield* harness({ service: { maximumSessionOutputBytes: ceiling } });

      yield* test.use(
        Effect.gen(function* () {
          yield* start;
          const count = 100;
          for (let index = 0; index < count; index += 1) {
            const executionId = ComputeExecutionId.make(`bounded-${index}`);
            yield* submit("flood", executionId);
            yield* waitUntil(executionAt(executionId, "succeeded"));
          }

          let keptBytes = 0;
          let markers = 0;
          for (let index = 0; index < count; index += 1) {
            const transcript = yield* outputsOf(ComputeExecutionId.make(`bounded-${index}`));
            for (const output of transcript.outputs) {
              if (output._tag === "stream") keptBytes += Buffer.byteLength(output.text, "utf8");
              if (output._tag === "system" && output.event === "output-truncated") markers += 1;
            }
          }

          expect(keptBytes).toBeLessThanOrEqual(ceiling);
          // Every execution past the ceiling says so once, rather than once per
          // chunk it dropped.
          expect(markers).toBeGreaterThan(0);
          expect(markers).toBeLessThanOrEqual(count);
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.storage.outputBytes).toBeLessThanOrEqual(ceiling);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports every session a previous run left behind, not just the first", () =>
    Effect.gen(function* () {
      const test = yield* harness();
      const count = 12;
      const crashed = (index: number): ComputeSessionRecord => ({
        sessionId: ComputeSessionId.make(`crashed-${index}`),
        projectId: PROJECT_ID,
        label: "Analysis",
        languageId: PYTHON,
        transportKind: BRIDGE,
        workingDirectory: process.cwd(),
        runtime: PROFILE,
        identity: IDENTITY,
        environmentFingerprint: null,
        generation: INITIAL_COMPUTE_SESSION_GENERATION,
        status: "ready",
        activity: "busy",
        activeExecutionId: ComputeExecutionId.make(`crashed-${index}-running`),
        pendingCount: 1,
        storage: {
          status: "retained",
          outputBytes: 0,
          imageBytes: 0,
          totalBytes: 0,
          removedAt: null,
        },
        createdAt: OBSERVED_AT,
        lastActivityAt: OBSERVED_AT,
        closedAt: null,
        lostReason: null,
      });

      yield* test.use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore.LocalComputeStore;
          for (let index = 0; index < count; index += 1) {
            const session = crashed(index);
            yield* store.writeSession(session);
            for (const [suffix, status] of [
              ["running", "running"],
              ["queued", "queued"],
            ] as const) {
              const executionId = ComputeExecutionId.make(`crashed-${index}-${suffix}`);
              yield* store.writeExecutionRequest(PROJECT_ID, {
                executionId,
                sessionId: session.sessionId,
                generation: INITIAL_COMPUTE_SESSION_GENERATION,
                code: "hold",
                codeHash: "sha256:hold",
                source: { _tag: "console" },
                submittedAt: OBSERVED_AT,
                environmentFingerprint: null,
              });
              yield* store.writeExecutionResult(PROJECT_ID, session.sessionId, {
                executionId,
                status,
                outcome: null,
                queuePosition: status === "queued" ? 1 : null,
                startedAt: status === "running" ? OBSERVED_AT : null,
                finishedAt: null,
                diagnostics: [],
                outputCount: 0,
                imageCount: 0,
                outputBytes: 0,
                truncated: false,
                failureReason: null,
              });
            }
          }
        }),
      );

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const sessions = yield* service.listSessions({ projectId: PROJECT_ID });
          expect(sessions).toHaveLength(count);
          for (const session of sessions) {
            expect(session.status).toBe("lost");
            expect(session.activeExecutionId).toBeNull();
            expect(session.pendingCount).toBe(0);
            const executions = yield* service.listExecutions({
              projectId: PROJECT_ID,
              sessionId: session.sessionId,
            });
            expect(executions.map((one) => one.result?.status).sort()).toEqual([
              "cancelled",
              "lost",
            ]);
          }
          // Recovery reads what is there; it never runs any of it again.
          expect(test.submitted()).toEqual([]);
          expect(test.opened()).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stays usable through a storm of interrupts and restarts", () =>
    Effect.gen(function* () {
      const test = yield* harness();

      yield* test.use(
        Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          let generation = (yield* start).generation;

          for (let round = 0; round < 24; round += 1) {
            const executionId = ComputeExecutionId.make(`storm-${round}`);
            yield* submit("hold", executionId, generation);
            yield* waitUntil(executionAt(executionId, "running"));
            if (round % 4 === 3) {
              const restarted = yield* service.restartSession({
                projectId: PROJECT_ID,
                sessionId: SESSION_ID,
                expectedGeneration: generation,
              });
              expect(restarted.generation).toBe(generation + 1);
              generation = restarted.generation;
            } else {
              yield* service.interruptSession({
                projectId: PROJECT_ID,
                sessionId: SESSION_ID,
                expectedGeneration: generation,
              });
            }
            yield* waitUntil(executionAt(executionId, "cancelled"));
          }

          // Six restarts, and the session is still the same session: ready,
          // idle, nothing left running, and its whole history still readable.
          const session = yield* waitUntil(sessionAt("ready"));
          expect(session.generation).toBe(INITIAL_COMPUTE_SESSION_GENERATION + 6);
          expect(session.activity).toBe("idle");
          expect(session.activeExecutionId).toBeNull();
          expect(session.pendingCount).toBe(0);

          const executions = yield* service.listExecutions({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
          });
          expect(executions).toHaveLength(24);
          expect(executions.every((one) => one.result?.status === "cancelled")).toBe(true);

          // Still takes work afterwards, which is the point of surviving.
          yield* submit("print(1)", "storm-after", generation);
          const after = yield* waitUntil(
            executionAt(ComputeExecutionId.make("storm-after"), "succeeded"),
          );
          expect(after.result?.outputCount).toBe(1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
