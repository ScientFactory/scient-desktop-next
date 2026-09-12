// @effect-diagnostics nodeBuiltinImport:off -- this opt-in qualification provisions real pinned artifacts.
import * as NodeProcess from "node:process";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "./ComputeSessionService.ts";
import { makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import * as PythonComputeRuntime from "./PythonComputeRuntime.ts";

const ENABLED = NodeProcess.env.SCIENT_TEST_MANAGED_PYTHON === "1";
const PYTHON = ComputeLanguageId.make("python");

describe.runIf(ENABLED)("Scient-managed Python product", () => {
  it.live(
    "provisions, selects, executes scientific work, and removes only its private environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-managed-python-project-",
        });
        const stateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-managed-python-state-",
        });
        yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

        const computeLayer = PythonComputeRuntime.layer.pipe(
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
                  languages: { [PYTHON]: { enabled: true, executable: "" } },
                },
              }),
            },
          });

          const initial = yield* awaitStatus(gateway, (status) => status.operation === null);
          expect(initial).toMatchObject({
            installed: false,
            selection: "existing",
          });
          const started = yield* gateway.manageRuntime({ languageId: PYTHON, action: "install" });
          expect(started.operation).not.toBeNull();
          const installed = yield* awaitStatus(
            gateway,
            (status) => status.operation === null && status.installed,
          );
          expect(installed).toMatchObject({
            installed: true,
            selection: "managed",
            updateAvailable: false,
            failureMessage: null,
          });

          const inventoried = (yield* gateway.runtimeInventory()).languages[0]?.installations[0];
          expect(inventoried).toMatchObject({ source: "managed", problem: null });
          expect(inventoried?.version).toMatch(/^3\./u);

          const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
          const managed = inspection.languages
            .find((language) => language.descriptor.languageId === PYTHON)
            ?.runtimes.find((runtime) => runtime.profile.source === "managed");
          expect(managed?.verification.readiness).toBe("ready");
          expect(managed?.toolkits.every((toolkit) => toolkit.readiness === "ready")).toBe(true);
          if (managed === undefined) return yield* Effect.die("Managed Python was not discovered.");

          const sessionId = ComputeSessionId.make("managed-python-live-session");
          const session = yield* gateway.startSession({
            cwd: projectRoot,
            sessionId,
            languageId: PYTHON,
            executable: managed.profile.executable,
          });
          const executionId = ComputeExecutionId.make("managed-python-scientific-check");
          yield* gateway.submitExecution({
            cwd: projectRoot,
            sessionId,
            executionId,
            expectedGeneration: session.generation,
            code: [
              "import matplotlib.pyplot as plt",
              "import numpy as np",
              "import pandas as pd",
              "from IPython.display import display",
              "from scipy import stats",
              "x = np.arange(6, dtype=float)",
              "frame = pd.DataFrame({'x': x, 'z': stats.zscore(x)})",
              "display(frame)",
              "figure, axis = plt.subplots()",
              "axis.plot(frame['x'], frame['z'])",
              "display(figure)",
              "plt.close(figure)",
            ].join("\n"),
            source: { _tag: "console" },
          });
          const execution = yield* awaitExecution(gateway, projectRoot, sessionId, executionId);
          expect(execution.result?.status).toBe("succeeded");
          const outputs = yield* gateway.listOutputs({ cwd: projectRoot, sessionId, executionId });
          expect(outputs.outputs.some((output) => output._tag === "display-data")).toBe(true);

          const blocked = yield* Effect.flip(
            gateway.manageRuntime({ languageId: PYTHON, action: "remove" }),
          );
          expect(blocked.message).toContain("Stop live python sessions");
          yield* gateway.stopSession({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: session.generation,
          });
          yield* gateway.manageRuntime({ languageId: PYTHON, action: "remove" });
          const removed = yield* awaitStatus(
            gateway,
            (status) => status.operation === null && !status.installed,
          );
          expect(removed.failureMessage).toBeNull();
          expect(
            (yield* gateway.runtimeInventory()).languages[0]?.installations.some(
              (runtime) => runtime.source === "managed",
            ),
          ).toBe(false);
        }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.timeout("40 minutes")),
  );
});

type ComputeGateway = ReturnType<typeof makeComputeRpcGateway>;

const awaitStatus = Effect.fn("ManagedPythonProduct.awaitStatus")(function* (
  gateway: ComputeGateway,
  accepted: (status: ComputeManagedRuntimeStatus) => boolean,
) {
  for (let attempt = 0; attempt < 7_200; attempt += 1) {
    const status = yield* gateway.managedRuntimeStatus({ languageId: PYTHON });
    if (status.operation === null && status.failureMessage !== null) {
      return yield* Effect.die(new Error(status.failureMessage));
    }
    if (accepted(status)) return status;
    yield* Effect.sleep("250 millis");
  }
  return yield* Effect.die(new Error("Scientific Python did not settle within 30 minutes."));
});

const awaitExecution = Effect.fn("ManagedPythonProduct.awaitExecution")(function* (
  gateway: ComputeGateway,
  cwd: string,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
) {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const executions = yield* gateway.listExecutions({ cwd, sessionId, limit: 100 });
    const execution = executions.find((candidate) => candidate.request.executionId === executionId);
    if (
      execution?.result !== null &&
      execution?.result !== undefined &&
      TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
    ) {
      return execution;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("Managed Python execution did not finish."));
});
