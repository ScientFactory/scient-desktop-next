// @effect-diagnostics nodeBuiltinImport:off -- gated integration uses a selected MATLAB install.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  type ComputeSessionGeneration,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  INITIAL_COMPUTE_SESSION_GENERATION,
  projectComputeOutputs,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LocalAnalysisStore from "../analysis/LocalAnalysisStore.ts";
import * as ScientificRuntimePreferences from "./ScientificRuntimePreferences.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "./ComputeSessionService.ts";
import { makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import { matlabRuntimeBinding } from "./MatlabComputeRuntime.ts";

const TEST_MATLAB = NodeProcess.env.SCIENT_TEST_MATLAB;
const TEST_HELPER = NodeProcess.env.SCIENT_TEST_MATLAB_HELPER === "1";
const MATLAB = ComputeLanguageId.make("matlab");

const waitForTerminal = Effect.fn("MatlabCompute.waitForTerminal")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
) {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const execution = (yield* gateway.listExecutions({ cwd, sessionId, limit: 100 })).find(
      (candidate) => candidate.request.executionId === executionId,
    );
    if (
      execution !== undefined &&
      execution.result !== null &&
      TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
    ) {
      return execution.result.status;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`MATLAB execution '${executionId}' did not finish.`));
});

const submit = Effect.fn("MatlabCompute.submit")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
  generation: ComputeSessionGeneration,
  id: string,
  code: string,
) {
  const executionId = ComputeExecutionId.make(id);
  yield* gateway.submitExecution({
    cwd,
    sessionId,
    executionId,
    expectedGeneration: generation,
    code,
    source: { _tag: "console" },
  });
  return executionId;
});

const waitForBusy = Effect.fn("MatlabCompute.waitForBusy")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const session = (yield* gateway.listSessions({ cwd })).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (session?.activity === "busy") return;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("MATLAB session did not become busy."));
});

