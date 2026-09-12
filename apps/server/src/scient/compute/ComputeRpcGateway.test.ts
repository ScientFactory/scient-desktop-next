import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
} from "@scientfactory/compute";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { extractComputeSourceRange, makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import { PYTHON_DATA_AND_FIGURES_TOOLKIT, assessPythonToolkit } from "./PythonToolkitCatalog.ts";

const PYTHON = ComputeLanguageId.make("python");
const PROFILE = {
  languageId: PYTHON,
  source: "path" as const,
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Python 3.12.0",
};
const DESCRIPTOR = {
  languageId: PYTHON,
  displayName: "Python",
  sourceExtensions: [".py"],
  capabilities: ["execute", "interrupt", "restart", "shutdown", "variables"] as const,
};

type GatewayCompute = Parameters<typeof makeComputeRpcGateway>[0]["compute"];
type GatewayWorkspace = Parameters<typeof makeComputeRpcGateway>[0]["workspaceFileSystem"];

function workspace(contents = "", revision = "sha256:test"): GatewayWorkspace {
  return {
    readFile: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents,
        byteLength: new TextEncoder().encode(contents).byteLength,
        truncated: false,
        revision,
      }),
  };
}

function record(
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  createdAt = "2026-08-20T12:00:00.000Z",
): ComputeSessionRecord {
  return {
    sessionId,
    projectId,
    label: "Python",
    languageId: PYTHON,
    transportKind: ComputeTransportKind.make("jupyter-bridge"),
    workingDirectory: "/project",
    runtime: PROFILE,
    identity: null,
    environmentFingerprint: null,
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    status: "ready",
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
    createdAt,
    lastActivityAt: createdAt,
    closedAt: null,
    lostReason: null,
  };
}

function computeStub(overrides: Partial<GatewayCompute> = {}): GatewayCompute {
  const managedRuntime = {
    installed: false,
    selection: "existing" as const,
    updateAvailable: false,
    runtimeVersion: null,
    toolkitRevision: null,
    operation: null,
    failureMessage: null,
  };
  return {
    runtimeDescriptors: [DESCRIPTOR],
    runtimeInventory: () =>
      Effect.succeed([
        {
          descriptor: DESCRIPTOR,
          managedRuntime,
          toolkits: [],
          installations: [],
          failureMessage: null,
        },
      ]),
    inspectRuntimes: (input) =>
      Effect.succeed([
        {
          descriptor: DESCRIPTOR,
          toolkits: [],
          runtimes: input.enabledLanguageIds.has(PYTHON)
            ? [
                {
                  profile: PROFILE,
                  verification: {
                    profile: PROFILE,
                    readiness: "ready",
                    missingRequirements: [],
                    message: null,
                    packages: [],
                  },
                  toolkits: [],
                },
              ]
            : [],
        },
      ]),
    verifyRuntime: () =>
      Effect.succeed({
        profile: PROFILE,
        readiness: "ready",
        missingRequirements: [],
        message: null,
        packages: [],
      }),
    managedRuntimeStatus: () => Effect.succeed(managedRuntime),
    manageRuntime: () => Effect.succeed(managedRuntime),
    cancelManagedRuntime: () => Effect.succeed(managedRuntime),
    startSession: (input) => Effect.succeed(record(input.projectId, input.sessionId)),
    listSessions: () => Effect.succeed([]),
    getSession: () => Effect.succeed(null),
    listExecutions: () => Effect.succeed([]),
    listOutputs: () => Effect.succeed({ outputs: [], corruptLineCount: 0 }),
    inspectVariables: (input) =>
      Effect.succeed({
        generation: input.expectedGeneration,
        variables: [],
        truncated: false,
      }),
    submitExecution: () => Effect.die(new Error("unused submitExecution")),
    cancelExecution: () => Effect.die(new Error("unused cancelExecution")),
    interruptSession: () => Effect.die(new Error("unused interruptSession")),
    restartSession: () => Effect.die(new Error("unused restartSession")),
    stopSession: () => Effect.die(new Error("unused stopSession")),
    subscribeSessions: () => Effect.succeed(Stream.empty),
    ...overrides,
  };
}

function acceptedExecution(
  input: Parameters<GatewayCompute["submitExecution"]>[0],
): ComputeExecutionRecord {
  return {
    request: {
      executionId: input.executionId,
      sessionId: input.sessionId,
      generation: input.expectedGeneration,
      code: input.code,
      codeHash: `sha256:${"0".repeat(64)}` as ComputeExecutionRecord["request"]["codeHash"],
      source: input.source,
      submittedAt: "2026-08-20T12:00:00.000Z",
      environmentFingerprint: null,
    },
    result: null,
  };
}

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-gateway-" });
  yield* Effect.promise(() => initializeScientProject({ root }));
  const identity = yield* Effect.promise(() => readScientProjectIdentity(root));
  return { root, identity };
});

