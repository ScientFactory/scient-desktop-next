import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { executionOutputContentParts } from "@scientfactory/execution";
import { initializeScientProject } from "@scientfactory/project-init";
import { AnalysisSourceRevision, WS_METHODS } from "@t3tools/contracts";
import { assert, type Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ScientRpcServerTestHarness } from "../../server.test.ts";

// Registered by server.test.ts so these cases exercise the same T3 server seam.
export const registerAnalysisRpcTests = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  harness: ScientRpcServerTestHarness,
): void => {
  const { buildAppUnderTest, fetchEffect, getHttpServerUrl, getWsServerUrl, withWsRpcClient } =
    harness;

  it.effect("runs a project-owned MATLAB file through the analysis RPC and streams output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-rpc-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-rpc-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      const sourcePath = path.join(workspaceDir, "analysis.m");
      yield* Effect.promise(() =>
        initializeScientProject({ root: workspaceDir, title: "MATLAB RPC Test" }),
      );
      yield* fs.writeFileString(sourcePath, "disp('scient-analysis-ok');\n");
      yield* fs.writeFileString(
        matlabExecutable,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const source = process.env.SCIENT_MATLAB_ENTRYPOINT;",
          "if (!source || !fs.readFileSync(source, 'utf8').includes('scient-analysis-ok')) process.exit(2);",
          "const artifacts = process.env.SCIENT_MATLAB_ARTIFACT_DIR;",
          "if (!artifacts || !process.env.SCIENT_MATLAB_RUNNER) process.exit(3);",
          "fs.mkdirSync(artifacts, { recursive: true });",
          "fs.writeFileSync(`${artifacts}/figure-001.png`, Buffer.from([137, 80, 78, 71]));",
          "fs.writeFileSync(`${artifacts}/figure-001.fig`, 'scient-analysis-figure');",
          "console.log('stdout:scient-analysis-ok');",
          "console.error('stderr:diagnostic');",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            assert.equal(inspection.runtimes[0]?.availability, "available");
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            const events = yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            }).pipe(
              Stream.filterMap((event) =>
                event._tag === "run-updated" && event.run.receipt.runId === started.receipt.runId
                  ? Result.succeed(event.run)
                  : Result.failVoid,
              ),
              Stream.takeUntil((run) =>
                ["succeeded", "failed", "cancelled", "lost"].includes(run.receipt.status),
              ),
              Stream.runCollect,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for MATLAB run output.")),
              }),
            );
            const terminal = events.at(-1)!;
            const listed = yield* client[WS_METHODS.analysisListRuns]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            });
            assert.isFalse("output" in listed.runs[0]!.receipt);
            assert.equal(terminal.receipt.status, "succeeded");
            const terminalRun = yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const figure = terminalRun.artifacts[0]?.representations.find(
              (representation) =>
                representation.mediaType === "application/vnd.mathworks.matlab.figure",
            );
            assert.isDefined(figure);
            const asset = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "analysis-artifact",
                projectId: terminalRun.projectId,
                runId: terminalRun.receipt.runId,
                artifactId: terminalRun.artifacts[0]!.artifactId,
                representationId: figure!.representationId,
              },
            });
            return { terminalRun, asset };
          }),
        ),
      );
      const { terminalRun, asset } = result;

      assert.equal(terminalRun.receipt.status, "succeeded");
      assert.equal(terminalRun.receipt.exitCode, 0);
      const outputHash = NodeCrypto.createHash("sha256");
      for (const part of executionOutputContentParts(terminalRun.receipt.output)) {
        outputHash.update(part, "utf8");
      }
      assert.equal(terminalRun.receipt.outputContentHash, `sha256:${outputHash.digest("hex")}`);
      const output = terminalRun.receipt.output.map((chunk) => chunk.text).join("");
      assert.include(output, "stdout:scient-analysis-ok");
      assert.include(output, "stderr:diagnostic");
      assert.deepEqual(
        terminalRun.artifacts[0]?.representations.map((representation) => representation.mediaType),
        ["application/vnd.mathworks.matlab.figure", "image/png"],
      );
      const assetResponse = yield* fetchEffect(yield* getHttpServerUrl(asset.relativeUrl));
      assert.equal(assetResponse.status, 200);
      assert.equal(yield* assetResponse.text, "scient-analysis-figure");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("cleans retained MATLAB data without deleting its history or provenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-cleanup-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-cleanup-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "cleanup.m"), "disp('retain receipt');\n");
      yield* fs.writeFileString(
        matlabExecutable,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const artifacts = process.env.SCIENT_MATLAB_ARTIFACT_DIR;",
          "fs.mkdirSync(artifacts, { recursive: true });",
          "fs.writeFileSync(`${artifacts}/figure-001.png`, Buffer.from([137, 80, 78, 71, 13, 10]));",
          "console.log('cleanup-preserves-provenance');",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "cleanup.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "cleanup.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "cleanup.m",
            }).pipe(
              Stream.filter(
                (event) =>
                  event._tag !== "run-output" &&
                  event.run.receipt.runId === started.receipt.runId &&
                  event.run.receipt.status === "succeeded",
              ),
              Stream.runHead,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for cleanup fixture.")),
              }),
            );

            const beforeRun = yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const beforeStorage = yield* client[WS_METHODS.analysisStorageSummary]({
              cwd: workspaceDir,
            });
            const staleProjectCleanup = yield* client[WS_METHODS.analysisCleanupProject]({
              cwd: workspaceDir,
              expectedRetainedBytes: beforeStorage.totalBytes + 1,
            }).pipe(Effect.result);
            const firstCleanup = yield* client[WS_METHODS.analysisCleanupRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const afterRun = yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const listed = yield* client[WS_METHODS.analysisListRuns]({
              cwd: workspaceDir,
              relativePath: "cleanup.m",
            });
            const secondCleanup = yield* client[WS_METHODS.analysisCleanupRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const removedArtifact = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "analysis-artifact",
                projectId: afterRun.projectId,
                runId: afterRun.receipt.runId,
                artifactId: afterRun.artifacts[0]!.artifactId,
                representationId: afterRun.artifacts[0]!.representations[0]!.representationId,
              },
            }).pipe(Effect.result);
            return {
              beforeRun,
              beforeStorage,
              staleProjectCleanup,
              firstCleanup,
              afterRun,
              listed,
              secondCleanup,
              removedArtifact,
            };
          }),
        ),
      );

      assert.isAbove(result.beforeStorage.totalBytes, 0);
      assert.equal(result.beforeStorage.retainedRunCount, 1);
      assert.equal(result.staleProjectCleanup._tag, "Failure");
      if (result.staleProjectCleanup._tag === "Failure") {
        assert.equal(result.staleProjectCleanup.failure._tag, "AnalysisOperationError");
        if (result.staleProjectCleanup.failure._tag === "AnalysisOperationError") {
          assert.equal(result.staleProjectCleanup.failure.reason, "operation-failed");
        }
      }
      assert.equal(result.firstCleanup.cleanedRunCount, 1);
      assert.equal(result.firstCleanup.freedBytes, result.beforeStorage.totalBytes);
      assert.deepEqual(result.firstCleanup.storage, {
        retainedRunCount: 0,
        metadataOnlyRunCount: 1,
        outputBytes: 0,
        artifactBytes: 0,
        totalBytes: 0,
      });
      assert.equal(result.afterRun.localStorage.status, "metadata-only");
      assert.deepEqual(result.afterRun.receipt.output, []);
      assert.equal(
        result.afterRun.receipt.outputByteLength,
        result.beforeRun.receipt.outputByteLength,
      );
      assert.equal(
        result.afterRun.receipt.outputContentHash,
        result.beforeRun.receipt.outputContentHash,
      );
      assert.deepEqual(result.afterRun.artifacts, result.beforeRun.artifacts);
      assert.equal(result.listed.runs[0]?.localStorage.status, "metadata-only");
      assert.equal(result.secondCleanup.cleanedRunCount, 0);
      assert.equal(result.secondCleanup.freedBytes, 0);
      assert.equal(result.removedArtifact._tag, "Failure");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect(
    "verifies MATLAB explicitly and reuses the executable-identity cache until refresh",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-verify-project-",
        });
        const runtimeDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-verify-runtime-",
        });
        const matlabExecutable = path.join(runtimeDir, "matlab");
        const launchesPath = path.join(runtimeDir, "launches.txt");
        yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
        yield* fs.writeFileString(
          matlabExecutable,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "fs.appendFileSync(path.join(path.dirname(__filename), 'launches.txt'), 'verify\\n');",
            "fs.writeFileSync(process.env.SCIENT_MATLAB_VERIFY_RESULT, JSON.stringify({",
            "  release: 'R2026a', version: '26.1', architecture: 'maca64',",
            "  installationRoot: '/Applications/MATLAB_R2026a.app',",
            "  javaAvailable: true, javaVersion: 'Java 21',",
            "  toolboxes: [{ name: 'MATLAB', version: '26.1' }]",
            "}));",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(matlabExecutable, 0o755);

        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        const verifications = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const configured = yield* client[WS_METHODS.analysisConfigureRuntime]({
                cwd: workspaceDir,
                runtimeKind: "matlab",
                executablePath: matlabExecutable,
              });
              const runtimeId = configured.runtimes[0]!.id;
              const first = yield* client[WS_METHODS.analysisVerifyRuntime]({
                cwd: workspaceDir,
                runtimeId,
              });
              const cached = yield* client[WS_METHODS.analysisVerifyRuntime]({
                cwd: workspaceDir,
                runtimeId,
              });
              const refreshed = yield* client[WS_METHODS.analysisVerifyRuntime]({
                cwd: workspaceDir,
                runtimeId,
                refresh: true,
              });
              return { first, cached, refreshed };
            }),
          ),
        );

        assert.equal(verifications.first.verification?.status, "ready");
        assert.equal(verifications.first.verification?.release, "R2026a");
        assert.equal(verifications.first.verification?.javaAvailable, true);
        assert.deepEqual(verifications.first.verification?.toolboxes, [
          { name: "MATLAB", version: "26.1" },
        ]);
        assert.deepEqual(verifications.cached.verification, verifications.first.verification);
        assert.equal(verifications.refreshed.verification?.status, "ready");
        assert.equal((yield* fs.readFileString(launchesPath)).trim().split("\n").length, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect(
    "runs one MATLAB process at a time in FIFO order and skips a cancelled queued run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-queue-project-",
        });
        const runtimeDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-queue-runtime-",
        });
        const matlabExecutable = path.join(runtimeDir, "matlab");
        const orderPath = path.join(runtimeDir, "order.txt");
        yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
        for (const fileName of ["first.m", "cancelled.m", "third.m"]) {
          yield* fs.writeFileString(path.join(workspaceDir, fileName), `disp('${fileName}');\n`);
        }
        yield* fs.writeFileString(
          matlabExecutable,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const runtimeDir = path.dirname(__filename);",
            "const active = path.join(runtimeDir, 'active');",
            "const order = path.join(runtimeDir, 'order.txt');",
            "const name = path.basename(process.env.SCIENT_MATLAB_ENTRYPOINT);",
            "if (fs.existsSync(active)) { fs.appendFileSync(order, `overlap:${name}\\n`); process.exit(9); }",
            "fs.writeFileSync(active, name);",
            "fs.appendFileSync(order, `start:${name}\\n`);",
            "setTimeout(() => {",
            "  fs.rmSync(active, { force: true });",
            "  fs.appendFileSync(order, `end:${name}\\n`);",
            "}, 250);",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(matlabExecutable, 0o755);

        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
                cwd: workspaceDir,
                runtimeKind: "matlab",
                executablePath: matlabExecutable,
              });
              const runtimeId = inspection.runtimes[0]!.id;
              const revisions = new Map<string, AnalysisSourceRevision>();
              for (const fileName of ["first.m", "cancelled.m", "third.m"]) {
                const source = yield* client[WS_METHODS.projectsReadFile]({
                  cwd: workspaceDir,
                  relativePath: fileName,
                });
                revisions.set(fileName, AnalysisSourceRevision.make(source.revision));
              }
              const first = yield* client[WS_METHODS.analysisStartRun]({
                cwd: workspaceDir,
                relativePath: "first.m",
                sourceRevision: revisions.get("first.m")!,
                runtimeId,
              });
              const cancelled = yield* client[WS_METHODS.analysisStartRun]({
                cwd: workspaceDir,
                relativePath: "cancelled.m",
                sourceRevision: revisions.get("cancelled.m")!,
                runtimeId,
              });
              const third = yield* client[WS_METHODS.analysisStartRun]({
                cwd: workspaceDir,
                relativePath: "third.m",
                sourceRevision: revisions.get("third.m")!,
                runtimeId,
              });
              assert.isAtLeast(cancelled.queuePosition ?? 0, 1);
              assert.isAtLeast(third.queuePosition ?? 0, 2);
              const cancelledReceipt = yield* client[WS_METHODS.analysisCancelRun]({
                cwd: workspaceDir,
                runId: cancelled.receipt.runId,
              });
              assert.equal(cancelledReceipt.receipt.status, "cancelled");
              const terminalThird = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 100; attempt += 1) {
                  const run = yield* client[WS_METHODS.analysisGetRun]({
                    cwd: workspaceDir,
                    runId: third.receipt.runId,
                  });
                  if (["succeeded", "failed", "cancelled", "lost"].includes(run.receipt.status)) {
                    return run;
                  }
                  yield* Effect.sleep("50 millis");
                }
                return yield* Effect.die(
                  new Error("Timed out waiting for the third queued MATLAB run."),
                );
              });
              return {
                first: yield* client[WS_METHODS.analysisGetRun]({
                  cwd: workspaceDir,
                  runId: first.receipt.runId,
                }),
                cancelled: yield* client[WS_METHODS.analysisGetRun]({
                  cwd: workspaceDir,
                  runId: cancelled.receipt.runId,
                }),
                third: terminalThird,
              };
            }),
          ),
        );

        assert.equal(result.first.receipt.status, "succeeded");
        assert.equal(result.cancelled.receipt.status, "cancelled");
        assert.equal(result.third.receipt.status, "succeeded");
        assert.deepEqual((yield* fs.readFileString(orderPath)).trim().split("\n"), [
          "start:first.m",
          "end:first.m",
          "start:third.m",
          "end:third.m",
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("keeps captured MATLAB figures when the source later fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-failed-artifact-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-failed-artifact-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "partial.m"), "error('after plot');\n");
      yield* fs.writeFileString(
        matlabExecutable,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const artifacts = process.env.SCIENT_MATLAB_ARTIFACT_DIR;",
          "fs.mkdirSync(artifacts, { recursive: true });",
          "fs.writeFileSync(`${artifacts}/figure-001.png`, Buffer.from([137, 80, 78, 71]));",
          "fs.writeFileSync(`${artifacts}/scient-capture-failed.txt`, 'partial capture');",
          "fs.writeFileSync(process.env.SCIENT_MATLAB_DIAGNOSTIC_PATH, JSON.stringify({ identifier: 'Scient:AfterPlot', message: 'source failed after drawing', stack: [{ file: process.env.SCIENT_MATLAB_ENTRYPOINT, name: 'partial', line: 1 }] }));",
          "console.error('source failed after drawing');",
          "process.exit(7);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const completed = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "partial.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "partial.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "partial.m",
            }).pipe(
              Stream.filter(
                (event) =>
                  event._tag === "run-updated" &&
                  event.run.receipt.runId === started.receipt.runId &&
                  event.run.receipt.status === "failed",
              ),
              Stream.runHead,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for failed MATLAB run.")),
              }),
            );
            return yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
          }),
        ),
      );

      assert.equal(completed.receipt.status, "failed");
      assert.equal(completed.receipt.exitCode, 7);
      assert.equal(completed.artifacts.length, 1);
      assert.equal(completed.artifacts[0]?.representations[0]?.mediaType, "image/png");
      assert.equal(completed.artifactReceipt.status, "failed");
      assert.include(completed.artifactReceipt.failureMessage ?? "", "could not capture every");
      assert.equal(completed.diagnostics.length, 1);
      assert.equal(completed.diagnostics[0]?.severity, "error");
      assert.equal(completed.diagnostics[0]?.code, "Scient:AfterPlot");
      assert.equal(completed.diagnostics[0]?.message, "source failed after drawing");
      assert.equal(completed.diagnostics[0]?.relativePath, "partial.m");
      assert.equal(completed.diagnostics[0]?.line, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("records artifact publication failure without falsifying a successful MATLAB run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-artifact-failure-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-artifact-failure-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "analysis.m"), "answer = 42;\n");
      yield* fs.writeFileString(
        matlabExecutable,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const artifacts = process.env.SCIENT_MATLAB_ARTIFACT_DIR;",
          "fs.mkdirSync(artifacts, { recursive: true });",
          "fs.mkdirSync(`${artifacts}/figure-001.png`);",
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const completed = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            assert.deepEqual(started.artifactReceipt, {
              status: "pending",
              failureMessage: null,
            });
            yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            }).pipe(
              Stream.filter(
                (event) =>
                  event._tag !== "run-output" &&
                  event.run.receipt.runId === started.receipt.runId &&
                  event.run.receipt.status === "succeeded",
              ),
              Stream.runHead,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for MATLAB run.")),
              }),
            );
            return yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
          }),
        ),
      );

      assert.equal(completed.receipt.status, "succeeded");
      assert.equal(completed.receipt.failureMessage, null);
      assert.deepEqual(completed.artifacts, []);
      assert.equal(completed.artifactReceipt.status, "failed");
      assert.include(completed.artifactReceipt.failureMessage ?? "", "could not collect");
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("refuses to run a MATLAB source revision that changed after it was opened", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-stale-source-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-stale-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "analysis.m"), "answer = 1;\n");
      yield* fs.writeFileString(matlabExecutable, "#!/usr/bin/env node\nprocess.exit(0);\n");
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const opened = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
            });
            yield* fs.writeFileString(path.join(workspaceDir, "analysis.m"), "answer = 2;\n");
            return yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "analysis.m",
              sourceRevision: AnalysisSourceRevision.make(opened.revision),
              runtimeId: inspection.runtimes[0]!.id,
            }).pipe(Effect.result);
          }),
        ),
      );

      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "AnalysisOperationError");
        if (result.failure._tag === "AnalysisOperationError") {
          assert.equal(result.failure.reason, "source-changed");
        }
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("bounds persisted and streamed MATLAB output without losing terminal state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-bounded-output-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-bounded-output-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "verbose.m"), "disp('verbose');\n");
      yield* fs.writeFileString(
        matlabExecutable,
        "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(5 * 1024 * 1024));\n",
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const completed = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "verbose.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "verbose.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "verbose.m",
            }).pipe(
              Stream.filter(
                (event) =>
                  event._tag === "run-updated" &&
                  event.run.receipt.runId === started.receipt.runId &&
                  ["succeeded", "failed", "cancelled", "lost"].includes(event.run.receipt.status),
              ),
              Stream.runHead,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for bounded MATLAB output.")),
              }),
            );
            return yield* client[WS_METHODS.analysisGetRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
          }),
        ),
      );

      assert.equal(completed.receipt.status, "succeeded");
      assert.equal(completed.receipt.outputByteLength, 4 * 1024 * 1024);
      assert.isTrue(completed.receipt.outputTruncated);
      assert.include(
        completed.receipt.output.map((chunk) => chunk.text).join(""),
        "Output was truncated at the 4194304-byte limit.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("cancels a MATLAB run even when Stop races process startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-cancel-project-",
      });
      const runtimeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-matlab-cancel-runtime-",
      });
      const matlabExecutable = path.join(runtimeDir, "matlab");
      yield* Effect.promise(() => initializeScientProject({ root: workspaceDir }));
      yield* fs.writeFileString(path.join(workspaceDir, "slow.m"), "pause(60);\n");
      yield* fs.writeFileString(
        matlabExecutable,
        "#!/usr/bin/env node\nconsole.log('runtime-started');\nsetInterval(() => {}, 1000);\n",
      );
      yield* fs.chmod(matlabExecutable, 0o755);

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const terminalRun = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const inspection = yield* client[WS_METHODS.analysisConfigureRuntime]({
              cwd: workspaceDir,
              runtimeKind: "matlab",
              executablePath: matlabExecutable,
            });
            const source = yield* client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "slow.m",
            });
            const started = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "slow.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            });
            const duplicate = yield* client[WS_METHODS.analysisStartRun]({
              cwd: workspaceDir,
              relativePath: "slow.m",
              sourceRevision: AnalysisSourceRevision.make(source.revision),
              runtimeId: inspection.runtimes[0]!.id,
            }).pipe(Effect.result);
            assert.equal(duplicate._tag, "Failure");
            if (duplicate._tag === "Failure") {
              assert.equal(duplicate.failure._tag, "AnalysisOperationError");
              if (duplicate.failure._tag === "AnalysisOperationError") {
                assert.equal(duplicate.failure.reason, "run-already-active");
              }
            }
            yield* client[WS_METHODS.analysisCancelRun]({
              cwd: workspaceDir,
              runId: started.receipt.runId,
            });
            const events = yield* client[WS_METHODS.subscribeAnalysisRuns]({
              cwd: workspaceDir,
              relativePath: "slow.m",
            }).pipe(
              Stream.filterMap((event) =>
                event._tag !== "run-output" && event.run.receipt.runId === started.receipt.runId
                  ? Result.succeed(event.run)
                  : Result.failVoid,
              ),
              Stream.takeUntil((run) =>
                ["succeeded", "failed", "cancelled", "lost"].includes(run.receipt.status),
              ),
              Stream.runCollect,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.die(new Error("Timed out waiting for MATLAB cancellation.")),
              }),
            );
            return events.at(-1)!;
          }),
        ),
      );

      assert.equal(terminalRun.receipt.status, "cancelled");
      assert.isTrue(terminalRun.receipt.cancellationRequested);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );
};