describe.runIf(Boolean(TEST_MATLAB))("MATLAB compute product backend", () => {
  it.live(
    "runs statefully, captures changed figures, recovers from errors and survives stress",
    () =>
      Effect.gen(function* () {
        if (!TEST_MATLAB) return yield* Effect.die("SCIENT_TEST_MATLAB is not set.");
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-compute-project-",
        });
        const stateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-compute-state-",
        });
        yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

        const computeLayer = ComputeSessionService.layerWithRuntimeBindings(
          matlabRuntimeBinding.pipe(Effect.map((binding) => [binding])),
        ).pipe(
          Layer.provide(
            ScientificRuntimePreferences.layer.pipe(
              Layer.provide(
                ServerSettings.layerTest({
                  scientificComputing: {
                    languages: { [MATLAB]: { enabled: true, executable: TEST_MATLAB } },
                  },
                }),
              ),
              Layer.provide(LocalAnalysisStore.layer),
            ),
          ),
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
          Layer.provide(NodeServices.layer),
        );
        const workspaceLayer = WorkspaceFileSystem.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const compute = yield* ComputeSessionService.ComputeSessionService;
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const gateway = makeComputeRpcGateway({
            compute,
            workspaceFileSystem,
            serverSettings: {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                scientificComputing: {
                  schemaVersion: 1,
                  languages: { matlab: { enabled: true, executable: TEST_MATLAB } },
                },
              }),
            },
          });

          // Settings must inventory the real installation before a helper exists,
          // without needing an Engine host or a native connection.
          const inventories = yield* Effect.forEach(
            Array.from({ length: 20 }),
            () => gateway.runtimeInventory(),
            { concurrency: 4 },
          );
          expect(
            inventories.every(
              (inventory) => inventory.languages[0]?.installations[0]?.problem === null,
            ),
          ).toBe(true);
          expect(inventories[0]?.languages[0]?.installations[0]?.version).toMatch(/^R\d{4}[ab]$/u);
          expect(yield* gateway.listSessions({ cwd: projectRoot })).toEqual([]);

          if (TEST_HELPER) {
            yield* gateway.manageRuntime({ languageId: MATLAB, action: "install" });
            for (;;) {
              const status = yield* gateway.managedRuntimeStatus({ languageId: MATLAB });
              if (status.operation === null) {
                expect(status.failureMessage).toBeNull();
                expect(status.installed).toBe(true);
                expect(status.selection).toBe("managed");
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
          const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
          const runtime = inspection.languages
            .find((language) => language.descriptor.languageId === MATLAB)
            ?.runtimes.find((candidate) => candidate.verification.readiness === "ready");
          if (runtime === undefined)
            return yield* Effect.die(
              `No ready MATLAB runtime was found: ${inspection.languages.flatMap((language) => language.runtimes.map((runtime) => runtime.verification.message)).join("; ")}`,
            );
          expect(runtime.profile.languageVersion).toMatch(/^R\d{4}[ab]$/u);
          expect(runtime.verification.connection).toBe("detected");
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const verified = yield* gateway.verifyRuntime({
              cwd: projectRoot,
              languageId: MATLAB,
              executable: runtime.profile.executable,
            });
            expect(verified).toMatchObject({ readiness: "ready", connection: "verified" });
            expect(yield* gateway.listSessions({ cwd: projectRoot })).toEqual([]);
          }

          for (const name of [
            "scient_compute_eval",
            "scient_compute_figures",
            "scient_compute_variables",
          ]) {
            yield* workspaceFileSystem.writeFile({
              cwd: projectRoot,
              relativePath: `${name}.m`,
              contents: [
                `function value = ${name}(varargin)`,
                "error('Scient:ShadowedHelper', 'Project helper must never run.');",
                "value = '';",
                "end",
              ].join("\n"),
            });
          }

          const sessionId = ComputeSessionId.make("matlab-stateful-session");
          const session = yield* gateway.startSession({
            cwd: projectRoot,
            sessionId,
            languageId: MATLAB,
            executable: runtime.profile.executable,
          });
          expect(session.status).toBe("ready");
          if (TEST_HELPER) {
            const removal = yield* gateway
              .manageRuntime({ languageId: MATLAB, action: "remove" })
              .pipe(Effect.exit);
            expect(removal._tag).toBe("Failure");
            expect((yield* gateway.managedRuntimeStatus({ languageId: MATLAB })).installed).toBe(
              true,
            );
          }

          const writeId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-state-write",
            [
              "answer = 41; disp(answer + 1);",
              "local_answer = scient_local_double(answer);",
              "fid = fopen('scient-matlab-output.txt', 'w');",
              "fprintf(fid, 'workspace output'); fclose(fid);",
              "function value = scient_local_double(input)",
              "value = input * 2;",
              "end",
            ].join("\n"),
          );
          const writeStatus = yield* waitForTerminal(gateway, projectRoot, sessionId, writeId);
          const writeOutput = yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: writeId,
          });
          expect(writeStatus).toBe("succeeded");
          expect(
            writeOutput.outputs.some(
              (output) => output._tag === "stream" && output.text.includes("42"),
            ),
          ).toBe(true);
          expect(
            (yield* workspaceFileSystem.readFile({
              cwd: projectRoot,
              relativePath: "scient-matlab-output.txt",
            })).contents,
          ).toBe("workspace output");
          expect(
            yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            }),
          ).toMatchObject({
            variables: expect.arrayContaining([
              expect.objectContaining({ name: "answer", typeName: "double", preview: "41" }),
              expect.objectContaining({ name: "local_answer", preview: "82" }),
            ]),
          });

          const figureId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-first",
            "figure; plot(1:4, [1 4 2 3]); title('Scient MATLAB');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, figureId)).toBe(
            "succeeded",
          );
          const figureOutput = yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: figureId,
          });
          const figure = projectComputeOutputs(figureOutput.outputs).find(
            (output) =>
              output._tag === "representation" &&
              output.bundle.representations.some(
                (representation) => representation.mediaType === "image/png",
              ),
          );
          expect(figure?._tag).toBe("representation");
          if (figure?._tag === "representation") {
            expect(figure.displayId).toMatch(/^matlab-figure:/u);
            for (const mediaType of ["image/png", "application/vnd.mathworks.matlab.figure"]) {
              const resource = figure.bundle.representations.find(
                (item) => item.mediaType === mediaType,
              )?.data;
              if (resource?._tag !== "resource")
                return yield* Effect.die(`MATLAB ${mediaType} not retained.`);
              const retained = yield* compute.resolveOutputResource({
                projectId: session.projectId,
                sessionId,
                executionId: figureId,
                contentHash: resource.contentHash,
              });
              if (retained === null) return yield* Effect.die("MATLAB figure was not retained.");
              expect((yield* fs.readFile(retained.path)).byteLength).toBeGreaterThan(100);
            }
          }

          const unchangedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-unchanged",
            "disp('unchanged figure');",
          );
          yield* waitForTerminal(gateway, projectRoot, sessionId, unchangedId);
          expect(
            (yield* gateway.listOutputs({
              cwd: projectRoot,
              sessionId,
              executionId: unchangedId,
            })).outputs.some(
              (output) => output._tag === "display-data" || output._tag === "display-update",
            ),
          ).toBe(false);
          const changedFigureId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-changed",
            "plot(1:4, [4 3 2 1]); title('Scient MATLAB changed');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, changedFigureId)).toBe(
            "succeeded",
          );
          const changedFigure = (yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: changedFigureId,
          })).outputs.find((output) => output._tag === "display-update");
          expect(changedFigure?._tag).toBe("display-update");
          if (changedFigure?._tag === "display-update" && figure?._tag === "representation") {
            expect(changedFigure.displayId).toBe(figure.displayId);
            expect(
              changedFigure.bundle.representations.find((item) => item.mediaType === "image/png")
                ?.data,
            ).not.toEqual(
              figure.bundle.representations.find((item) => item.mediaType === "image/png")?.data,
            );
          }
          const closeFiguresId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-close-figures",
            "close all force;",
          );
          yield* waitForTerminal(gateway, projectRoot, sessionId, closeFiguresId);
          const reopenedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-reopened",
            "figure(1); plot(1:3); close(gcf); figure(1); plot(3:-1:1);",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, reopenedId)).toBe(
            "succeeded",
          );
          const reopened = (yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: reopenedId,
          })).outputs.find((output) => output._tag === "display-data");
          expect(reopened?._tag).toBe("display-data");
          if (reopened?._tag === "display-data" && figure?._tag === "representation") {
            expect(reopened.displayId).not.toBe(figure.displayId);
          }
          const cleanupFiguresId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figures-cleanup",
            "close all force;",
          );
          yield* waitForTerminal(gateway, projectRoot, sessionId, cleanupFiguresId);

          // Exercise the complete gateway -> transport -> native-file path, not just helper text.
          yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            relativePath: "source/adjacent.txt",
            contents: "adjacent-source",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            relativePath: "source/sibling.m",
            contents: "function value = sibling()\nvalue = 21;\nend\n",
          });
          const sourceCode = [
            "source_name = mfilename('fullpath');",
            "assert(endsWith(source_name, fullfile('source', 'native_identity')));",
            "assert(strcmp(fileread(fullfile(fileparts(source_name), 'adjacent.txt')), 'adjacent-source'));",
            "assert(local_double(sibling()) == 42);",
            "disp('NATIVE_SOURCE_OK');",
            "function result = local_double(value)",
            "result = value * 2;",
            "end",
          ].join("\n");
          const sourceFile = yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            relativePath: "source/native_identity.m",
            contents: sourceCode,
          });
          const sourceId = ComputeExecutionId.make("matlab-native-source");
          yield* gateway.submitExecution({
            cwd: projectRoot,
            sessionId,
            executionId: sourceId,
            expectedGeneration: session.generation,
            code: sourceCode,
            source: {
              _tag: "document",
              origin: "file",
              path: sourceFile.relativePath,
              revision: sourceFile.revision,
              bufferState: "saved",
              range: null,
            },
          });
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, sourceId)).toBe(
            "succeeded",
          );

          const tableId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-neutral-tables",
            "qa_table = table((1:5000)', sin((1:5000)'), 'VariableNames', {'sample','value'}); qa_timetable = timetable(seconds((1:3)'), [1;NaN;3], 'VariableNames', {'value'});",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, tableId)).toBe(
            "succeeded",
          );
          const tableOutputs = projectComputeOutputs(
            (yield* gateway.listOutputs({ cwd: projectRoot, sessionId, executionId: tableId }))
              .outputs,
          );
          const tablePreviewSchema = Schema.fromJsonString(
            Schema.Struct({
              schema: Schema.Struct({
                fields: Schema.Array(Schema.Struct({ name: Schema.String })),
              }),
              data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
              scientPreview: Schema.Struct({ truncated: Schema.Boolean }),
            }),
          );
          for (const [name, rows, columns, truncated] of [
            ["qa_table", 100, 2, true],
            ["qa_timetable", 3, 2, false],
          ] as const) {
            const table = tableOutputs.find(
              (output) =>
                output._tag === "representation" && output.displayId === `matlab-table:${name}`,
            );
            if (table?._tag !== "representation")
              return yield* Effect.die(`Missing structured ${name}`);
            const representation = table.bundle.representations.find(
              (entry) => entry.mediaType === "application/vnd.dataresource+json",
            );
            if (representation?.data._tag !== "json")
              return yield* Effect.die(`Missing inline table preview: ${name}`);
            const preview = yield* Schema.decodeUnknownEffect(tablePreviewSchema)(
              representation.data.json,
            );
            expect(preview.data).toHaveLength(rows);
            expect(preview.schema.fields).toHaveLength(columns);
            expect(preview.scientPreview.truncated).toBe(truncated);
          }

          const diagnosticCode = [
            "retained_after_failure = 7;",
            "error('Scient:Expected', 'expected failure');",
          ].join("\n");
          const diagnosticFile = yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            // Numbered scripts are common in ordered research folders but MATLAB's
            // native run() cannot evaluate their stems as identifiers.
            relativePath: "05_diagnostic_test.m",
            contents: diagnosticCode,
          });
          const failedId = ComputeExecutionId.make("matlab-expected-error");
          yield* gateway.submitExecution({
            cwd: projectRoot,
            sessionId,
            executionId: failedId,
            expectedGeneration: session.generation,
            code: diagnosticCode,
            source: {
              _tag: "document",
              origin: "file",
              path: diagnosticFile.relativePath,
              bufferState: "saved",
              revision: diagnosticFile.revision,
              range: null,
            },
          });
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, failedId)).toBe("failed");
          expect(
            (yield* gateway.listOutputs({ cwd: projectRoot, sessionId, executionId: failedId }))
              .outputs,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                _tag: "diagnostic",
                diagnostic: expect.objectContaining({
                  errorName: "Scient:Expected",
                  frames: expect.arrayContaining([
                    expect.objectContaining({ relativePath: "05_diagnostic_test.m", line: 2 }),
                  ]),
                }),
              }),
            ]),
          );
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            })).variables,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "retained_after_failure", preview: "7" }),
            ]),
          );

          const seedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-rapid-seed",
            "rapid_counter = 0;",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, seedId)).toBe("succeeded");
          for (let batch = 0; batch < 4; batch += 1) {
            const rapidIds = yield* Effect.forEach(
              Array.from({ length: 10 }, (_, index) => batch * 10 + index + 1),
              (index) =>
                submit(
                  gateway,
                  projectRoot,
                  sessionId,
                  session.generation,
                  `matlab-rapid-${String(index)}`,
                  "rapid_counter = rapid_counter + 1;",
                ),
              { concurrency: "unbounded" },
            );
            for (const executionId of rapidIds) {
              expect(yield* waitForTerminal(gateway, projectRoot, sessionId, executionId)).toBe(
                "succeeded",
              );
            }
          }
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            })).variables,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "rapid_counter", preview: "40" }),
            ]),
          );

          const floodId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-output-flood",
            "fprintf(repmat('flood-line\\n', 1, 20000));",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, floodId)).toBe(
            "succeeded",
          );

          const interruptedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-interrupt",
            "pause(60);",
          );
          yield* waitForBusy(gateway, projectRoot, sessionId);
          yield* gateway.interruptSession({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: session.generation,
          });
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, interruptedId)).toBe(
            "cancelled",
          );
          const afterInterruptId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-after-interrupt",
            "disp('after interrupt');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, afterInterruptId)).toBe(
            "succeeded",
          );

          const restarted = yield* gateway.restartSession({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          expect(restarted.generation).not.toBe(session.generation);
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: restarted.generation,
            })).variables,
          ).toEqual([]);
          expect(
            (yield* gateway.stopSession({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: restarted.generation,
            })).status,
          ).toBe("stopped");
          if (TEST_HELPER) {
            yield* gateway.manageRuntime({ languageId: MATLAB, action: "remove" });
            for (;;) {
              const status = yield* gateway.managedRuntimeStatus({ languageId: MATLAB });
              if (status.operation === null) {
                expect(status.failureMessage).toBeNull();
                expect(status.installed).toBe(false);
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
        }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)), Effect.scoped);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.scoped,
        Effect.timeout(TEST_HELPER ? "15 minutes" : "6 minutes"),
      ),
  );
});
