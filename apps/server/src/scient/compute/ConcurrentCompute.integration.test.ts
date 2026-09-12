// @effect-diagnostics nodeBuiltinImport:off -- gated native qualification of owned process trees.
import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeSessionRecord,
} from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LocalAnalysisStore from "../analysis/LocalAnalysisStore.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import * as ScientificRuntimePreferences from "./ScientificRuntimePreferences.ts";
import { ComputeSessionService, layerWithRuntimeBindings } from "./ComputeSessionService.ts";
import { pythonRuntimeBinding } from "./PythonComputeRuntime.ts";
import { matlabRuntimeBinding } from "./MatlabComputeRuntime.ts";

const PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const MATLAB = NodeProcess.env.SCIENT_TEST_MATLAB;
const PROJECT = ComputeProjectId.make("native-concurrent-compute");

const eventually = Effect.fn("ConcurrentCompute.eventually")(function* <A, E, R>(
  read: Effect.Effect<A | null, E, R>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = yield* read;
    if (value !== null) return value;
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(new Error("The native compute condition did not settle."));
});

/** Measurements only: inspect descendants of this test's exact bridge PIDs. */
function ownedProcesses(roots: ReadonlyArray<number>) {
  if (NodeProcess.platform === "win32") return [];
  const rows = NodeChildProcess.execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, rss] = line.trim().split(/\s+/u).map(Number);
      return { pid: pid!, parent: parent!, rss: rss! };
    });
  const ids = new Set(roots);
  for (;;) {
    const previous = ids.size;
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
    if (ids.size === previous) break;
  }
  return rows.filter((row) => ids.has(row.pid));
}

