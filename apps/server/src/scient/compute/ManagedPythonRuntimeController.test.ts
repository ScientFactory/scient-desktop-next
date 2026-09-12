// @effect-diagnostics nodeBuiltinImport:off -- lifecycle tests use isolated app-owned fixture roots.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeToolkitId, type ComputeManagedRuntimeStatus } from "@scientfactory/compute";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type ManagedPythonEnvironmentDependencies,
  makeManagedPythonEnvironmentManager,
} from "./ManagedPythonEnvironment.ts";
import {
  MANAGED_PYTHON_PROVISIONER_VERSION,
  MANAGED_PYTHON_TOOLKIT_REVISION,
  MANAGED_PYTHON_VERSION,
} from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";

const TOOLKIT_ID = ComputeToolkitId.make("python-data-and-figures");

describe("ManagedPythonRuntimeController", () => {
  let temporaryRoot: string;
  let computeDir: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-python-controller-"),
    );
    computeDir = NodePath.join(temporaryRoot, "compute");
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  const executableAt = async (targetRoot: string) => {
    const executable = NodePath.join(targetRoot, "environment", "bin", "python");
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "python", { mode: 0o700 });
    return { executableRelativePath: NodePath.join("environment", "bin", "python") };
  };

  const dependencies = (
    overrides: Partial<ManagedPythonEnvironmentDependencies> = {},
  ): ManagedPythonEnvironmentDependencies => ({
    provision: async ({ targetRoot }) => await executableAt(targetRoot),
    verify: async () => undefined,
    ...overrides,
  });

  it.live("reports progress immediately and publishes only after setup finishes", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot, onProgress }) => {
            onProgress?.({ phase: "downloading", downloadedBytes: 5, totalBytes: 10 });
            await gate;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      const started = yield* controller.manage("install");
      expect(started).toMatchObject({ installed: false, operation: { action: "install" } });
      expect(
        yield* waitForStatus(controller, (status) => status.operation?.phase === "downloading"),
      ).toMatchObject({
        operation: { phase: "downloading", downloadedBytes: 5, totalBytes: 10 },
      });
      release();
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        installed: true,
        selection: "managed",
        updateAvailable: false,
        operation: null,
        failureMessage: null,
      });
      controller.dispose();
    }),
  );

  it.live("cancels an unpublished setup without turning cancellation into a failure", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ signal }) =>
            await new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      expect((yield* controller.manage("install")).operation).not.toBeNull();
      yield* controller.cancel();
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        installed: false,
        operation: null,
        failureMessage: null,
      });
      controller.dispose();
    }),
  );

  it.live("coalesces concurrent setup commands into one provisioned generation", () =>
    Effect.gen(function* () {
      let release!: () => void;
      let provisions = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          provision: async ({ targetRoot }) => {
            provisions += 1;
            await gate;
            return await executableAt(targetRoot);
          },
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      const [first, second] = yield* Effect.all(
        [controller.manage("install"), controller.manage("install")],
        { concurrency: "unbounded" },
      );
      expect(first.operation).toMatchObject({ action: "install" });
      expect(first.operation?.operationId).toBe(second.operation?.operationId);
      yield* waitForStatus(controller, () => provisions === 1);
      expect(provisions).toBe(1);
      release();
      expect(yield* waitForSettled(controller)).toMatchObject({ installed: true, operation: null });
      controller.dispose();
    }),
  );

  it.live("offers an update only for an older activation receipt", () =>
    Effect.gen(function* () {
      const ids = ["old", "new"];
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({ generationId: () => ids.shift()! }),
      );
      yield* Effect.promise(() =>
        manager.install({
          toolkitIds: [TOOLKIT_ID],
          toolkitRevision: "older-toolkit",
          pythonVersion: "3.11.0",
          provisionerVersion: "older-provisioner",
          signal: new AbortController().signal,
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });

      expect(yield* controller.status()).toMatchObject({ updateAvailable: true });
      yield* controller.manage("update");
      const settled = yield* waitForSettled(controller);
      expect(settled).toMatchObject({
        updateAvailable: false,
        runtimeVersion: `Python ${MANAGED_PYTHON_VERSION}`,
        toolkitRevision: MANAGED_PYTHON_TOOLKIT_REVISION,
      });
      expect(
        (yield* Effect.promise(() => manager.inspect()))?.record.active.provisionerVersion,
      ).toBe(MANAGED_PYTHON_PROVISIONER_VERSION);
      controller.dispose();
    }),
  );

  it.live("keeps a broken selected installation repairable and publishes a new generation", () =>
    Effect.gen(function* () {
      const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });
      yield* controller.manage("install");
      const installed = yield* waitForSettled(controller);
      const current = yield* Effect.promise(() => manager.inspect());
      yield* Effect.promise(() => NodeFSP.unlink(current!.executable));
      expect(yield* controller.status()).toMatchObject({
        installed: true,
        selection: "managed",
        generationId: installed.generationId,
        failureMessage: expect.stringContaining("Repair"),
      });
      yield* controller.manage("repair");
      const repaired = yield* waitForSettled(controller);
      expect(repaired.generationId).not.toBe(installed.generationId);
      expect(repaired).toMatchObject({
        installed: true,
        selection: "managed",
        failureMessage: null,
      });
      controller.dispose();
    }),
  );

  it.live("keeps session admission blocked until private removal settles", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          removeTree: async (root) => {
            await gate;
            await NodeFSP.rm(root, { recursive: true, force: true });
          },
        }),
      );
      yield* Effect.promise(() =>
        manager.install({
          toolkitIds: [TOOLKIT_ID],
          toolkitRevision: MANAGED_PYTHON_TOOLKIT_REVISION,
          pythonVersion: MANAGED_PYTHON_VERSION,
          provisionerVersion: MANAGED_PYTHON_PROVISIONER_VERSION,
          signal: new AbortController().signal,
        }),
      );
      const controller = makeManagedPythonRuntimeController({ manager, toolkitIds: [TOOLKIT_ID] });
      expect(controller.isRemoving()).toBe(false);
      yield* controller.manage("remove");
      expect(controller.isRemoving()).toBe(true);
      release();
      expect(yield* waitForSettled(controller)).toMatchObject({
        installed: false,
        operation: null,
      });
      expect(controller.isRemoving()).toBe(false);
      controller.dispose();
    }),
  );
});

type Controller = ReturnType<typeof makeManagedPythonRuntimeController>;

const waitForSettled = (controller: Controller) =>
  waitForStatus(controller, (status) => status.operation === null);

const waitForStatus = Effect.fn("ManagedPythonRuntimeController.waitForStatus")(function* (
  controller: Controller,
  accepted: (status: ComputeManagedRuntimeStatus) => boolean,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const status = yield* controller.status();
    if (accepted(status)) return status;
    yield* Effect.sleep("1 millis");
  }
  return yield* Effect.die(new Error("Managed runtime operation did not settle."));
});