describe("compute RPC gateway", () => {
  it.effect("reads inventory preferences without inspecting or verifying runtimes", () =>
    Effect.gen(function* () {
      let enabled: ReadonlySet<unknown> = new Set();
      const gateway = makeComputeRpcGateway({
        compute: computeStub({
          runtimeInventory: (input) => {
            enabled = input.enabledLanguageIds;
            return Effect.succeed([
              {
                descriptor: DESCRIPTOR,
                managedRuntime: null,
                toolkits: [],
                installations: [],
                failureMessage: null,
              },
            ]);
          },
          inspectRuntimes: () => Effect.die("Settings must not inspect runtimes"),
          verifyRuntime: () => Effect.die("Settings must not verify runtimes"),
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      expect((yield* gateway.runtimeInventory()).languages[0]).toMatchObject({
        enabled: false,
        configuredExecutable: null,
        installations: [],
      });
      expect(enabled.size).toBe(0);
    }),
  );
  it.effect("does not inspect or start a language the user left disabled", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let inspectionEnabled = new Set<string>();
      let startCalls = 0;
      const retained = record(
        ComputeProjectId.make(initialized.identity.projectId),
        ComputeSessionId.make("retained-session"),
      );
      const compute = computeStub({
        inspectRuntimes: (input) => {
          inspectionEnabled = new Set(input.enabledLanguageIds);
          return Effect.succeed([{ descriptor: DESCRIPTOR, toolkits: [], runtimes: [] }]);
        },
        startSession: (input) => {
          startCalls += 1;
          return Effect.succeed(record(input.projectId, input.sessionId));
        },
        listSessions: () => Effect.succeed([retained]),
      });
      const gateway = makeComputeRpcGateway({
        compute,
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });

      const inspection = yield* gateway.inspectRuntimes({ cwd: initialized.root, refresh: false });
      expect(inspection.languages[0]).toMatchObject({ enabled: false, runtimes: [] });
      expect(inspectionEnabled.size).toBe(0);
      const error = yield* Effect.flip(
        gateway.startSession({
          cwd: initialized.root,
          sessionId: ComputeSessionId.make("session-1"),
          languageId: PYTHON,
          executable: null,
        }),
      );
      expect(error.reason).toBe("language-disabled");
      expect(startCalls).toBe(0);
      expect(yield* gateway.listSessions({ cwd: initialized.root })).toEqual([retained]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves Toolkit readiness from each exact verified runtime", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const verification = {
        profile: PROFILE,
        readiness: "ready" as const,
        missingRequirements: [],
        message: null,
        packages: [
          { name: "ipykernel", version: "6.29.5" },
          { name: "jupyter_client", version: "8.6.3" },
          { name: "matplotlib", version: "3.9.1" },
          { name: "numpy", version: "2.0.1" },
          { name: "pandas", version: "2.2.2" },
          { name: "scipy", version: null },
        ],
      };
      const compute = computeStub({
        inspectRuntimes: () =>
          Effect.succeed([
            {
              descriptor: DESCRIPTOR,
              toolkits: [PYTHON_DATA_AND_FIGURES_TOOLKIT],
              runtimes: [
                {
                  profile: PROFILE,
                  verification,
                  toolkits: [assessPythonToolkit(PYTHON_DATA_AND_FIGURES_TOOLKIT, verification)],
                },
              ],
            },
          ]),
      });
      const gateway = makeComputeRpcGateway({
        compute,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            scientificComputing: {
              schemaVersion: 1,
              languages: { python: { enabled: true, executable: "" } },
            },
          }),
        },
        workspaceFileSystem: workspace(),
      });

      const inspection = yield* gateway.inspectRuntimes({
        cwd: initialized.root,
        refresh: false,
      });

      expect(inspection.languages[0]?.toolkits).toMatchObject([
        {
          toolkitId: "python-data-and-figures",
          displayName: "Data analysis and figures",
        },
      ]);
      expect(inspection.languages[0]?.runtimes[0]?.toolkits).toMatchObject([
        {
          toolkitId: "python-data-and-figures",
          readiness: "missing-requirement",
          missingRequirements: ["SciPy"],
          runtime: { executable: PROFILE.executable },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("derives project identity and applies the preferred executable server-side", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let started: Parameters<GatewayCompute["startSession"]>[0] | null = null;
      const compute = computeStub({
        startSession: (input) => {
          started = input;
          return Effect.succeed(record(input.projectId, input.sessionId));
        },
      });
      const gateway = makeComputeRpcGateway({
        compute,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            scientificComputing: {
              schemaVersion: 1,
              languages: {
                python: { enabled: true, executable: "/preferred/python" },
              },
            },
          }),
        },
        workspaceFileSystem: workspace(),
      });

      yield* gateway.startSession({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        languageId: PYTHON,
        executable: null,
      });
      const fs = yield* FileSystem.FileSystem;
      expect(started).toMatchObject({
        projectId: initialized.identity.projectId,
        workingDirectory: yield* fs.realPath(initialized.root),
        configuredExecutable: "/preferred/python",
      });

      yield* gateway.startSession({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("explicit-session"),
        languageId: PYTHON,
        executable: "/chosen/python",
      });
      expect(started).toMatchObject({
        configuredExecutable: "/preferred/python",
        requestedExecutable: "/chosen/python",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("bounds history without hiding older live sessions at the product boundary", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const projectId = ComputeProjectId.make(initialized.identity.projectId);
      const history = Array.from({ length: 130 }, (_, index) => ({
        ...record(
          projectId,
          ComputeSessionId.make(`session-${index}`),
          `2026-08-20T${String(12 + Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}:00.000Z`,
        ),
        status: index === 0 ? ("ready" as const) : ("stopped" as const),
      }));
      const gateway = makeComputeRpcGateway({
        compute: computeStub({ listSessions: () => Effect.succeed(history) }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });

      const listed = yield* gateway.listSessions({ cwd: initialized.root });
      expect(listed).toHaveLength(101);
      expect(listed[0]?.sessionId).toBe("session-129");
      expect(listed.at(-2)?.sessionId).toBe("session-30");
      expect(listed.at(-1)?.sessionId).toBe("session-0");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects an ordinary folder before any compute operation runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-ordinary-" });
      let listCalls = 0;
      const gateway = makeComputeRpcGateway({
        compute: computeStub({
          listSessions: () => {
            listCalls += 1;
            return Effect.succeed([]);
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      const error = yield* Effect.flip(gateway.listSessions({ cwd: root }));
      expect(error.reason).toBe("project-not-initialized");
      expect(listCalls).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("derives project identity before inspecting the live namespace", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let inspected: Parameters<GatewayCompute["inspectVariables"]>[0] | null = null;
      const gateway = makeComputeRpcGateway({
        compute: computeStub({
          inspectVariables: (input) => {
            inspected = input;
            return Effect.succeed({
              generation: input.expectedGeneration,
              variables: [],
              truncated: false,
            });
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });

      yield* gateway.inspectVariables({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
      });
      expect(inspected).toMatchObject({
        projectId: initialized.identity.projectId,
        sessionId: "session-1",
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute saved-source validation", () => {
  it("extracts exact LF and CRLF editor ranges and rejects invalid coordinates", () => {
    expect(
      extractComputeSourceRange("first\r\nsecond\r\nthird", {
        startLine: 0,
        startColumn: 2,
        endLine: 1,
        endColumn: 3,
      }),
    ).toBe("rst\r\nsec");
    expect(
      extractComputeSourceRange("first\nsecond", {
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 99,
      }),
    ).toBeNull();
  });

  it.effect("rejects a false saved-source claim before compute accepts it", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let submitCalls = 0;
      const gateway = makeComputeRpcGateway({
        compute: computeStub({
          submitExecution: () => {
            submitCalls += 1;
            return Effect.die(new Error("A false saved claim reached compute."));
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace("first\nsecond\n", "sha256:saved"),
      });

      const error = yield* Effect.flip(
        gateway.submitExecution({
          cwd: initialized.root,
          sessionId: ComputeSessionId.make("session-1"),
          executionId: ComputeExecutionId.make("execution-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "different",
          source: {
            _tag: "document",
            origin: "selection",
            path: "analysis.py",
            bufferState: "saved",
            revision: "sha256:saved",
            range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 6 },
          },
        }),
      );
      expect(error.reason).toBe("source-invalid");
      expect(submitCalls).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("accepts matching saved bytes and preserves different dirty bytes honestly", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const accepted: Array<Parameters<GatewayCompute["submitExecution"]>[0]> = [];
      const gateway = makeComputeRpcGateway({
        compute: computeStub({
          submitExecution: (input) => {
            accepted.push(input);
            return Effect.succeed(acceptedExecution(input));
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace("first\nsecond\n", "sha256:saved"),
      });
      const source = {
        _tag: "document" as const,
        origin: "selection" as const,
        path: "analysis.py",
        revision: "sha256:saved",
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 6 },
      };

      yield* gateway.submitExecution({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-saved"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        code: "second",
        source: { ...source, bufferState: "saved" },
      });
      yield* gateway.submitExecution({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-dirty"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        code: "unsaved editor bytes",
        source: { ...source, bufferState: "dirty" },
      });

      expect(accepted).toHaveLength(2);
      expect(accepted.map((input) => input.projectId)).toEqual([
        initialized.identity.projectId,
        initialized.identity.projectId,
      ]);
      expect(accepted.map((input) => input.source)).toMatchObject([
        { bufferState: "saved" },
        { bufferState: "dirty" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
