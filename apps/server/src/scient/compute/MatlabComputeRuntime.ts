// @effect-diagnostics nodeBuiltinImport:off -- Engine discovery inspects one selected installation.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeRuntimeError, REQUIRED_COMPUTE_CAPABILITIES } from "@scientfactory/compute";
import { ExecutionRunId } from "@scientfactory/execution";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import { DuplexProcess } from "../execution/LocalDuplexProcess.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { ServerConfig } from "../../config.ts";
import { ScientificRuntimePreferences } from "./ScientificRuntimePreferences.ts";
import { makeMatlabConnectionHelper } from "./MatlabConnectionHelper.ts";
import { resolveManagedPythonSpecPath } from "./ManagedPythonProvisioner.ts";
import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { makeComputeBridgeTransport } from "./ComputeBridgeTransport.ts";
import {
  MATLAB_LANGUAGE_ID,
  makeMatlabRuntimeAdapter,
  matlabEngineDirectory,
  readMatlabInstallation,
  type MatlabEngineProbeResult,
} from "./MatlabRuntimeAdapter.ts";
import {
  BRIDGE_SCRIPT_NAME,
  STAGED_BRIDGE_DIRECTORY,
  moduleDirectory,
} from "./PythonComputeRuntime.ts";

export const MATLAB_BRIDGE_SCRIPT_NAME = "scient_matlab_engine_bridge.py";
const PROBE_TIMEOUT = Duration.seconds(20);
const PROBE_DRAIN_GRACE = Duration.seconds(2);
const MAXIMUM_PROBE_BYTES = 256 * 1024;

const HOST_PROBE_SCRIPT = [
  "import json, os, platform, sys",
  "if sys.argv[1]: sys.path.insert(0, sys.argv[1])",
  "import matlab.engine",
  "module = os.path.realpath(matlab.engine.__file__)",
  "arch_path = os.path.join(os.path.dirname(module), '_arch.txt')",
  "arch = open(arch_path, encoding='utf-8').read(16384).splitlines() if os.path.isfile(arch_path) else []",
  "print(json.dumps({",
  '  "hostExecutable": os.path.abspath(sys.executable),',
  '  "hostVersion": platform.python_version(),',
  '  "engineModule": os.path.realpath(matlab.engine.__file__),',
  '  "engineRoot": os.path.realpath(os.path.dirname(os.path.dirname(arch[1]))) if len(arch) == 4 else None,',
  '}, separators=(",", ":")))',
].join("\n");

const HostProbeResult = Schema.Struct({
  hostExecutable: Schema.String,
  hostVersion: Schema.String,
  engineModule: Schema.String,
  engineRoot: Schema.optional(Schema.NullOr(Schema.String)),
});
type HostProbeResult = typeof HostProbeResult.Type;
const decodeHostProbe = Schema.decodeUnknownSync(HostProbeResult);

