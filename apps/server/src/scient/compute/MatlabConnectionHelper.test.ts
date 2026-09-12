// @effect-diagnostics nodeBuiltinImport:off -- synthetic installation fixtures never execute user code.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeMatlabConnectionHelper,
  MATLAB_CONNECTION_SPECIFICATION,
} from "./MatlabConnectionHelper.ts";
import type { ManagedPythonEnvironmentStatus } from "./ManagedPythonEnvironment.ts";

describe("MATLAB connection helper prerequisites", () => {
  let root: string;
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-matlab-helper-test-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it.live(
    "reports only the helper's recorded installation and drops stale or unreadable ownership",
    () =>
      Effect.gen(function* () {
        const start = vi.fn(() => Effect.die("Status must not start an installer or a runtime."));
        const helper = makeMatlabConnectionHelper({
          computeDir: NodePath.join(root, "compute"),
          specDirectory: NodePath.join(import.meta.dirname, "managed-python", "matlab-connection"),
          processes: { start },
          environment: {},
          platform: "darwin",
          arch: "arm64",
          selectedExecutable: async () => "/different/MATLAB/bin/matlab",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => helper.controller.dispose()));
        const generation = NodePath.join(root, "generation-test");
        yield* Effect.promise(() => NodeFSP.mkdir(generation));
        const metadata = NodePath.join(generation, "matlab-installation.json");
        const current: ManagedPythonEnvironmentStatus = {
          executable: NodePath.join(generation, "environment", "bin", "python"),
          available: true,
          record: {
            schemaVersion: 1,
            selection: "managed",
            previous: null,
            active: {
              generationId: "generation-test",
              executableRelativePath: "environment/bin/python",
              toolkitIds: [],
              toolkitRevision: "test",
              pythonVersion: "3.12.13",
              provisionerVersion: "test",
              activatedAtEpochMs: 0,
            },
          },
        };
        const inspect = vi.spyOn(helper.manager, "inspect").mockResolvedValue(current);
        for (let n = 0; n < 20; n++) {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(metadata, '{"root":"/recorded/MATLAB","release":"R2026a"}'),
          );
          expect((yield* helper.controller.status()).installationExecutable).toBe(
            "/recorded/MATLAB/bin/matlab",
          );
          yield* Effect.promise(() => NodeFSP.writeFile(metadata, "{broken"));
          expect((yield* helper.controller.status()).installationExecutable).toBeUndefined();
        }
        yield* Effect.promise(() => NodeFSP.unlink(metadata));
        expect((yield* helper.controller.status()).installationExecutable).toBeUndefined();
        yield* Effect.promise(() =>
          NodeFSP.writeFile(metadata, '{"root":"/recorded/MATLAB","release":"R2026a"}'),
        );
        inspect.mockResolvedValueOnce(current).mockResolvedValueOnce({
          ...current,
          record: {
            ...current.record,
            active: { ...current.record.active, generationId: "replacement" },
          },
        });
        expect((yield* helper.controller.status()).installationExecutable).toBeUndefined();
        inspect.mockResolvedValue(null);
        const removed = yield* helper.controller.status();
        expect(removed.installed).toBe(false);
        expect(removed.installationExecutable).toBeUndefined();
        expect(start).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it("pins its minimal helper lock without pulling in the scientific bundle", async () => {
    const specification = NodePath.join(import.meta.dirname, "managed-python", "matlab-connection");
    for (const [file, hash] of [
      ["pyproject.toml", MATLAB_CONNECTION_SPECIFICATION.projectSha256],
      ["uv.lock", MATLAB_CONNECTION_SPECIFICATION.lockSha256],
    ]) {
      const bytes = await NodeFSP.readFile(NodePath.join(specification, file!));
      expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    }
    expect(
      await NodeFSP.readFile(NodePath.join(specification, "pyproject.toml"), "utf8"),
    ).not.toMatch(/numpy|pandas|scipy|jupyter/);
  });

  for (const scenario of ["missing", "unsupported", "automatic-without-installation"] as const) {
    it.live(`does not download, activate, or mutate an installation when ${scenario}`, () =>
      Effect.gen(function* () {
        const installation = NodePath.join(root, "MATLAB_R2024a.app");
        const executable = NodePath.join(installation, "bin", "matlab");
        if (scenario === "unsupported") {
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
            await NodeFSP.writeFile(executable, "not-an-executable");
            await NodeFSP.writeFile(
              NodePath.join(installation, "VersionInfo.xml"),
              "<release>R2024a</release>",
            );
          });
        }
        const start = vi.fn(() =>
          Effect.die("A failed prerequisite must not launch an installer or MATLAB."),
        );
        const helper = makeMatlabConnectionHelper({
          computeDir: NodePath.join(root, "compute"),
          specDirectory: NodePath.join(import.meta.dirname, "managed-python", "matlab-connection"),
          processes: { start },
          environment: {},
          platform: "win32",
          arch: "x64",
          selectedExecutable: async () =>
            scenario === "automatic-without-installation" ? null : executable,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => helper.controller.dispose()));
        yield* helper.controller.manage("install");
        let status = yield* helper.controller.status();
        for (let attempt = 0; status.operation !== null && attempt < 100; attempt += 1) {
          yield* Effect.sleep("5 millis");
          status = yield* helper.controller.status();
        }
        expect(status.operation).toBeNull();
        expect(status.installed).toBe(false);
        expect(status.failureMessage).not.toBeNull();
        if (scenario === "unsupported") expect(status.failureMessage).toContain("R2024b–R2026a");
        if (scenario === "automatic-without-installation")
          expect(status.failureMessage).toContain("Install and activate MATLAB first");
        expect(start).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => helper.manager.inspect())).toBeNull();
        const entries = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(root, "compute", "environments", "matlab-connection")),
        );
        expect(entries.filter((name) => name.startsWith("generation-"))).toEqual([]);
        if (scenario === "unsupported")
          expect(yield* Effect.promise(() => NodeFSP.readFile(executable, "utf8"))).toBe(
            "not-an-executable",
          );
      }).pipe(Effect.scoped),
    );
  }
});
