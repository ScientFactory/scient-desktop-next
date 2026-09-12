// @effect-diagnostics nodeBuiltinImport:off -- Promise adapter fixtures write only scoped synthetic staging.
import * as NodeFSP from "node:fs/promises";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { ComputeLanguageId } from "@t3tools/contracts";
import {
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRuntimeAdapter,
  type AnalysisRuntimeProfile,
  type AnalysisRunSnapshot,
} from "@scientfactory/analysis";
import {
  ExecutionRunId,
  type ExecutionOutputChunk,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ScientificRuntimePreferences from "../compute/ScientificRuntimePreferences.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsService, type AnalyticsStatus } from "../../telemetry/AnalyticsService.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as AnalysisRunIndex from "./AnalysisRunIndex.ts";
import {
  AnalysisService,
  layerWithAdapters,
  recoveredOutputContentHash,
} from "./AnalysisService.ts";
import * as LocalAnalysisStore from "./LocalAnalysisStore.ts";

const output: ReadonlyArray<ExecutionOutputChunk> = [
  {
    sequence: 0,
    stream: "stdout",
    text: "partial output\n",
    observedAt: "2026-08-13T00:00:00.000Z",
  },
];

const runtimeId = AnalysisRuntimeId.make("matlab:test");
const sourceRevision = AnalysisSourceRevision.make("sha256:test-source");
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const runtimeProfile = (
  inspectedAt: string,
  executablePath = "/test/matlab",
): AnalysisRuntimeProfile => ({
  id: runtimeId,
  kind: "matlab",
  label: "MATLAB test runtime",
  availability: "available",
  source: "custom",
  executablePath,
  version: "test",
  detail: null,
  capabilities: ["run-file", "stream-output", "cancel-process-tree"],
  inspectedAt,
  verification: null,
});

const testAdapter: AnalysisRuntimeAdapter = {
  id: runtimeId,
  kind: "matlab",
  fileExtensions: [".m"],
  inspect: async ({ customExecutablePath, inspectedAt }) =>
    runtimeProfile(inspectedAt, customExecutablePath),
  prepareVerification: async (profile) => ({
    executableIdentity: `identity:${profile.executablePath ?? "missing"}`,
    executable: profile.executablePath ?? "/test/matlab",
    args: ["verify"],
    cwd: "/tmp",
    environment: {},
    timeoutMs: 1_000,
    collect: async (result) => ({
      status: result.exitCode === 0 ? "ready" : "startup-failed",
      verifiedAt: result.verifiedAt,
      durationMs: result.durationMs,
      executableIdentity: `identity:${profile.executablePath ?? "missing"}`,
      release: "test",
      version: "test",
      architecture: "test",
      installationRoot: profile.executablePath,
      javaAvailable: true,
      javaVersion: "test",
      toolboxes: [],
      detail: "Test runtime is ready.",
    }),
    cleanup: async () => undefined,
  }),
  prepare: (context) => ({
    executable: "/test/matlab",
    args: [context.source.relativePath],
    cwd: context.source.cwd,
    environment: {},
  }),
};

const makeServiceTestLayer = Effect.fn("makeServiceTestLayer")(function* (
  adapter: AnalysisRuntimeAdapter = testAdapter,
  transformStore?: (
    store: LocalAnalysisStore.LocalAnalysisStore["Service"],
  ) => LocalAnalysisStore.LocalAnalysisStore["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projectRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-project-",
  });
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-state-",
  });
  yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
  const projectIdentity = yield* Effect.promise(() => readScientProjectIdentity(projectRoot));

  const startedRuns = yield* Queue.unbounded<ExecutionRunId>();
  const processExits = new Map<ExecutionRunId, Deferred.Deferred<number>>();
  const processStartCount = yield* Ref.make(0);
  const processPort: ExecutionProcessPort = {
    start: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(processStartCount, (count) => count + 1);
        if (request.args[0] === "verify") {
          return {
            output: Stream.empty,
            exitCode: Effect.succeed(0),
            cancel: Effect.void,
          };
        }
        const exitCode = yield* Deferred.make<number>();
        processExits.set(request.runId, exitCode);
        yield* Queue.offer(startedRuns, request.runId);
        return {
          output: Stream.empty,
          exitCode: Deferred.await(exitCode),
          cancel: Deferred.succeed(exitCode, 130).pipe(Effect.asVoid),
        };
      }),
  };
  const workspaceFileSystem = WorkspaceFileSystem.WorkspaceFileSystem.of({
    createBinaryFile: () => Effect.die("createBinaryFile is not used by the analysis service test"),
    inspectWriteTarget: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        canonicalRelativePath: input.relativePath,
        traversesSymlink: false,
      }),
    readFile: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents: "% test source\n",
        byteLength: 14,
        truncated: false,
        revision: sourceRevision,
      }),
    writeFile: () => Effect.die("writeFile is not used by the analysis service test"),
    renameFile: () => Effect.die("renameFile is not used by the analysis service test"),
    watchFile: () => Stream.empty,
  });
  const workspacePaths = WorkspacePaths.WorkspacePaths.of({
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: (input) =>
      Effect.succeed({
        absolutePath: `${input.workspaceRoot}/${input.relativePath}`,
        relativePath: input.relativePath,
      }),
  });
  const indexLayer = AnalysisRunIndex.layer.pipe(Layer.provide(SqlitePersistenceMemory));
  const localStoreLayer = LocalAnalysisStore.layer.pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(projectRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const serviceStoreLayer = transformStore
    ? Layer.effect(
        LocalAnalysisStore.LocalAnalysisStore,
        Effect.map(LocalAnalysisStore.LocalAnalysisStore, transformStore),
      ).pipe(Layer.provide(localStoreLayer))
    : localStoreLayer;
  const settingsLayer = ServerSettings.layerTest();
  const analysisLayer = layerWithAdapters([adapter]).pipe(
    Layer.provide(
      ScientificRuntimePreferences.layer.pipe(
        Layer.provide(serviceStoreLayer),
        Layer.provide(settingsLayer),
      ),
    ),
    Layer.provideMerge(settingsLayer),
    Layer.provide(serviceStoreLayer),
    Layer.provide(indexLayer),
    Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, processPort)),
    Layer.provide(Layer.succeed(WorkspaceFileSystem.WorkspaceFileSystem, workspaceFileSystem)),
    Layer.provide(Layer.succeed(WorkspacePaths.WorkspacePaths, workspacePaths)),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    analysisLayer,
    localStoreLayer,
    processStartCount,
    processExits,
    projectId: projectIdentity.projectId,
    projectRoot,
    startedRuns,
  };
});

