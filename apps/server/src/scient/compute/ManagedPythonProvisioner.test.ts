// @effect-diagnostics nodeBuiltinImport:off -- fixture paths verify source and packaged layout.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExecutionProcessPort } from "@scientfactory/execution";
import { downloadManagedRuntime, type ManagedRuntimeTarget } from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MANAGED_PYTHON_LOCK_SHA256,
  MANAGED_PYTHON_PROJECT_SHA256,
  MANAGED_PYTHON_UV_VERSION,
  MANAGED_PYTHON_VERSION,
  makeManagedPythonProvisioner,
  managedPythonProvisioningEnvironment,
  managedPythonSpecPathCandidates,
  managedPythonUvArtifactForTarget,
  resolveManagedPythonSpecPath,
} from "./ManagedPythonProvisioner.ts";

vi.mock("@scientfactory/provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scientfactory/provider-runtime")>()),
  downloadManagedRuntime: vi.fn(),
}));

describe("ManagedPythonProvisioner", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-python-spec-"));
    vi.mocked(downloadManagedRuntime).mockReset().mockRejectedValue(new Error("Fixture offline"));
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
  });

  const cachedInstaller = async (processes: ExecutionProcessPort) => {
    const computeDir = NodePath.join(temporaryRoot, "compute");
    const versionRoot = NodePath.join(computeDir, "tooling", "uv", MANAGED_PYTHON_UV_VERSION);
    const artifact = managedPythonUvArtifactForTarget({ platform: "darwin", arch: "arm64" });
    const executable = NodePath.join(versionRoot, "darwin-arm64", artifact.executablePath);
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "cached-installer-fixture");
    const provisioner = makeManagedPythonProvisioner({
      computeDir,
      specDirectory: NodePath.join(import.meta.dirname, "managed-python"),
      processes,
      spawnProbe: () => Effect.die("The cancelled setup must not reach a Python probe."),
      environment: {},
      platform: "darwin",
      arch: "arm64",
    });
    return {
      executable,
      versionRoot,
      provision: (signal: AbortSignal) =>
        provisioner.provision({
          targetRoot: NodePath.join(temporaryRoot, "generation"),
          toolkitIds: [],
          toolkitRevision: "fixture",
          pythonVersion: MANAGED_PYTHON_VERSION,
          provisionerVersion: "fixture",
          signal,
        }),
    };
  };

  it("keeps the cached installer when setup is already cancelled", async () => {
    const start = vi.fn(() => Effect.die("A cancelled setup must not start a process."));
    const fixture = await cachedInstaller({ start });
    const controller = new AbortController();
    controller.abort();

    await expect(fixture.provision(controller.signal)).rejects.toBeDefined();
    expect(await NodeFSP.readFile(fixture.executable, "utf8")).toBe("cached-installer-fixture");
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual(["darwin-arm64"]);
    expect(start).not.toHaveBeenCalled();
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("cancels an in-flight installer check without discarding its cache or retrying", async () => {
    const checking = Promise.withResolvers<void>();
    let cancellations = 0;
    const fixture = await cachedInstaller({
      start: () =>
        Effect.succeed({
          output: Stream.empty,
          exitCode: Effect.sync(() => checking.resolve()).pipe(Effect.andThen(Effect.never)),
          cancel: Effect.sync(() => {
            cancellations += 1;
          }),
        }),
    });
    const controller = new AbortController();
    const outcome = fixture.provision(controller.signal).then(
      () => "unexpected success",
      () => "cancelled",
    );
    await checking.promise;
    controller.abort();

    expect(await outcome).toBe("cancelled");
    expect(cancellations).toBe(1);
    expect(await NodeFSP.readFile(fixture.executable, "utf8")).toBe("cached-installer-fixture");
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual(["darwin-arm64"]);
    expect(downloadManagedRuntime).not.toHaveBeenCalled();
  });

  it("still discards a mismatched installer and cleans staging when replacement is offline", async () => {
    const fixture = await cachedInstaller({
      start: () =>
        Effect.succeed({
          output: Stream.make({ stream: "stdout" as const, text: "uv 0.0.0" }),
          exitCode: Effect.succeed(0),
          cancel: Effect.void,
        }),
    });

    await expect(fixture.provision(new AbortController().signal)).rejects.toThrow(
      "Fixture offline",
    );
    await expect(NodeFSP.stat(fixture.executable)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readdir(fixture.versionRoot)).toEqual([]);
    expect(downloadManagedRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps the checked-in locked specification matched to its activation hashes", async () => {
    for (const [name, expected] of [
      ["pyproject.toml", MANAGED_PYTHON_PROJECT_SHA256],
      ["uv.lock", MANAGED_PYTHON_LOCK_SHA256],
    ] as const) {
      const contents = await NodeFSP.readFile(new URL(`./managed-python/${name}`, import.meta.url));
      expect(NodeCrypto.createHash("sha256").update(contents).digest("hex")).toBe(expected);
    }
  });

  it("maps every reviewed platform target to a pinned bounded artifact", () => {
    const targets: ReadonlyArray<ManagedRuntimeTarget> = [
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" },
      { platform: "linux", arch: "x64", libc: "glibc" },
      { platform: "linux", arch: "arm64", libc: "musl" },
      { platform: "linux", arch: "x64", libc: "musl" },
      { platform: "win32", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ];

    for (const target of targets) {
      const artifact = managedPythonUvArtifactForTarget(target);
      expect(artifact.size).toBeGreaterThan(1_000_000);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.executablePath).toContain("uv");
      expect(artifact.auxiliaryExecutablePath).toContain("uvx");
    }
    expect(() => managedPythonUvArtifactForTarget({ platform: "linux", arch: "x64" })).toThrow(
      "Scientific Python is not available",
    );
  });

  it("strips ambient package-manager authority and scopes every uv path", () => {
    const environment = managedPythonProvisioningEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "https://proxy.example",
        UV_INDEX_URL: "https://unreviewed.example",
        PIP_CONFIG_FILE: "/tmp/pip.conf",
        POETRY_HOME: "/tmp/poetry",
        PYENV_ROOT: "/tmp/pyenv",
        CONDA_PREFIX: "/tmp/conda",
        VIRTUAL_ENV: "/tmp/venv",
      },
      { targetRoot: "/private/generation", projectRoot: "/private/generation/project" },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      UV_CACHE_DIR: "/private/generation/.cache",
      UV_PROJECT: "/private/generation/project",
      UV_PROJECT_ENVIRONMENT: "/private/generation/environment",
      UV_PYTHON_INSTALL_DIR: "/private/generation/python",
    });
    for (const key of [
      "UV_INDEX_URL",
      "PIP_CONFIG_FILE",
      "POETRY_HOME",
      "PYENV_ROOT",
      "CONDA_PREFIX",
      "VIRTUAL_ENV",
    ]) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it("resolves source and packaged specifications without guessing another path", async () => {
    const [source, packaged] = managedPythonSpecPathCandidates(temporaryRoot);
    expect(source).toBe(NodePath.join(temporaryRoot, "managed-python"));
    expect(packaged).toBe(NodePath.join(temporaryRoot, "scient-managed-python"));
    if (source === undefined || packaged === undefined) throw new Error("Missing candidates.");

    await NodeFSP.mkdir(packaged, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(packaged, "pyproject.toml"), "project");
    await NodeFSP.writeFile(NodePath.join(packaged, "uv.lock"), "lock");
    expect(await resolveManagedPythonSpecPath(temporaryRoot)).toBe(packaged);

    await NodeFSP.mkdir(source, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "pyproject.toml"), "project");
    await NodeFSP.writeFile(NodePath.join(source, "uv.lock"), "lock");
    expect(await resolveManagedPythonSpecPath(temporaryRoot)).toBe(source);
  });
});