describe.runIf(Boolean(PYTHON && MATLAB))("native independent Compute contexts", () => {
  it.live(
    "runs two Python and two MATLAB namespaces concurrently and closes only their owned processes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-compute-parallel-project-",
        });
        const state = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-compute-parallel-state-",
        });
        const sessions: ComputeSessionRecord[] = [];
        let ownedPids: number[] = [];
        const layer = layerWithRuntimeBindings(
          Effect.all([pythonRuntimeBinding, matlabRuntimeBinding]),
        ).pipe(
          Layer.provide(
            ScientificRuntimePreferences.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(LocalAnalysisStore.layer),
            ),
          ),
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(ServerConfig.layerTest(cwd, state)),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const plan = [
            { id: "python-a", language: "python", executable: PYTHON! },
            { id: "python-b", language: "python", executable: PYTHON! },
            { id: "matlab-a", language: "matlab", executable: MATLAB! },
            { id: "matlab-b", language: "matlab", executable: MATLAB! },
          ];
          const startedAt = yield* Clock.currentTimeMillis;
          sessions.push(
            ...(yield* Effect.forEach(
              plan,
              (entry) =>
                service.startSession({
                  projectId: PROJECT,
                  sessionId: ComputeSessionId.make(entry.id),
                  languageId: ComputeLanguageId.make(entry.language),
                  label: entry.id,
                  workingDirectory: cwd,
                  configuredExecutable: entry.executable,
                }),
              { concurrency: 2 },
            )),
          );
          expect(
            new Set(sessions.map((session) => session.identity?.transportProcessId)).size,
          ).toBe(4);
          const roots = sessions.flatMap((session) =>
            session.identity?.transportProcessId == null
              ? []
              : [session.identity.transportProcessId],
          );
          const processes = ownedProcesses(roots);
          ownedPids = processes.map((row) => row.pid);
          const measurement = {
            sessions: sessions.length,
            startupMs: (yield* Clock.currentTimeMillis) - startedAt,
            ownedProcessCount: processes.length,
            totalRssMiB: Math.round(processes.reduce((sum, row) => sum + row.rss, 0) / 1024),
            sessionRssMiB: sessions.map((session) => ({
              languageId: session.languageId,
              rssMiB: Math.round(
                ownedProcesses(
                  session.identity?.transportProcessId == null
                    ? []
                    : [session.identity.transportProcessId],
                ).reduce((sum, row) => sum + row.rss, 0) / 1024,
              ),
            })),
          };
          yield* Effect.logInfo("Native Compute baseline", measurement);
          const reportPath = NodeProcess.env.SCIENT_COMPUTE_QUALIFICATION_REPORT;
          if (reportPath)
            yield* fs.writeFileString(
              reportPath,
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(measurement),
            );
          const submit = (session: ComputeSessionRecord, suffix: string, code: string) =>
            service.submitExecution({
              projectId: PROJECT,
              sessionId: session.sessionId,
              expectedGeneration: session.generation,
              executionId: ComputeExecutionId.make(`${session.sessionId}-${suffix}`),
              code,
              source: { _tag: "console" },
            });
          const finished = (session: ComputeSessionRecord, suffix: string) =>
            eventually(
              service.listExecutions({ projectId: PROJECT, sessionId: session.sessionId }).pipe(
                Effect.map((rows) => {
                  const row = rows.find(
                    (candidate) =>
                      candidate.request.executionId === `${session.sessionId}-${suffix}`,
                  );
                  return row?.result && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(row.result.status)
                    ? row
                    : null;
                }),
              ),
            );
          yield* Effect.forEach(
            sessions,
            (session, index) =>
              submit(
                session,
                "hold",
                session.languageId === "python"
                  ? `import time\nfrom pathlib import Path\nunique_value = ${index}\nPath('started-${index}').write_text('running')\ntime.sleep(120)`
                  : `unique_value = ${index}; fid = fopen('started-${index}', 'w'); fprintf(fid, 'running'); fclose(fid); pause(120);`,
              ),
            { concurrency: "unbounded" },
          );
          yield* eventually(
            service
              .listSessions({ projectId: PROJECT })
              .pipe(
                Effect.map((rows) =>
                  rows.filter((row) => row.activity === "busy").length === 4 ? true : null,
                ),
              ),
          );
          // "running" is admission; MATLAB Engine may buffer stdout until completion.
          // A test-owned file proves that each runtime entered its long-running code.
          for (let index = 0; index < sessions.length; index += 1)
            yield* eventually(
              fs
                .exists(`${cwd}/started-${index}`)
                .pipe(Effect.map((exists) => (exists ? true : null))),
            );
          // Pending code belongs to each namespace. Stop A must not run its queue or stop B.
          yield* Effect.forEach(
            sessions,
            (session, index) =>
              submit(
                session,
                "queued",
                session.languageId === "python"
                  ? `assert unique_value == ${index}\nprint('ISOLATED')`
                  : `assert(unique_value == ${index}); disp('ISOLATED');`,
              ),
            { concurrency: "unbounded" },
          );
          expect(
            (yield* service.listSessions({ projectId: PROJECT })).filter(
              (session) => session.activity === "busy",
            ),
          ).toHaveLength(4);
          for (const index of [0, 2]) {
            const session = sessions[index]!;
            expect(
              (yield* service.stopSession({
                projectId: PROJECT,
                sessionId: session.sessionId,
                expectedGeneration: session.generation,
              })).status,
            ).toBe("stopped");
            expect((yield* finished(session, "hold")).result?.status).toBe("cancelled");
            expect((yield* finished(session, "queued")).result?.status).toBe("cancelled");
          }
          for (const index of [1, 3]) {
            const session = sessions[index]!;
            expect(
              (yield* service.getSession({ projectId: PROJECT, sessionId: session.sessionId }))
                ?.status,
            ).toBe("ready");
            yield* service.interruptSession({
              projectId: PROJECT,
              sessionId: session.sessionId,
              expectedGeneration: session.generation,
            });
            expect((yield* finished(session, "hold")).result?.status).toBe("cancelled");
            expect((yield* finished(session, "queued")).result?.status, session.sessionId).toBe(
              "succeeded",
            );
            const outputs = yield* service.listOutputs({
              projectId: PROJECT,
              sessionId: session.sessionId,
              executionId: ComputeExecutionId.make(`${session.sessionId}-queued`),
            });
            expect(
              outputs.outputs.some(
                (output) => output._tag === "stream" && output.text.includes("ISOLATED"),
              ),
            ).toBe(true);
          }
        }).pipe(
          Effect.provide(layer),
          Effect.scoped,
          Effect.ensuring(
            eventually(
              // Always check cleanup, even when a native behavior assertion fails.
              // The service scope has closed; never kill arbitrary processes to make this pass.
              Effect.sync(() =>
                ownedPids.every((pid) => {
                  try {
                    NodeProcess.kill(pid, 0);
                    return false;
                  } catch {
                    return true;
                  }
                })
                  ? true
                  : null,
              ),
            ),
          ),
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.consolePretty()]))),
        Effect.scoped,
      ),
    { timeout: 240_000 },
  );
});
