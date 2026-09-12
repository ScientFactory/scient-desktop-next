// @effect-diagnostics nodeBuiltinImport:off -- bridge contract is a filesystem layout.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionProcessPort } from "@scientfactory/execution";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import {
  MATLAB_BRIDGE_SCRIPT_NAME,
  matlabBridgePathCandidates,
  makeMatlabEngineInspector,
  pathIsInside,
  resolveMatlabBridgePath,
} from "./MatlabComputeRuntime.ts";
import { resolveManagedPythonSpecPath } from "./ManagedPythonProvisioner.ts";
import {
  BRIDGE_SCRIPT_NAME,
  STAGED_BRIDGE_DIRECTORY,
  moduleDirectory,
} from "./PythonComputeRuntime.ts";

const fakeHostProcesses = (
  response: (engineDirectory: string) => {
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode?: number;
    readonly neverExits?: boolean;
  },
) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<Parameters<ExecutionProcessPort["start"]>[0]>>(
      [],
    );
    const cancelled = yield* Ref.make(0);
    const port: ExecutionProcessPort = {
      start: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (current) => [...current, request]);
          const result = response(request.args.at(-1) ?? "");
          return {
            output: Stream.fromArray([
              { stream: "stdout" as const, text: result.stdout },
              ...(result.stderr === undefined
                ? []
                : [{ stream: "stderr" as const, text: result.stderr }]),
            ]),
            exitCode:
              result.neverExits === true ? Effect.never : Effect.succeed(result.exitCode ?? 0),
            cancel: Ref.update(cancelled, (count) => count + 1),
          };
        }),
    };
    return { port, requests: Ref.get(requests), cancelled: Ref.get(cancelled) };
  });

const matlabInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-matlab-inspector-" });
  const installationRoot = NodePath.join(root, "MATLAB_R2026a.app");
  const executable = NodePath.join(installationRoot, "bin", "matlab");
  const engineDirectory = NodePath.join(installationRoot, "extern", "engines", "python", "dist");
  yield* fs.makeDirectory(NodePath.dirname(executable), { recursive: true });
  yield* fs.makeDirectory(NodePath.join(engineDirectory, "matlab", "engine"), { recursive: true });
  yield* fs.writeFileString(executable, "matlab");
  yield* fs.writeFileString(
    NodePath.join(engineDirectory, "matlab", "engine", "_arch.txt"),
    "fixture",
  );
  yield* fs.writeFileString(
    NodePath.join(installationRoot, "VersionInfo.xml"),
    "<versioninfo><version>26.1</version><release>R2026a</release></versioninfo>",
  );
  const canonicalExecutable = yield* fs.realPath(executable);
  const canonicalRoot = NodePath.dirname(NodePath.dirname(canonicalExecutable));
  return {
    executable,
    executableRealpath: canonicalExecutable,
    engineDirectory: NodePath.join(canonicalRoot, "extern", "engines", "python", "dist"),
    installationRoot: canonicalRoot,
  };
});

