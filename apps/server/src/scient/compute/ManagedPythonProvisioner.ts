// @effect-diagnostics nodeBuiltinImport:off -- app-owned downloads and immutable environment assembly are a reviewed Node boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeRuntimeError, ComputeToolkitId } from "@scientfactory/compute";
import { ExecutionRunId, type ExecutionProcessPort } from "@scientfactory/execution";
import {
  detectManagedRuntimeTarget,
  downloadManagedRuntime,
  managedRuntimeTargetKey,
  materializeManagedRuntimeArtifact,
  verifyManagedRuntimeChecksum,
  type ManagedRuntimeTarget,
} from "@scientfactory/provider-runtime";
import * as Duration from "effect/Duration";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type {
  ManagedPythonEnvironmentDependencies,
  ManagedPythonProvisionInput,
  ManagedPythonProvisionProgress,
} from "./ManagedPythonEnvironment.ts";
import {
  buildProfile,
  checkReadiness,
  makePythonRuntimeAdapter,
  parseProbeOutput,
} from "./PythonRuntimeAdapter.ts";
import { assessPythonToolkits } from "./PythonToolkitCatalog.ts";

export const MANAGED_PYTHON_VERSION = "3.12.13";
export const MANAGED_PYTHON_UV_VERSION = "0.11.16";
export const MANAGED_PYTHON_PROVISIONER_VERSION = `uv-${MANAGED_PYTHON_UV_VERSION}`;
export const MANAGED_PYTHON_TOOLKIT_REVISION = "scientific-python-2026-08-30.1";
export const MANAGED_PYTHON_LOCK_SHA256 =
  "abad91ab379a20092e8d3cb4e7c708d436d5fe4c889f569976ffa76f9c971b5f";
export const MANAGED_PYTHON_PROJECT_SHA256 =
  "3cb52386aaa64eb93763cadb7c69b3cd6a174b1ec3f6245fa747cd00ebe1fa38";
const STAGED_MANAGED_PYTHON_DIRECTORY = "scient-managed-python";
export type ManagedPythonSpecPurpose = "python" | "matlab-connection";

const PROCESS_TIMEOUT = Duration.minutes(30);
const PROCESS_DRAIN_GRACE = Duration.seconds(3);
const OUTPUT_TAIL_BYTES = 64 * 1024;

class ManagedPythonProcessError extends Data.TaggedError("ManagedPythonProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const REPRESENTATIVE_SCIENTIFIC_CHECK = [
  "import io, json",
  "import ipykernel, jupyter_client",
  "import matplotlib",
  'matplotlib.use("Agg")',
  "import matplotlib.pyplot as plt",
  "import numpy as np",
  "import pandas as pd",
  "from scipy import stats",
  "x = np.arange(6, dtype=float)",
  'frame = pd.DataFrame({"x": x, "y": x ** 2})',
  "assert frame.y.sum() == 55.0",
  "assert float(stats.zscore(x).mean()) < 1e-12",
  "figure, axis = plt.subplots()",
  'axis.plot(frame["x"], frame["y"])',
  "buffer = io.BytesIO()",
  'figure.savefig(buffer, format="png")',
  "plt.close(figure)",
  "assert len(buffer.getvalue()) > 100",
  'print(json.dumps({"ok": True}))',
].join("\n");

export interface ManagedPythonUvArtifact {
  readonly assetName: string;
  readonly size: number;
  readonly sha256: string;
  readonly archiveFormat: "tar.gz" | "zip";
  readonly executablePath: string;
  readonly auxiliaryExecutablePath: string;
}