function runtimeError(message: string, cause?: unknown): ComputeRuntimeError {
  return new ComputeRuntimeError({
    operation: "discover",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function pathIsInside(directory: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(directory), NodePath.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

export function matlabBridgePathCandidates(directory: string): ReadonlyArray<string> {
  return [
    NodePath.join(directory, "bridge", MATLAB_BRIDGE_SCRIPT_NAME),
    NodePath.join(directory, STAGED_BRIDGE_DIRECTORY, MATLAB_BRIDGE_SCRIPT_NAME),
  ];
}

export const resolveMatlabBridgePath = (
  directory: string,
): Effect.Effect<string, ComputeRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = matlabBridgePathCandidates(directory);
    for (const candidate of candidates) {
      const protocolPath = NodePath.join(NodePath.dirname(candidate), BRIDGE_SCRIPT_NAME);
      if (
        (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) &&
        (yield* fileSystem.exists(protocolPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return candidate;
      }
    }
    return yield* runtimeError(
      `Unable to find ${MATLAB_BRIDGE_SCRIPT_NAME} with its shared ${BRIDGE_SCRIPT_NAME} sibling. Looked in: ${candidates.join(", ")}.`,
    );
  });

function hostCandidates(): ReadonlyArray<string> {
  return ["python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3", "python"];
}

function parseHostProbe(value: string): HostProbeResult {
  return decodeHostProbe(JSON.parse(value.trim()));
}

function matlabArchitecture(engineDirectory: string): string | null {
  try {
    const entries = NodePath.join(engineDirectory, "matlab", "engine");
    const architecture = NodeFS.readdirSync(entries).find((name: string) =>
      /^(?:glnxa64|maca64|maci64|win64)$/u.test(name),
    );
    return architecture ?? null;
  } catch {
    return null;
  }
}

export const makeMatlabEngineInspector = Effect.fn("makeMatlabEngineInspector")(function* (
  managedHost?: (installationRoot: string) => Effect.Effect<
    {
      readonly executable: string;
      readonly engineDirectory: string;
    } | null,
    ComputeRuntimeError
  >,
) {
  const processes = yield* ExecutionProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const runCounter = yield* Ref.make(0);

  const probeHost = Effect.fn("probeMatlabEngineHost")(function* (
    executable: string,
    engineDirectory: string,
  ) {
    const count = yield* Ref.updateAndGet(runCounter, (value) => value + 1);
    const handle = yield* processes
      .start({
        runId: ExecutionRunId.make(`scient-matlab-engine-probe-${String(count)}`),
        executable,
        args: ["-I", "-B", "-c", HOST_PROBE_SCRIPT, engineDirectory],
        cwd: NodeOS.tmpdir(),
        environment,
        extendEnv: false,
      })
      .pipe(Effect.mapError((cause) => runtimeError(`Unable to run ${executable}.`, cause)));
    const stdoutRef = yield* Ref.make("");
    const stderrRef = yield* Ref.make("");
    const bytesRef = yield* Ref.make(0);
    const outputExceeded = yield* Deferred.make<void>();
    const drain = yield* handle.output.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const bytes = Buffer.byteLength(chunk.text, "utf8");
          const total = yield* Ref.updateAndGet(bytesRef, (current) => current + bytes);
          if (total > MAXIMUM_PROBE_BYTES) {
            yield* Deferred.succeed(outputExceeded, undefined);
            return;
          }
          yield* Ref.update(
            chunk.stream === "stdout" ? stdoutRef : stderrRef,
            (text) => `${text}${chunk.text}`,
          );
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("MATLAB Engine probe output ended early", { cause }),
      ),
      Effect.forkScoped,
    );
    const exitCode = yield* Effect.raceFirst(
      handle.exitCode.pipe(Effect.timeoutOption(PROBE_TIMEOUT)),
      Deferred.await(outputExceeded).pipe(Effect.as(Option.none<number>())),
    );
    if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
    yield* Fiber.join(drain).pipe(Effect.timeoutOption(PROBE_DRAIN_GRACE), Effect.ignoreCause());
    if (Option.isNone(exitCode)) {
      return yield* runtimeError(
        (yield* Ref.get(bytesRef)) > MAXIMUM_PROBE_BYTES
          ? `${executable} exceeded the MATLAB Engine probe output limit.`
          : `${executable} did not answer the MATLAB Engine probe in time.`,
      );
    }
    if (exitCode.value !== 0) {
      const detail = (yield* Ref.get(stderrRef)).trim().slice(-2048);
      return yield* runtimeError(
        `${executable} cannot host this MATLAB Engine${detail === "" ? "." : `: ${detail}`}`,
      );
    }
    const stdout = yield* Ref.get(stdoutRef);
    return yield* Effect.try({
      try: () => parseHostProbe(stdout),
      catch: (cause) => runtimeError(`${executable} returned an invalid Engine probe.`, cause),
    });
  });

  return Effect.fn("inspectMatlabEngine")(function* (
    executable: string,
  ): Effect.fn.Return<MatlabEngineProbeResult, ComputeRuntimeError> {
    const installation = yield* readMatlabInstallation(executable);
    const resolved = installation.executableRealpath;
    const installationRoot = installation.installationRoot;
    const managed = managedHost === undefined ? null : yield* managedHost(installationRoot);
    const bundledDirectory = matlabEngineDirectory(resolved);
    const selectedEngineDirectory = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(managed?.engineDirectory ?? bundledDirectory),
      catch: (cause) =>
        runtimeError(
          "MATLAB Engine files are unavailable. Set up or repair its connection helper.",
          cause,
        ),
    }).pipe(
      Effect.catch((cause) => (managed === null ? Effect.succeed(null) : Effect.fail(cause))),
    );
    // Import behavior is authoritative: newer releases can bundle a working
    // Engine without _arch.txt, while older source distributions need an
    // installed Engine. Never fall back away from an explicitly selected helper.
    const host = yield* Effect.firstSuccessOf(
      (managed === null ? hostCandidates() : [managed.executable]).flatMap((candidate) =>
        (managed === null ? [selectedEngineDirectory, null] : [selectedEngineDirectory])
          .filter((directory, index, directories) => directories.indexOf(directory) === index)
          .map((directory) =>
            probeHost(candidate, directory ?? "").pipe(
              Effect.flatMap((host) => {
                const matches =
                  directory === null
                    ? host.engineRoot === installationRoot
                    : pathIsInside(directory, host.engineModule);
                return matches
                  ? Effect.succeed(host)
                  : Effect.fail(
                      runtimeError(
                        "The Engine host imported MATLAB from a different installation.",
                      ),
                    );
              }),
              Effect.scoped,
            ),
          ),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        runtimeError(
          `MATLAB is installed, but no compatible Python host could import its Engine API. Set up or repair the MATLAB connection helper in Scientific Computing settings. ${cause.message}`.slice(
            0,
            4096,
          ),
          cause,
        ),
      ),
    );
    const engineDirectory = NodePath.dirname(NodePath.dirname(NodePath.dirname(host.engineModule)));
    return {
      executable,
      executableRealpath: resolved,
      executableMtimeNs: installation.executableMtimeNs,
      installationRoot,
      release: installation.release,
      version: installation.version,
      architecture: matlabArchitecture(engineDirectory),
      engineDirectory,
      hostExecutable: host.hostExecutable,
      hostVersion: host.hostVersion,
    };
  });
});