const serviceTestLayer = makeServiceTestLayer();

const analyticsFixture = Effect.gen(function* () {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  const terminalEvents = yield* Queue.unbounded<string>();
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const service = AnalyticsService.of({
    record: (name, properties) =>
      Effect.gen(function* () {
        events.push({ name, properties });
        if (name !== "scient.operation.started") yield* Queue.offer(terminalEvents, name);
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    setConsent: (consent) =>
      Effect.sync(() => {
        status = { available: true, consent };
        epoch += 1;
        return status;
      }),
    flush: Effect.void,
    deleteData: Effect.succeed(true),
  });
  return { events, terminalEvents, service };
});

type ArtifactFixtureMode =
  | "captured"
  | "empty"
  | "warning"
  | "collection-error"
  | "publication-error";

const artifactTestAdapter = (mode: ArtifactFixtureMode): AnalysisRuntimeAdapter => ({
  ...testAdapter,
  prepareRun: async ({ artifactStagingDirectory }) => {
    await NodeFSP.mkdir(`${artifactStagingDirectory}/files`, { recursive: true });
    await NodeFSP.writeFile(
      `${artifactStagingDirectory}/files/private-figure.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg"><title>private-result</title></svg>',
    );
  },
  collectArtifacts: async () => {
    if (mode === "collection-error") throw new Error("private capture detail /private/source");
    return {
      failureMessage: mode === "warning" ? "private partial capture warning" : null,
      candidates:
        mode === "empty"
          ? []
          : [
              {
                artifactId: AnalysisArtifactId.make("private-figure-id"),
                kind: "figure",
                label: "Private scientific figure",
                representations: [
                  {
                    representationId: AnalysisArtifactRepresentationId.make(
                      "private-representation-id",
                    ),
                    fileName: AnalysisArtifactFileName.make(
                      mode === "publication-error" ? "missing.svg" : "private-figure.svg",
                    ),
                    mediaType: "image/svg+xml",
                    presentation: "static",
                    requiresNetworkForFullExperience: false,
                  },
                ],
              },
            ],
    };
  },
});

describe("analysis artifact analytics", () => {
  for (const mode of ["captured", "warning"] as const) {
    it.effect(`preserves ${mode} publication independently of concurrent cancellation`, () =>
      Effect.gen(function* () {
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeServiceTestLayer(artifactTestAdapter(mode), (store) => ({
          ...store,
          publishArtifacts: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(publishing, undefined);
              yield* Deferred.await(release);
              return yield* store.publishArtifacts(input);
            }),
        }));
        const analytics = yield* analyticsFixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "cancel-publishing.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
            yield* Deferred.await(publishing);
            yield* service.cancelRun({ cwd: harness.projectRoot, runId });
            yield* Deferred.succeed(release, undefined);
            const expected = mode === "warning" ? "failed" : "completed";
            expect(yield* Queue.take(analytics.terminalEvents)).toBe(
              `scient.operation.${expected}`,
            );
            expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
            const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
            expect(persisted.receipt.status).toBe("cancelled");
            expect(persisted.artifacts).toHaveLength(1);
            expect(persisted.artifactReceipt.status).toBe(
              mode === "warning" ? "failed" : "succeeded",
            );
            expect(
              analytics.events
                .filter((event) => event.properties?.operationKind === "compute-artifact")
                .map((event) => event.name),
            ).toEqual(["scient.operation.started", `scient.operation.${expected}`]);
          }).pipe(
            Effect.provide(
              harness.analysisLayer.pipe(
                Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  it.effect("reports a failed requested capture when preparation prevents process launch", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer({
        ...artifactTestAdapter("captured"),
        prepareRun: async () => {
          throw new Error("private setup detail");
        },
      });
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const run = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "launch-error.m",
            sourceRevision,
            runtimeId,
          });
          yield* Queue.take(analytics.terminalEvents);
          yield* Queue.take(analytics.terminalEvents);
          const persisted = yield* service.getRun({
            cwd: harness.projectRoot,
            runId: run.receipt.runId,
          });
          expect(persisted.receipt.status).toBe("failed");
          expect(persisted.artifactReceipt.status).toBe("failed");
          expect(persisted.artifacts).toHaveLength(0);
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual(["scient.operation.started", "scient.operation.failed"]);
          expect(yield* Ref.get(harness.processStartCount)).toBe(0);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports queued capture cancellation without launching its process", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "first-capture.m",
            sourceRevision,
            runtimeId,
          });
          const firstId = yield* Queue.take(harness.startedRuns);
          const queued = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "cancel-capture.m",
            sourceRevision,
            runtimeId,
          });
          const cancelled = yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: queued.receipt.runId,
          });
          expect(cancelled.receipt.status).toBe("cancelled");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
          yield* Deferred.succeed(harness.processExits.get(firstId)!, 0);
          yield* Queue.take(analytics.terminalEvents);
          yield* Queue.take(analytics.terminalEvents);
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual([
            "scient.operation.started",
            "scient.operation.started",
            "scient.operation.cancelled",
            "scient.operation.completed",
          ]);
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  for (const scenario of [
    { mode: "captured", exitCode: 0, outcome: "completed", artifacts: 1 },
    { mode: "captured", exitCode: 1, outcome: "completed", artifacts: 1 },
    { mode: "empty", exitCode: 0, outcome: "skipped", artifacts: 0 },
    { mode: "warning", exitCode: 0, outcome: "failed", artifacts: 1 },
    { mode: "collection-error", exitCode: 0, outcome: "failed", artifacts: 0 },
    { mode: "publication-error", exitCode: 0, outcome: "failed", artifacts: 0 },
  ] as const) {
    it.effect(`separates ${scenario.mode} capture from process exit ${scenario.exitCode}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeServiceTestLayer(artifactTestAdapter(scenario.mode));
        const analytics = yield* analyticsFixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            const run = yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "private-study.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            expect(analytics.events.map((event) => event.properties?.operationKind)).toEqual([
              "compute-run",
              "compute-artifact",
            ]);
            yield* Deferred.succeed(harness.processExits.get(runId)!, scenario.exitCode);
            expect(yield* Queue.take(analytics.terminalEvents)).toBe(
              `scient.operation.${scenario.outcome}`,
            );
            expect(yield* Queue.take(analytics.terminalEvents)).toBe(
              scenario.exitCode === 0 ? "scient.operation.completed" : "scient.operation.failed",
            );
            const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
            expect(persisted.receipt.status).toBe(scenario.exitCode === 0 ? "succeeded" : "failed");
            expect(persisted.artifactReceipt.status).toBe(
              scenario.outcome === "failed" ? "failed" : "succeeded",
            );
            expect(persisted.artifacts).toHaveLength(scenario.artifacts);
            yield* service.listRuns({ cwd: harness.projectRoot });
            const captureEvents = analytics.events.filter(
              (event) => event.properties?.operationKind === "compute-artifact",
            );
            expect(captureEvents.map((event) => event.name)).toEqual([
              "scient.operation.started",
              `scient.operation.${scenario.outcome}`,
            ]);
            expect(captureEvents[1]?.properties).toEqual({
              operationKind: "compute-artifact",
              trigger: "user",
              durationMs: expect.any(Number),
              failureClass: "unknown",
            });
            const payload = yield* encodeUnknownJson(analytics.events);
            for (const privateValue of [
              harness.projectRoot,
              harness.projectId,
              String(run.receipt.runId),
              "private-",
              "Private scientific",
              "private partial",
              "private capture",
              "missing.svg",
            ]) {
              expect(payload).not.toContain(privateValue);
            }
          }).pipe(
            Effect.provide(
              harness.analysisLayer.pipe(
                Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  it.effect("keeps the saved capture outcome when later run bookkeeping fails", () =>
    Effect.gen(function* () {
      let failed = false;
      const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"), (store) => ({
        ...store,
        measureRunStorage: (projectId, runId) =>
          Effect.suspend(() => {
            if (failed) return store.measureRunStorage(projectId, runId);
            failed = true;
            return Effect.fail(
              new LocalAnalysisStore.LocalAnalysisStoreError({
                operation: "measure-run-storage",
                path: "/private/fixture",
                cause: "private bookkeeping failure",
              }),
            );
          }),
      }));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "later-error.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.completed");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.failed");
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.artifactReceipt.status).toBe("succeeded");
          expect(persisted.artifacts).toHaveLength(1);
          expect(persisted.receipt.status).toBe("failed");
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual(["scient.operation.started", "scient.operation.completed"]);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  for (const mode of ["off", "epoch-change", "broken"] as const) {
    it.effect(`keeps capture functional with ${mode} analytics without replay`, () =>
      Effect.gen(function* () {
        const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"));
        const analytics = yield* analyticsFixture;
        if (mode === "off") yield* analytics.service.setConsent("off");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "consent.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            if (mode === "epoch-change") yield* analytics.service.setConsent("off");
            yield* analytics.service.setConsent("product");
            const updates = yield* service.subscribeRuns({ cwd: harness.projectRoot });
            yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
            yield* updates.pipe(
              Stream.filter(
                (event) =>
                  event._tag !== "run-output" &&
                  event.run.receipt.runId === runId &&
                  event.run.receipt.status === "succeeded",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
            expect(persisted.artifacts).toHaveLength(1);
            expect(persisted.artifactReceipt.status).toBe("succeeded");
          }).pipe(
            Effect.provide(
              harness.analysisLayer.pipe(
                Layer.provide(
                  Layer.succeed(
                    AnalyticsService,
                    mode === "broken"
                      ? {
                          ...analytics.service,
                          record: () => Effect.die("private analytics failure"),
                        }
                      : analytics.service,
                  ),
                ),
              ),
            ),
          ),
        );
        expect(analytics.events.map((event) => event.name)).toEqual(
          mode === "epoch-change" ? ["scient.operation.started", "scient.operation.started"] : [],
        );
        expect(yield* Ref.get(harness.processStartCount)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
});

describe("analysis outcome analytics", () => {
  for (const mode of ["off", "epoch-change", "broken"] as const) {
    it.effect(`keeps execution intact with ${mode} analytics and does not replay active work`, () =>
      Effect.gen(function* () {
        const harness = yield* serviceTestLayer;
        const analytics = yield* analyticsFixture;
        if (mode === "off") yield* analytics.service.setConsent("off");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            const first = yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "first.m",
              sourceRevision,
              runtimeId,
            });
            yield* Queue.take(harness.startedRuns);
            const queued = yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "queued.m",
              sourceRevision,
              runtimeId,
            });
            if (mode === "epoch-change") yield* analytics.service.setConsent("off");
            yield* analytics.service.setConsent("product");
            const cancelled = yield* service.cancelRun({
              cwd: harness.projectRoot,
              runId: queued.receipt.runId,
            });
            expect(cancelled.receipt.status).toBe("cancelled");
            yield* service.cancelRun({ cwd: harness.projectRoot, runId: first.receipt.runId });
          }).pipe(
            Effect.provide(
              harness.analysisLayer.pipe(
                Layer.provide(
                  Layer.succeed(
                    AnalyticsService,
                    mode === "broken"
                      ? {
                          ...analytics.service,
                          status: Effect.die("private observer failure"),
                        }
                      : analytics.service,
                  ),
                ),
              ),
            ),
          ),
        );
        expect(analytics.events.map((event) => event.name)).toEqual(
          mode === "epoch-change" ? ["scient.operation.started", "scient.operation.started"] : [],
        );
        expect(yield* Ref.get(harness.processStartCount)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
  for (const outcome of ["completed", "failed", "cancelled"] as const) {
    it.effect(`observes one durable ${outcome} outcome without exporting run data`, () =>
      Effect.gen(function* () {
        const harness = yield* serviceTestLayer;
        const analytics = yield* analyticsFixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            const run = yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "private-study.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            expect(analytics.events.map((event) => event.name)).toEqual([
              "scient.operation.started",
            ]);
            if (outcome === "cancelled") {
              yield* service.cancelRun({ cwd: harness.projectRoot, runId });
            } else {
              yield* Deferred.succeed(
                harness.processExits.get(runId)!,
                outcome === "failed" ? 1 : 0,
              );
            }
            expect(yield* Queue.take(analytics.terminalEvents)).toBe(`scient.operation.${outcome}`);
            const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
            expect(persisted.receipt.status).toBe(outcome === "completed" ? "succeeded" : outcome);
            yield* service.listRuns({ cwd: harness.projectRoot, limit: 20 });
            expect(analytics.events).toEqual([
              {
                name: "scient.operation.started",
                properties: {
                  operationKind: "compute-run",
                  trigger: "user",
                  durationMs: undefined,
                  failureClass: "unknown",
                },
              },
              {
                name: `scient.operation.${outcome}`,
                properties: {
                  operationKind: "compute-run",
                  trigger: "user",
                  durationMs: expect.any(Number),
                  failureClass: "unknown",
                },
              },
            ]);
            const payload = yield* encodeUnknownJson(analytics.events);
            for (const privateValue of [
              harness.projectRoot,
              harness.projectId,
              String(run.receipt.runId),
              "private-study",
              "test-source",
              "test/matlab",
            ]) {
              expect(payload).not.toContain(privateValue);
            }
          }).pipe(
            Effect.provide(
              harness.analysisLayer.pipe(
                Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
});

describe("analysis restart recovery", () => {
  it("preserves a fidelity hash only when recovered output is known complete", () => {
    expect(recoveredOutputContentHash(output, false)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(recoveredOutputContentHash(output, true)).toBeNull();
  });
});

describe("analysis service coordination", () => {
  it.effect("serializes concurrent starts so one file cannot acquire two active runs", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const input = {
            cwd: harness.projectRoot,
            relativePath: "analysis.m",
            sourceRevision,
            runtimeId,
          };
          const results = yield* Effect.all(
            [service.startRun(input).pipe(Effect.exit), service.startRun(input).pipe(Effect.exit)],
            { concurrency: "unbounded" },
          );

          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(results.filter(Exit.isFailure)).toHaveLength(1);
          const startedRunId = yield* Queue.take(harness.startedRuns);
          yield* service.cancelRun({ cwd: harness.projectRoot, runId: startedRunId });
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("cancels a queued run without ever starting its process", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const first = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "first.m",
            sourceRevision,
            runtimeId,
          });
          yield* Queue.take(harness.startedRuns);
          const second = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "second.m",
            sourceRevision,
            runtimeId,
          });

          const cancelled = yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: second.receipt.runId,
          });
          expect(cancelled.receipt.status).toBe("cancelled");
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);
          yield* service.cancelRun({ cwd: harness.projectRoot, runId: first.receipt.runId });
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers a persisted non-terminal run as lost on the first history read", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const analytics = yield* analyticsFixture;
      const runId = ExecutionRunId.make("interrupted-run");
      const interruptedRun: AnalysisRunSnapshot = {
        contractVersion: 1,
        projectId: harness.projectId,
        action: "run-file",
        runtime: runtimeProfile("2026-08-13T00:00:00.000Z"),
        source: {
          cwd: harness.projectRoot,
          relativePath: "interrupted.m",
          revision: sourceRevision,
        },
        phase: "running",
        queuePosition: null,
        diagnostics: [],
        artifacts: [],
        artifactReceipt: { status: "not-requested", failureMessage: null },
        localStorage: {
          status: "retained",
          outputBytes: 0,
          artifactBytes: 0,
          totalBytes: 0,
          removedAt: null,
        },
        receipt: {
          runId,
          status: "running",
          startedAt: "2026-08-13T00:00:00.000Z",
          finishedAt: null,
          exitCode: null,
          failureMessage: null,
          cancellationRequested: false,
          outputTruncated: false,
          outputByteLength: 0,
          outputContentHash: null,
          output: [],
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore.LocalAnalysisStore;
          yield* store.persistRun(interruptedRun);
        }).pipe(Effect.provide(harness.localStoreLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const history = yield* service.listRuns({ cwd: harness.projectRoot, limit: 20 });
          expect(history.runs).toHaveLength(1);
          expect(history.runs[0]?.receipt).toMatchObject({
            runId,
            status: "lost",
            outputContentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          });
          expect(history.runs[0]?.receipt.finishedAt).not.toBeNull();
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
      expect(analytics.events).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reuses verification only until runtime configuration changes", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const first = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          const cached = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          expect(first.verification?.status).toBe("ready");
          expect(cached.verification?.executableIdentity).toBe(
            first.verification?.executableIdentity,
          );
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);

          yield* service.configureRuntime({
            cwd: harness.projectRoot,
            runtimeKind: "matlab",
            executablePath: "/test/other-matlab",
          });
          const refreshed = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          expect(refreshed.verification?.executableIdentity).toBe("identity:/test/other-matlab");
          expect(yield* Ref.get(harness.processStartCount)).toBe(2);
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never caches an old MATLAB profile under a failed new settings choice", () =>
    Effect.gen(function* () {
      let failNewChoice = true;
      const harness = yield* makeServiceTestLayer({
        ...testAdapter,
        inspect: async (input) => {
          if (input.customExecutablePath === "/new/matlab" && failNewChoice)
            throw new Error("Installation is temporarily unavailable");
          return testAdapter.inspect(input);
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* AnalysisService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* service.inspectRuntimes({ cwd: harness.projectRoot });
        yield* settings.updateSettings({
          scientificComputing: {
            languages: {
              [ComputeLanguageId.make("matlab")]: { executable: "/new/matlab" },
            },
          },
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            Exit.isFailure(
              yield* Effect.exit(service.inspectRuntimes({ cwd: harness.projectRoot })),
            ),
          ).toBe(true);
        }
        failNewChoice = false;
        const recovered = yield* service.inspectRuntimes({ cwd: harness.projectRoot });
        expect(recovered.runtimes[0]?.executablePath).toBe("/new/matlab");
      }).pipe(Effect.provide(harness.analysisLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("promotes a persisted terminal run into its initialized project", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const runId = ExecutionRunId.make("promoted-run");
      const run: AnalysisRunSnapshot = {
        contractVersion: 1,
        projectId: harness.projectId,
        action: "run-file",
        runtime: runtimeProfile("2026-08-14T10:00:00.000Z"),
        source: {
          cwd: harness.projectRoot,
          relativePath: "promote.m",
          revision: sourceRevision,
        },
        phase: "finished",
        queuePosition: null,
        diagnostics: [],
        artifacts: [],
        artifactReceipt: { status: "succeeded", failureMessage: null },
        localStorage: {
          status: "retained",
          outputBytes: 9,
          artifactBytes: 0,
          totalBytes: 9,
          removedAt: null,
        },
        receipt: {
          runId,
          status: "succeeded",
          startedAt: "2026-08-14T10:00:00.000Z",
          finishedAt: "2026-08-14T10:00:01.000Z",
          exitCode: 0,
          failureMessage: null,
          cancellationRequested: false,
          outputTruncated: false,
          outputByteLength: 9,
          outputContentHash: null,
          output,
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore.LocalAnalysisStore;
          yield* store.persistRun(run);
          yield* Effect.forEach(
            output,
            (chunk) => store.appendOutput(harness.projectId, runId, chunk),
            {
              discard: true,
            },
          );
        }).pipe(Effect.provide(harness.localStoreLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const promotedResults = yield* Effect.all(
            [
              service.promoteRun({ cwd: harness.projectRoot, runId }),
              service.promoteRun({ cwd: harness.projectRoot, runId }),
            ],
            { concurrency: "unbounded" },
          );
          expect(promotedResults.map((result) => result.reused).toSorted()).toEqual([false, true]);
          const promoted = promotedResults[0]!;
          expect(promoted).toMatchObject({
            directoryRelativePath: "results/promote/20260814T100000Z-promoted-run",
            artifactFileCount: 0,
          });
          const fs = yield* FileSystem.FileSystem;
          expect(
            yield* fs.readFileString(`${harness.projectRoot}/${promoted.readmeRelativePath}`),
          ).toContain("MATLAB test runtime analysis result");
          expect(
            yield* fs.readFileString(
              `${harness.projectRoot}/${promoted.directoryRelativePath}/output.txt`,
            ),
          ).toBe("partial output\n");
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