const UV_ARTIFACTS: Readonly<Record<string, ManagedPythonUvArtifact>> = {
  "darwin-arm64": {
    assetName: "uv-aarch64-apple-darwin.tar.gz",
    size: 20_641_665,
    sha256: "2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-apple-darwin/uv",
    auxiliaryExecutablePath: "uv-aarch64-apple-darwin/uvx",
  },
  "darwin-x64": {
    assetName: "uv-x86_64-apple-darwin.tar.gz",
    size: 22_381_489,
    sha256: "6b91ae3de155f51bd1f5b74814821c79f016a176561f252cd9ddfb976939af2e",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-apple-darwin/uv",
    auxiliaryExecutablePath: "uv-x86_64-apple-darwin/uvx",
  },
  "linux-arm64-glibc": {
    assetName: "uv-aarch64-unknown-linux-gnu.tar.gz",
    size: 22_456_760,
    sha256: "8c9d0f0ee98166ae6ab198747519ba6f25db29d185bd2ae5960ecebc91a5c22a",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-unknown-linux-gnu/uv",
    auxiliaryExecutablePath: "uv-aarch64-unknown-linux-gnu/uvx",
  },
  "linux-x64-glibc": {
    assetName: "uv-x86_64-unknown-linux-gnu.tar.gz",
    size: 24_014_155,
    sha256: "74947fe2c03315cf07e82ab3acc703eddef01aba4d5232a98e4c6825ec116131",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-unknown-linux-gnu/uv",
    auxiliaryExecutablePath: "uv-x86_64-unknown-linux-gnu/uvx",
  },
  "linux-arm64-musl": {
    assetName: "uv-aarch64-unknown-linux-musl.tar.gz",
    size: 22_340_125,
    sha256: "ac022d96411143b9a2dd75ea711fa8dd4cd14538bf248f2e5df3c10a80f7f6a4",
    archiveFormat: "tar.gz",
    executablePath: "uv-aarch64-unknown-linux-musl/uv",
    auxiliaryExecutablePath: "uv-aarch64-unknown-linux-musl/uvx",
  },
  "linux-x64-musl": {
    assetName: "uv-x86_64-unknown-linux-musl.tar.gz",
    size: 24_286_608,
    sha256: "1bc4be1be0a000f893b0d1db97906cf392b63fa22fda9a0ecf33d0d4bbb4bc9a",
    archiveFormat: "tar.gz",
    executablePath: "uv-x86_64-unknown-linux-musl/uv",
    auxiliaryExecutablePath: "uv-x86_64-unknown-linux-musl/uvx",
  },
  "win32-arm64": {
    assetName: "uv-aarch64-pc-windows-msvc.zip",
    size: 21_730_012,
    sha256: "e4f8e70eb21f0f4efd2eeb159ab289f9a16057d59881a4475758be4ce39bc8c5",
    archiveFormat: "zip",
    executablePath: "uv-aarch64-pc-windows-msvc/uv.exe",
    auxiliaryExecutablePath: "uv-aarch64-pc-windows-msvc/uvx.exe",
  },
  "win32-x64": {
    assetName: "uv-x86_64-pc-windows-msvc.zip",
    size: 23_236_992,
    sha256: "dd9d6d6554bfab265bfa98aa8e8a406c5c3a7b97582f93de1f4d48d9154a0395",
    archiveFormat: "zip",
    executablePath: "uv-x86_64-pc-windows-msvc/uv.exe",
    auxiliaryExecutablePath: "uv-x86_64-pc-windows-msvc/uvx.exe",
  },
};

export function managedPythonSpecPathCandidates(
  directory: string,
  purpose: ManagedPythonSpecPurpose = "python",
): ReadonlyArray<string> {
  const nested = purpose === "matlab-connection" ? ["matlab-connection"] : [];
  return [
    NodePath.join(directory, "managed-python", ...nested),
    NodePath.join(directory, STAGED_MANAGED_PYTHON_DIRECTORY, ...nested),
  ];
}

export async function resolveManagedPythonSpecPath(
  directory: string,
  purpose: ManagedPythonSpecPurpose = "python",
): Promise<string> {
  const candidates = managedPythonSpecPathCandidates(directory, purpose);
  const noun =
    purpose === "matlab-connection"
      ? "MATLAB connection helper specification"
      : "managed Python specification";
  for (const candidate of candidates) {
    const present = await Promise.all(
      ["pyproject.toml", "uv.lock"].map((file) =>
        NodeFSP.stat(NodePath.join(candidate, file)).then(
          (stat) => stat.isFile(),
          () => false,
        ),
      ),
    );
    if (present.every(Boolean)) return candidate;
  }
  throw new Error(`Unable to find the ${noun}. Looked in: ${candidates.join(", ")}.`);
}