describe("MATLAB compute bridge location", () => {
  it("uses the same staged bridge directory as every compute binding", () => {
    expect(matlabBridgePathCandidates("/app")).toEqual([
      NodePath.join("/app", "bridge", MATLAB_BRIDGE_SCRIPT_NAME),
      NodePath.join("/app", STAGED_BRIDGE_DIRECTORY, MATLAB_BRIDGE_SCRIPT_NAME),
    ]);
  });

  it.effect("finds the checked-in bridge and its shared protocol sibling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resolved = yield* resolveMatlabBridgePath(moduleDirectory());
      expect(resolved).toBe(NodePath.join(moduleDirectory(), "bridge", MATLAB_BRIDGE_SCRIPT_NAME));
      expect(
        yield* fs.exists(NodePath.join(NodePath.dirname(resolved), "scient_compute_bridge.py")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("agrees with the release build about both staged bridge scripts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cli = yield* fs.readFileString(
        NodePath.join(moduleDirectory(), "..", "..", "..", "scripts", "cli.ts"),
      );
      expect(cli).toContain(`dist/${STAGED_BRIDGE_DIRECTORY}/${MATLAB_BRIDGE_SCRIPT_NAME}`);
      expect(cli).toContain(`dist/${STAGED_BRIDGE_DIRECTORY}/scient_compute_bridge.py`);
      expect(cli).toContain("matlab-connection/pyproject.toml");
      expect(cli).toContain("matlab-connection/uv.lock");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("finds the checked-in MATLAB connection helper specification", async () => {
    const resolved = await resolveManagedPythonSpecPath(moduleDirectory(), "matlab-connection");
    expect(resolved).toBe(NodePath.join(moduleDirectory(), "managed-python", "matlab-connection"));
  });

  it.effect("finds a staged MATLAB bridge outside a source checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-matlab-staged-" });
      const staged = NodePath.join(directory, STAGED_BRIDGE_DIRECTORY);
      yield* fs.makeDirectory(staged, { recursive: true });
      yield* fs.writeFileString(NodePath.join(staged, MATLAB_BRIDGE_SCRIPT_NAME), "");
      yield* fs.writeFileString(NodePath.join(staged, BRIDGE_SCRIPT_NAME), "");
      expect(yield* resolveMatlabBridgePath(directory)).toBe(
        NodePath.join(staged, MATLAB_BRIDGE_SCRIPT_NAME),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an incomplete packaged bridge before advertising MATLAB", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-matlab-incomplete-" });
      const staged = NodePath.join(directory, STAGED_BRIDGE_DIRECTORY);
      yield* fs.makeDirectory(staged, { recursive: true });
      yield* fs.writeFileString(NodePath.join(staged, MATLAB_BRIDGE_SCRIPT_NAME), "");
      const error = yield* Effect.flip(resolveMatlabBridgePath(directory));
      expect(error.message).toContain("shared scient_compute_bridge.py sibling");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("MATLAB Engine host inspection", () => {
  it.effect(
    "accepts an existing installed Engine only when its vendor metadata names the selected MATLAB",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const installation = yield* matlabInstallation;
        yield* fs.remove(
          NodePath.join(installation.engineDirectory, "matlab", "engine", "_arch.txt"),
        );
        const processes = yield* fakeHostProcesses(() => {
          return {
            stdout: JSON.stringify({
              hostExecutable: "/existing/python",
              hostVersion: "3.12.13",
              engineModule: "/existing/site-packages/matlab/engine/__init__.py",
              engineRoot: installation.installationRoot,
            }),
          };
        });
        const inspect = yield* makeMatlabEngineInspector().pipe(
          Effect.provideService(ExecutionProcess, processes.port),
        );
        expect(yield* inspect(installation.executable)).toMatchObject({
          hostExecutable: "/existing/python",
          engineDirectory: "/existing/site-packages",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("canonicalizes a private helper directory without bypassing its venv launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const installation = yield* matlabInstallation;
      const helperRoot = yield* fs.makeTempDirectoryScoped({ prefix: "scient-helper-path-" });
      const engineDirectory = NodePath.join(helperRoot, "engine");
      yield* fs.makeDirectory(engineDirectory);
      const canonical = yield* fs.realPath(engineDirectory);
      const host = NodePath.join(helperRoot, "environment", "bin", "python");
      const processes = yield* fakeHostProcesses(() => ({
        stdout: JSON.stringify({
          hostExecutable: host,
          hostVersion: "3.12.13",
          engineModule: NodePath.join(canonical, "matlab", "engine", "__init__.py"),
        }),
      }));
      const inspect = yield* makeMatlabEngineInspector(() =>
        Effect.succeed({ executable: host, engineDirectory }),
      ).pipe(Effect.provideService(ExecutionProcess, processes.port));
      const result = yield* inspect(installation.executable);
      expect(result.hostExecutable).toBe(host);
      expect(result.engineDirectory).toBe(canonical);
      const requests = yield* processes.requests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.executable).toBe(host);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("accepts only descendants of the selected Engine directory", () => {
    const engineDirectory = NodePath.join("", "selected", "dist");
    expect(
      pathIsInside(engineDirectory, NodePath.join(engineDirectory, "matlab", "engine.py")),
    ).toBe(true);
    expect(pathIsInside(engineDirectory, engineDirectory)).toBe(false);
    expect(
      pathIsInside(engineDirectory, NodePath.join("", "selected", "dist-other", "engine.py")),
    ).toBe(false);
    expect(
      pathIsInside(engineDirectory, NodePath.join(engineDirectory, "..", "other", "engine.py")),
    ).toBe(false);
  });

  it.effect("uses an isolated host probe and records both runtime identities", () =>
    Effect.gen(function* () {
      const installation = yield* matlabInstallation;
      const processes = yield* fakeHostProcesses((engineDirectory) => ({
        stdout: JSON.stringify({
          hostExecutable: "/usr/bin/python3.13",
          hostVersion: "3.13.7",
          engineModule: NodePath.join(engineDirectory, "matlab", "engine", "__init__.py"),
        }),
      }));
      const inspect = yield* makeMatlabEngineInspector().pipe(
        Effect.provideService(ExecutionProcess, processes.port),
        Effect.provideService(HostProcessEnvironment, {
          PATH: "/usr/bin",
          GH_TOKEN: "must-not-reach-runtime",
        }),
      );

      const result = yield* inspect(installation.executable);
      expect(result).toMatchObject({
        executableRealpath: installation.executableRealpath,
        installationRoot: installation.installationRoot,
        engineDirectory: installation.engineDirectory,
        release: "R2026a",
        hostExecutable: "/usr/bin/python3.13",
        hostVersion: "3.13.7",
      });
      const [request] = yield* processes.requests;
      expect(request).toMatchObject({
        executable: "python3.13",
        cwd: NodeOS.tmpdir(),
        extendEnv: false,
      });
      expect(request?.args.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
      expect(request?.args.at(-1)).toBe(installation.engineDirectory);
      expect(request?.environment.GH_TOKEN).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a host importing Engine from another MATLAB installation", () =>
    Effect.gen(function* () {
      const installation = yield* matlabInstallation;
      const processes = yield* fakeHostProcesses(() => ({
        stdout: JSON.stringify({
          hostExecutable: "/usr/bin/python3.13",
          hostVersion: "3.13.7",
          engineModule: "/another/MATLAB/extern/engines/python/dist/matlab/engine/__init__.py",
        }),
      }));
      const inspect = yield* makeMatlabEngineInspector().pipe(
        Effect.provideService(ExecutionProcess, processes.port),
        Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin" }),
      );

      const failure = yield* Effect.flip(inspect(installation.executable));
      expect(failure.message).toContain("different installation");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels probes as soon as aggregate output exceeds its bound", () =>
    Effect.gen(function* () {
      const installation = yield* matlabInstallation;
      const processes = yield* fakeHostProcesses(() => ({
        stdout: "x".repeat(256 * 1024 + 1),
        neverExits: true,
      }));
      const inspect = yield* makeMatlabEngineInspector().pipe(
        Effect.provideService(ExecutionProcess, processes.port),
        Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin" }),
      );

      const failure = yield* Effect.flip(inspect(installation.executable));
      expect(failure.message).toContain("no compatible Python host");
      expect(yield* processes.cancelled).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
