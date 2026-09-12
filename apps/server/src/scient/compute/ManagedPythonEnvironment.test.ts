// @effect-diagnostics nodeBuiltinImport:off -- this test exercises the reviewed Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeToolkitId } from "@scientfactory/compute";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ManagedPythonEnvironmentError,
  type ManagedPythonEnvironmentDependencies,
  type ManagedPythonEnvironmentInstallInput,
  makeManagedPythonEnvironmentManager,
  managedPythonEnvironmentPaths,
} from "./ManagedPythonEnvironment.ts";

const TOOLKIT_ID = ComputeToolkitId.make("python-data-and-figures");
const TOOLKIT_REVISION = "test-toolkit-revision";
const PYTHON_VERSION = "3.12.13";
const PROVISIONER_VERSION = "uv-test";

describe("ManagedPythonEnvironment", () => {
  let temporaryRoot: string;
  let computeDir: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-python-env-"));
    computeDir = NodePath.join(temporaryRoot, "compute");
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  const installInput = (
    overrides: Partial<ManagedPythonEnvironmentInstallInput> = {},
  ): ManagedPythonEnvironmentInstallInput => ({
    toolkitIds: [TOOLKIT_ID],
    toolkitRevision: TOOLKIT_REVISION,
    pythonVersion: PYTHON_VERSION,
    provisionerVersion: PROVISIONER_VERSION,
    signal: new AbortController().signal,
    ...overrides,
  });

  const executableAt = async (targetRoot: string): Promise<string> => {
    const executable = NodePath.join(targetRoot, "environment", "bin", "python");
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "python", { mode: 0o700 });
    return executable;
  };

  const dependencies = (
    overrides: Partial<ManagedPythonEnvironmentDependencies> = {},
  ): ManagedPythonEnvironmentDependencies => ({
    provision: async ({ targetRoot }) => {
      await executableAt(targetRoot);
      return { executableRelativePath: NodePath.join("environment", "bin", "python") };
    },
    verify: async () => undefined,
    ...overrides,
  });

  const generationDirectory = (id: string): string =>
    NodePath.join(managedPythonEnvironmentPaths(computeDir).managedRoot, `generation-${id}`);

  it("uses one shared app-owned environment root", () => {
    const paths = managedPythonEnvironmentPaths(computeDir);
    expect(paths.managedRoot).toBe(NodePath.join(computeDir, "environments", "python"));
    expect(paths.statePath).toBe(NodePath.join(paths.managedRoot, "active.json"));
  });

  it("isolates helper activation, reconciliation, and removal from Scientific Python", async () => {
    const python = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    const helper = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies(),
      "matlab-connection",
    );
    const [installedPython, installedHelper] = await Promise.all([
      python.install(installInput()),
      helper.install(installInput({ toolkitIds: [] })),
    ]);
    expect(installedPython.executable).not.toBe(installedHelper.executable);
    const pythonPaths = managedPythonEnvironmentPaths(computeDir);
    const pythonTombstone = NodePath.join(pythonPaths.environmentsRoot, "python.removing-preserve");
    await NodeFSP.mkdir(pythonTombstone);
    await helper.reconcile();
    await helper.remove();
    expect(await helper.inspect()).toBeNull();
    expect(await python.inspect()).toEqual(installedPython);
    expect((await NodeFSP.stat(pythonTombstone)).isDirectory()).toBe(true);
    expect((await NodeFSP.stat(installedPython.executable)).isFile()).toBe(true);
  });

  it("rolls back failed helper repair and does not affect simultaneous Python mutations", async () => {
    let fail = false;
    const helper = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        verify: async () => {
          if (fail) throw new Error("Engine import failed");
        },
      }),
      "matlab-connection",
    );
    const original = await helper.install(installInput({ toolkitIds: [] }));
    fail = true;
    const python = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    const results = await Promise.allSettled([
      helper.repair(installInput({ toolkitIds: [] })),
      python.install(installInput()),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await helper.inspect()).toEqual(original);
    await python.remove();
    expect(await helper.inspect()).toEqual(original);
    const entries = await NodeFSP.readdir(
      managedPythonEnvironmentPaths(computeDir, "matlab-connection").managedRoot,
    );
    expect(entries.filter((name) => name.startsWith("generation-"))).toHaveLength(1);
  });

  it("names MATLAB helper provision failures separately from Scientific Python", async () => {
    const helper = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        provision: async () => {
          throw new Error("ENOENT: uv.lock");
        },
      }),
      "matlab-connection",
    );
    await expect(helper.install(installInput({ toolkitIds: [] }))).rejects.toMatchObject({
      reason: "provision-failed",
      message: "Scient could not provision the MATLAB connection helper.",
    });
  });

  it("publishes only a provisioned and verified final-path generation", async () => {
    const verify = vi.fn(async () => undefined);
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => "one", now: () => 42, verify }),
    );
    const installed = await manager.install(installInput());

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ executable: installed.executable, toolkitIds: [TOOLKIT_ID] }),
    );
    expect(installed.record).toMatchObject({
      schemaVersion: 1,
      selection: "managed",
      active: {
        generationId: "one",
        toolkitRevision: TOOLKIT_REVISION,
        pythonVersion: PYTHON_VERSION,
        provisionerVersion: PROVISIONER_VERSION,
        activatedAtEpochMs: 42,
      },
      previous: null,
    });
    expect(await manager.inspect()).toEqual(installed);
  });

  it("snapshots the requested Toolkit set before asynchronous setup begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: Array<ReadonlyArray<ComputeToolkitId>> = [];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => "snapshot",
        provision: async ({ targetRoot, toolkitIds }) => {
          await gate;
          observed.push(toolkitIds);
          await executableAt(targetRoot);
          return { executableRelativePath: "environment/bin/python" };
        },
      }),
    );
    const mutable = [TOOLKIT_ID];
    const pending = manager.install(installInput({ toolkitIds: mutable }));
    mutable.length = 0;
    release();
    await pending;
    expect(observed).toEqual([[TOOLKIT_ID]]);
  });

  it("retains displaced generations until startup reconciliation", async () => {
    const ids = ["one", "two", "three"];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => ids.shift()! }),
    );
    await manager.install(installInput());
    await manager.install(installInput());
    const latest = await manager.install(installInput());

    expect(latest.record.active.generationId).toBe("three");
    expect(latest.record.previous?.generationId).toBe("two");
    // A live session may still be using generation one. Collection waits for
    // startup reconciliation, when no session from this process survives.
    await expect(NodeFSP.access(generationDirectory("one"))).resolves.toBeUndefined();
    await expect(NodeFSP.access(generationDirectory("two"))).resolves.toBeUndefined();
    await expect(NodeFSP.access(generationDirectory("three"))).resolves.toBeUndefined();

    await manager.reconcile();
    await expect(NodeFSP.access(generationDirectory("one"))).rejects.toThrow();
  });

  it("preserves the active generation when provisioning fails", async () => {
    let fail = false;
    const ids = ["good", "failed"];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => ids.shift()!,
        provision: async ({ targetRoot }) => {
          if (fail) throw new Error("boom");
          await executableAt(targetRoot);
          return { executableRelativePath: "environment/bin/python" };
        },
      }),
    );
    const active = await manager.install(installInput());
    fail = true;
    await expect(manager.install(installInput())).rejects.toMatchObject({
      reason: "provision-failed",
    });
    expect(await manager.inspect()).toEqual(active);
    await expect(NodeFSP.access(generationDirectory("failed"))).rejects.toThrow();
  });

  it("preserves active state when verification or activation fails", async () => {
    let verifyFails = false;
    let commitFails = false;
    const ids = ["good", "bad-verify", "bad-commit"];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => ids.shift()!,
        verify: async () => {
          if (verifyFails) throw new Error("verify");
        },
        commitState: async (statePath, record) => {
          if (commitFails) throw new Error("commit");
          await NodeFSP.writeFile(statePath, JSON.stringify(record));
        },
      }),
    );
    const active = await manager.install(installInput());
    verifyFails = true;
    await expect(manager.install(installInput())).rejects.toMatchObject({
      reason: "verification-failed",
    });
    verifyFails = false;
    commitFails = true;
    await expect(manager.install(installInput())).rejects.toMatchObject({
      reason: "activation-failed",
    });
    expect(await manager.inspect()).toEqual(active);
  });

  it("cancels before activation and removes the unpublished candidate", async () => {
    const controller = new AbortController();
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => "cancelled",
        provision: async ({ targetRoot, signal }) => {
          await executableAt(targetRoot);
          controller.abort();
          expect(signal.aborted).toBe(true);
          return { executableRelativePath: "environment/bin/python" };
        },
      }),
    );
    await expect(
      manager.install(installInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(await manager.inspect()).toBeNull();
    await expect(NodeFSP.access(generationDirectory("cancelled"))).rejects.toThrow();
  });

  it("rejects a provisioner path that escapes its generation", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => "escape",
        provision: async () => ({ executableRelativePath: "../../python" }),
      }),
    );
    await expect(manager.install(installInput())).rejects.toMatchObject({
      reason: "verification-failed",
    });
  });

  it("switches between managed and existing environments without reinstalling", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => "select" }),
    );
    await manager.install(installInput());
    expect((await manager.select("existing"))?.record.selection).toBe("existing");
    expect((await manager.select("managed"))?.record.selection).toBe("managed");
  });

  it("removes only the app-owned shared environment", async () => {
    const sibling = NodePath.join(computeDir, "environments", "r");
    await NodeFSP.mkdir(sibling, { recursive: true });
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => "remove" }),
    );
    await manager.install(installInput());
    expect(await manager.remove()).toBe(true);
    expect(await manager.inspect()).toBeNull();
    await expect(NodeFSP.access(sibling)).resolves.toBeUndefined();
  });

  it.live("inspects as absent while a private removal tombstone is still settling", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManagedPythonEnvironmentManager(
        computeDir,
        dependencies({
          generationId: () => "removing",
          removeTree: async (root) => {
            await gate;
            await NodeFSP.rm(root, { recursive: true, force: true });
          },
        }),
      );
      yield* Effect.promise(() => manager.install(installInput()));
      const removing = manager.remove();
      let inspected: Awaited<ReturnType<typeof manager.inspect>> = null;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        inspected = yield* Effect.promise(() => manager.inspect());
        if (inspected === null) break;
        yield* Effect.sleep("1 millis");
      }
      expect(inspected).toBeNull();
      release();
      expect(yield* Effect.promise(() => removing)).toBe(true);
    }),
  );

  it("rolls back atomic removal when deleting its tombstone fails", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => "rollback",
        removeTree: async () => {
          throw new Error("busy");
        },
      }),
    );
    const installed = await manager.install(installInput());
    await expect(manager.remove()).rejects.toMatchObject({ reason: "remove-failed" });
    expect(await manager.inspect()).toEqual(installed);
  });

  it("keeps a selected missing installation repairable without changing its selection", async () => {
    let generation = 0;
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => `missing-${++generation}` }),
    );
    const installed = await manager.install(installInput());
    await NodeFSP.unlink(installed.executable);
    expect(await manager.inspect()).toMatchObject({
      record: { selection: "managed" },
      executable: installed.executable,
      available: false,
    });
    await manager.reconcile();
    expect(await manager.inspect()).toMatchObject({
      available: false,
      record: { selection: "managed" },
    });
    const repaired = await manager.repair(installInput());
    expect(repaired.available).toBe(true);
    expect(repaired.executable).not.toBe(installed.executable);
    expect(repaired.record.selection).toBe("managed");
  });

  it("does not expose a tampered state or rollback generation", async () => {
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({ generationId: () => "valid" }),
    );
    const installed = await manager.install(installInput());
    const paths = managedPythonEnvironmentPaths(computeDir);
    await NodeFSP.writeFile(
      paths.statePath,
      JSON.stringify({
        ...installed.record,
        active: { ...installed.record.active, executableRelativePath: "../../python" },
      }),
    );
    expect(await manager.inspect()).toBeNull();

    await NodeFSP.writeFile(
      paths.statePath,
      JSON.stringify({
        ...installed.record,
        previous: {
          ...installed.record.active,
          generationId: "missing",
        },
      }),
    );
    expect((await manager.inspect())?.record.previous).toBeNull();
  });

  it.effect("rejects a symlinked managed root without touching its target", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform === "win32") return;
      yield* Effect.promise(async () => {
        const paths = managedPythonEnvironmentPaths(computeDir);
        const outside = NodePath.join(temporaryRoot, "outside");
        const sentinel = NodePath.join(outside, "keep.txt");
        await NodeFSP.mkdir(paths.environmentsRoot, { recursive: true });
        await NodeFSP.mkdir(outside, { recursive: true });
        await NodeFSP.writeFile(sentinel, "keep");
        await NodeFSP.symlink(outside, paths.managedRoot, "dir");
        const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());

        await expect(manager.inspect()).rejects.toMatchObject({ reason: "activation-failed" });
        await expect(manager.install(installInput())).rejects.toMatchObject({
          reason: "activation-failed",
        });
        expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("keep");
      });
    }),
  );

  it("reconciles abandoned generations and removal tombstones", async () => {
    const paths = managedPythonEnvironmentPaths(computeDir);
    const abandoned = NodePath.join(paths.managedRoot, "generation-abandoned");
    const tombstone = NodePath.join(paths.environmentsRoot, "python.removing-abandoned");
    await NodeFSP.mkdir(abandoned, { recursive: true });
    await NodeFSP.mkdir(tombstone, { recursive: true });
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    await manager.reconcile();
    await expect(NodeFSP.access(abandoned)).rejects.toThrow();
    await expect(NodeFSP.access(tombstone)).rejects.toThrow();
  });

  it("serializes mutations so installs never provision concurrently", async () => {
    let active = 0;
    let maximum = 0;
    const ids = ["one", "two"];
    const manager = makeManagedPythonEnvironmentManager(
      computeDir,
      dependencies({
        generationId: () => ids.shift()!,
        provision: async ({ targetRoot }) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await executableAt(targetRoot);
          active -= 1;
          return { executableRelativePath: "environment/bin/python" };
        },
      }),
    );
    await Promise.all([manager.install(installInput()), manager.install(installInput())]);
    expect(maximum).toBe(1);
  });

  it("rejects empty or duplicate Toolkit requests before creating state", async () => {
    const manager = makeManagedPythonEnvironmentManager(computeDir, dependencies());
    for (const toolkitIds of [[], [TOOLKIT_ID, TOOLKIT_ID]]) {
      await expect(manager.install(installInput({ toolkitIds }))).rejects.toBeInstanceOf(
        ManagedPythonEnvironmentError,
      );
    }
    await expect(
      NodeFSP.access(managedPythonEnvironmentPaths(computeDir).statePath),
    ).rejects.toThrow();
  });
});