export const matlabRuntimeBinding: Effect.Effect<
  ComputeRuntimeBinding,
  ComputeRuntimeError,
  | DuplexProcess
  | ExecutionProcess
  | FileSystem.FileSystem
  | Scope.Scope
  | ServerConfig
  | ScientificRuntimePreferences
> = Effect.gen(function* () {
  const bridgePath = yield* resolveMatlabBridgePath(moduleDirectory());
  const config = yield* ServerConfig;
  const preferences = yield* ScientificRuntimePreferences;
  const processes = yield* ExecutionProcess;
  const duplexProcesses = yield* DuplexProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const helper = yield* Effect.tryPromise({
    try: async () => {
      const specDirectory = await resolveManagedPythonSpecPath(
        moduleDirectory(),
        "matlab-connection",
      );
      const helper = makeMatlabConnectionHelper({
        computeDir: config.computeDir,
        specDirectory,
        processes,
        environment,
        platform,
        arch,
        selectedExecutable: () =>
          Effect.runPromise(preferences.readRuntimeExecutablePath("matlab")).then(
            (value) => value.executablePath,
          ),
      });
      await helper.manager.reconcile();
      return helper;
    },
    catch: (cause) => runtimeError("MATLAB assisted connection is unavailable.", cause),
  }).pipe(
    Effect.catch((cause) => Effect.logWarning(cause.message, { cause }).pipe(Effect.as(null))),
  );
  if (helper !== null)
    yield* Effect.addFinalizer(() => Effect.sync(() => helper.controller.dispose()));
  const inspect = yield* makeMatlabEngineInspector(helper?.hostFor);
  const runtime = makeMatlabRuntimeAdapter(inspect, environment, platform, bridgePath);
  let lastHelperIdentity: string | null = null;
  const managedRuntime =
    helper === null
      ? undefined
      : {
          ...helper.controller,
          status: () =>
            helper.controller.status().pipe(
              Effect.tap((status) =>
                Effect.sync(() => {
                  const identity = `${status.generationId ?? ""}:${status.selection}:${status.failureMessage ?? ""}`;
                  if (identity !== lastHelperIdentity) runtime.clearProbeCache();
                  lastHelperIdentity = identity;
                }),
              ),
            ),
        };
  const transport = makeComputeBridgeTransport(duplexProcesses, { startupTimeoutMs: 180_000 });
  return {
    adapter: runtime.adapter,
    transport,
    ...(managedRuntime === undefined ? {} : { managedRuntime }),
    descriptor: {
      languageId: MATLAB_LANGUAGE_ID,
      displayName: "MATLAB",
      sourceExtensions: [".m"],
      capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, "variables"],
    },
  };
});