export function managedPythonUvArtifactForTarget(
  target: ManagedRuntimeTarget,
): ManagedPythonUvArtifact {
  const artifact = UV_ARTIFACTS[managedRuntimeTargetKey(target)];
  if (artifact === undefined) {
    throw new Error(`Scientific Python is not available for ${managedRuntimeTargetKey(target)}.`);
  }
  return artifact;
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= OUTPUT_TAIL_BYTES) return combined;
  return combined.slice(-OUTPUT_TAIL_BYTES);
}

export function runOwnedProcess(
  processes: ExecutionProcessPort,
  input: {
    readonly runId: string;
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  },
): Effect.Effect<string, ManagedPythonProcessError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* processes
        .start({
          runId: ExecutionRunId.make(input.runId),
          executable: input.executable,
          args: input.args,
          cwd: input.cwd,
          environment: input.environment,
          extendEnv: false,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedPythonProcessError({
                message: `Unable to start ${input.executable}.`,
                cause,
              }),
          ),
        );
      const outputRef = yield* Ref.make("");
      const drain = yield* handle.output.pipe(
        Stream.runForEach((chunk) => Ref.update(outputRef, (tail) => appendTail(tail, chunk.text))),
        Effect.catchCause((cause) =>
          Effect.logDebug("managed Python process output ended early", { cause }),
        ),
        Effect.forkScoped,
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPythonProcessError({
              message: `Unable to wait for ${input.executable}.`,
              cause,
            }),
        ),
        Effect.timeoutOption(PROCESS_TIMEOUT),
        Effect.onInterrupt(() => handle.cancel.pipe(Effect.ignoreCause())),
      );
      if (Option.isNone(exitCode)) {
        yield* handle.cancel.pipe(Effect.ignoreCause());
      }
      yield* Fiber.join(drain).pipe(
        Effect.timeoutOption(PROCESS_DRAIN_GRACE),
        Effect.ignoreCause(),
      );
      const output = yield* Ref.get(outputRef);
      if (Option.isNone(exitCode)) {
        return yield* new ManagedPythonProcessError({
          message: `${input.executable} did not finish within 30 minutes.`,
        });
      }
      if (exitCode.value !== 0) {
        const detail = output.trim().slice(-4096);
        return yield* new ManagedPythonProcessError({
          message: `${input.executable} exited with code ${String(exitCode.value)}${detail.length > 0 ? `: ${detail}` : "."}`,
        });
      }
      return output;
    }),
  );
}

export function managedPythonProvisioningEnvironment(
  base: Readonly<Record<string, string>>,
  input: { readonly targetRoot: string; readonly projectRoot: string },
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(base).filter(([key]) => {
      const canonical = key.toUpperCase();
      return (
        !["UV_", "PIP_", "POETRY_", "PYENV_", "CONDA_"].some((prefix) =>
          canonical.startsWith(prefix),
        ) && canonical !== "VIRTUAL_ENV"
      );
    }),
  );
  return {
    ...environment,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    UV_CACHE_DIR: NodePath.join(input.targetRoot, ".cache"),
    UV_MANAGED_PYTHON: "1",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    UV_PROJECT: input.projectRoot,
    UV_PROJECT_ENVIRONMENT: NodePath.join(input.targetRoot, "environment"),
    UV_PYTHON_INSTALL_DIR: NodePath.join(input.targetRoot, "python"),
    UV_SYSTEM_CERTS: "1",
  };
}

async function verifySpecification(
  specDirectory: string,
  recipe?: ManagedPythonProvisionerOptions["recipe"],
): Promise<void> {
  await Promise.all([
    verifyManagedRuntimeChecksum(NodePath.join(specDirectory, "uv.lock"), {
      algorithm: "sha256",
      digest: recipe?.lockSha256 ?? MANAGED_PYTHON_LOCK_SHA256,
    }),
    verifyManagedRuntimeChecksum(NodePath.join(specDirectory, "pyproject.toml"), {
      algorithm: "sha256",
      digest: recipe?.projectSha256 ?? MANAGED_PYTHON_PROJECT_SHA256,
    }),
  ]);
}

interface ManagedPythonProvisionerBase {
  readonly computeDir: string;
  readonly specDirectory: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

/** A reviewed recipe supplies its own verifier; Scientific Python uses its adapter. */
export type ManagedPythonProvisionerOptions = ManagedPythonProvisionerBase &
  (
    | {
        readonly spawnProbe: (executable: string) => Effect.Effect<string, ComputeRuntimeError>;
        readonly recipe?: undefined;
      }
    | {
        readonly recipe: {
          readonly lockSha256: string;
          readonly projectSha256: string;
          readonly verify: ManagedPythonEnvironmentDependencies["verify"];
        };
      }
  );

export function makeManagedPythonProvisioner(
  options: ManagedPythonProvisionerOptions,
): Pick<ManagedPythonEnvironmentDependencies, "provision" | "verify"> {
  const platform = options.platform;
  const target = detectManagedRuntimeTarget({ platform, arch: options.arch });
  const artifact = managedPythonUvArtifactForTarget(target);
  let runSequence = 0;
  const nextRunId = (purpose: string): string => {
    runSequence += 1;
    return `scient-managed-python-${purpose}-${String(runSequence)}`;
  };

  const run = (
    executable: string,
    args: ReadonlyArray<string>,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
    purpose: string,
  ): Promise<string> => {
    signal.throwIfAborted();
    return Effect.runPromise(
      runOwnedProcess(options.processes, {
        runId: nextRunId(purpose),
        executable,
        args,
        cwd,
        environment,
      }),
      { signal },
    );
  };

  const smokeUv = async (executable: string, signal: AbortSignal): Promise<void> => {
    const output = await run(
      executable,
      ["--version"],
      options.specDirectory,
      options.environment,
      signal,
      "uv-smoke",
    );
    if (!output.trim().startsWith(`uv ${MANAGED_PYTHON_UV_VERSION}`)) {
      throw new Error(`The managed installer reported an unexpected version: ${output.trim()}.`);
    }
  };

  const ensureUv = async (
    signal: AbortSignal,
    onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined,
  ): Promise<string> => {
    const targetKey = managedRuntimeTargetKey(target);
    const versionRoot = NodePath.join(
      options.computeDir,
      "tooling",
      "uv",
      MANAGED_PYTHON_UV_VERSION,
    );
    const finalRoot = NodePath.join(versionRoot, targetKey);
    const finalExecutable = NodePath.join(finalRoot, artifact.executablePath);
    const existing = await NodeFSP.stat(finalExecutable).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (existing) {
      try {
        await smokeUv(finalExecutable, signal);
        return finalExecutable;
      } catch {
        // Cancelling validation does not establish that the cached installer is corrupt.
        signal.throwIfAborted();
        const corrupt = NodePath.join(
          versionRoot,
          `${targetKey}.invalid-${NodeCrypto.randomUUID()}`,
        );
        await NodeFSP.rename(finalRoot, corrupt).catch(() => undefined);
        await NodeFSP.rm(corrupt, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    await NodeFSP.mkdir(versionRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = NodePath.join(
      versionRoot,
      `${targetKey}.installing-${NodeCrypto.randomUUID()}`,
    );
    const archivePath = NodePath.join(stagingRoot, artifact.assetName);
    const payloadRoot = NodePath.join(stagingRoot, "payload");
    await NodeFSP.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    try {
      onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: artifact.size });
      await downloadManagedRuntime({
        url: `https://github.com/astral-sh/uv/releases/download/${MANAGED_PYTHON_UV_VERSION}/${artifact.assetName}`,
        destination: archivePath,
        allowedHosts: [
          "github.com",
          "objects.githubusercontent.com",
          "release-assets.githubusercontent.com",
        ],
        expectedSize: artifact.size,
        signal,
        onProgress: (downloadedBytes, totalBytes) =>
          onProgress?.({ phase: "downloading", downloadedBytes, totalBytes }),
      });
      await verifyManagedRuntimeChecksum(archivePath, {
        algorithm: "sha256",
        digest: artifact.sha256,
      });
      const stagedExecutable = await materializeManagedRuntimeArtifact({
        archivePath,
        archiveFormat: artifact.archiveFormat,
        destination: payloadRoot,
        executablePath: artifact.executablePath,
        auxiliaryExecutablePaths: [artifact.auxiliaryExecutablePath],
        platform,
        extractionLimits: { maxEntries: 8, maxExpandedBytes: 96 * 1024 * 1024 },
        signal,
      });
      await smokeUv(stagedExecutable, signal);
      await NodeFSP.rename(payloadRoot, finalRoot).catch(async (cause) => {
        const winner = await NodeFSP.stat(finalExecutable).then(
          (stat) => stat.isFile(),
          () => false,
        );
        if (!winner) throw cause;
      });
      await smokeUv(finalExecutable, signal);
      return finalExecutable;
    } finally {
      await NodeFSP.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const provision = async (input: ManagedPythonProvisionInput) => {
    await verifySpecification(options.specDirectory, options.recipe);
    const uv = await ensureUv(input.signal, input.onProgress);
    const projectRoot = NodePath.join(input.targetRoot, "project");
    await NodeFSP.mkdir(projectRoot, { recursive: false, mode: 0o700 });
    await Promise.all(
      ["pyproject.toml", "uv.lock"].map((file) =>
        NodeFSP.copyFile(
          NodePath.join(options.specDirectory, file),
          NodePath.join(projectRoot, file),
        ),
      ),
    );
    const environment = managedPythonProvisioningEnvironment(options.environment, {
      targetRoot: input.targetRoot,
      projectRoot,
    });
    input.onProgress?.({
      phase: "installing-python",
      downloadedBytes: null,
      totalBytes: null,
    });
    await run(
      uv,
      [
        "python",
        "install",
        input.pythonVersion,
        "--managed-python",
        "--no-bin",
        "--no-registry",
        "--no-config",
        "--no-progress",
        "--system-certs",
        "--color",
        "never",
      ],
      projectRoot,
      environment,
      input.signal,
      "python-install",
    );
    input.onProgress?.({
      phase: "installing-packages",
      downloadedBytes: null,
      totalBytes: null,
    });
    try {
      await run(
        uv,
        [
          "sync",
          "--locked",
          "--no-dev",
          "--no-install-project",
          "--managed-python",
          "--no-python-downloads",
          "--no-build",
          "--no-sources",
          "--link-mode",
          "copy",
          "--python",
          input.pythonVersion,
          "--project",
          projectRoot,
          "--no-config",
          "--no-progress",
          "--system-certs",
          "--color",
          "never",
        ],
        projectRoot,
        environment,
        input.signal,
        "package-install",
      );
    } finally {
      await NodeFSP.rm(NodePath.join(input.targetRoot, ".cache"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    return {
      executableRelativePath:
        platform === "win32"
          ? NodePath.join("environment", "Scripts", "python.exe")
          : NodePath.join("environment", "bin", "python"),
    };
  };

  const verify = async (input: {
    readonly executable: string;
    readonly toolkitIds: ReadonlyArray<ComputeToolkitId>;
    readonly signal: AbortSignal;
    readonly onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined;
  }): Promise<void> => {
    input.onProgress?.({ phase: "verifying", downloadedBytes: null, totalBytes: null });
    if (options.recipe !== undefined) return options.recipe.verify(input);
    const stdout = await Effect.runPromise(options.spawnProbe(input.executable), {
      signal: input.signal,
    });
    const probe = parseProbeOutput(stdout);
    const readiness = checkReadiness(probe);
    if (readiness.readiness !== "ready") {
      throw new Error(`Scientific Python is missing: ${readiness.missing.join(", ")}.`);
    }
    const adapter = makePythonRuntimeAdapter(options.spawnProbe, "/unused-managed-python-bridge");
    const verification = await Effect.runPromise(
      adapter.verify({
        profile: buildProfile(probe, "managed"),
        cwd: options.specDirectory,
        environment: options.environment,
      }),
      { signal: input.signal },
    );
    const assessments = assessPythonToolkits(verification);
    for (const toolkitId of input.toolkitIds) {
      const assessment = assessments.find((candidate) => candidate.toolkitId === toolkitId);
      if (assessment?.readiness !== "ready") {
        throw new Error(
          `Scientific Python did not satisfy ${toolkitId}: ${assessment?.missingRequirements.join(", ") ?? "Toolkit not found"}.`,
        );
      }
    }
    await run(
      input.executable,
      ["-I", "-c", REPRESENTATIVE_SCIENTIFIC_CHECK],
      options.specDirectory,
      options.environment,
      input.signal,
      "scientific-check",
    );
  };

  return { provision, verify };
}
