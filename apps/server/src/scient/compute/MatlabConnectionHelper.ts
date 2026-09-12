// @effect-diagnostics nodeBuiltinImport:off -- writes are confined to an unpublished managed generation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ComputeRuntimeError } from "@scientfactory/compute";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeManagedPythonEnvironmentManager } from "./ManagedPythonEnvironment.ts";
import { makeManagedPythonProvisioner, runOwnedProcess } from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";
import { discoverMatlabCandidates, matlabInstallationRoot } from "./MatlabRuntimeAdapter.ts";

export const MATLAB_CONNECTION_SPECIFICATION = {
  lockSha256: "49526aef7c075add60a41b3605cdb6d542f3392410bc1879fc59868f8bd808d7",
  projectSha256: "b5e57ba57363d3793dd53dec2f7c0cd667015f37368b3f6139bdae871cdab79e",
};
const Installation = Schema.Struct({ root: Schema.String, release: Schema.String });
const decodeInstallation = Schema.decodeUnknownSync(Schema.fromJsonString(Installation));
const encodeInstallation = Schema.encodeSync(Schema.fromJsonString(Installation));
const METADATA = "matlab-installation.json";

function generationRoot(executable: string): string {
  return NodePath.dirname(NodePath.dirname(NodePath.dirname(executable)));
}

/** A reviewed helper, not a second copy of MATLAB or of Scientific Python. */
export function makeMatlabConnectionHelper(input: {
  readonly computeDir: string;
  readonly specDirectory: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly selectedExecutable: () => Promise<string | null>;
}) {
  const run = (executable: string, args: ReadonlyArray<string>, cwd: string, signal: AbortSignal) =>
    Effect.runPromise(
      runOwnedProcess(input.processes, {
        runId: `scient-matlab-helper-${NodeCrypto.randomUUID()}`,
        executable,
        args,
        cwd,
        environment: input.environment,
      }),
      { signal },
    );

  const verify = async ({ executable, signal }: { executable: string; signal: AbortSignal }) => {
    const root = generationRoot(executable);
    const metadata = decodeInstallation(
      await NodeFSP.readFile(NodePath.join(root, METADATA), "utf8"),
    );
    await run(
      executable,
      [
        "-I",
        "-B",
        "-c",
        [
          "import os, sys",
          "sys.path.insert(0, sys.argv[1])",
          "import matlab.engine",
          "module = os.path.realpath(matlab.engine.__file__)",
          "assert os.path.commonpath([module, os.path.realpath(sys.argv[1])]) == os.path.realpath(sys.argv[1])",
          "arch = open(os.path.join(os.path.dirname(module), '_arch.txt'), encoding='utf-8').read().splitlines()",
          "assert len(arch) == 4",
          "assert os.path.normcase(os.path.realpath(os.path.dirname(os.path.dirname(arch[1])))) == os.path.normcase(os.path.realpath(sys.argv[2]))",
        ].join("\n"),
        NodePath.join(root, "engine"),
        metadata.root,
      ],
      root,
      signal,
    );
  };
  const base = makeManagedPythonProvisioner({
    ...input,
    recipe: { ...MATLAB_CONNECTION_SPECIFICATION, verify },
  });
  const manager = makeManagedPythonEnvironmentManager(
    input.computeDir,
    {
      verify: base.verify,
      provision: async (request) => {
        const configured = await input.selectedExecutable();
        const candidate = discoverMatlabCandidates(
          configured,
          input.environment,
          input.platform,
        )[0];
        if (candidate === undefined)
          throw new Error(
            "Install and activate MATLAB first, then set up its Scient connection. Scient does not install MATLAB or provide a license.",
          );
        const executable = await NodeFSP.realpath(candidate.executable);
        const root = matlabInstallationRoot(executable);
        const xml = await NodeFSP.readFile(NodePath.join(root, "VersionInfo.xml"), "utf8");
        const release = /<release>(R\d{4}[ab])<\/release>/u.exec(xml)?.[1];
        // CPython 3.12 is a vendor-supported Engine host for these releases.
        // Future releases need qualification, not an optimistic version comparison.
        if (!release || !["R2024b", "R2025a", "R2025b", "R2026a"].includes(release)) {
          throw new Error(
            "Assisted MATLAB connection supports R2024b–R2026a. Other releases can use an existing compatible Engine host.",
          );
        }
        const result = await base.provision(request);
        const host = NodePath.join(request.targetRoot, result.executableRelativePath);
        // Use the selected release's own build command, with output outside MATLAB.
        // No pip install into the user's Python, application bundle, or project.
        await run(
          host,
          [
            "-I",
            "-B",
            "setup.py",
            "build_py",
            "--build-lib",
            NodePath.join(request.targetRoot, "engine"),
          ],
          NodePath.join(root, "extern", "engines", "python"),
          request.signal,
        );
        await NodeFSP.writeFile(
          NodePath.join(request.targetRoot, METADATA),
          encodeInstallation({ root, release }),
          { mode: 0o600, flag: "wx" },
        );
        return result;
      },
    },
    "matlab-connection",
  );

  const controller = makeManagedPythonRuntimeController({
    manager,
    toolkitIds: [],
    configuration: {
      displayName: "MATLAB connection helper",
      description:
        "A private Python helper for your installed MATLAB. MATLAB, its license, and your other Python environments stay untouched.",
      toolkitRevision: "matlab-connection-2026-09-10.1",
    },
  });
  const hostFor = (installationRoot: string) =>
    Effect.tryPromise({
      try: async () => {
        const current = await manager.inspect();
        if (current === null || current.record.selection !== "managed") return null;
        if (!current.available)
          throw new Error(
            "The MATLAB connection helper is missing. Repair it or choose an existing Engine host.",
          );
        const root = generationRoot(current.executable);
        const metadata = decodeInstallation(
          await NodeFSP.readFile(NodePath.join(root, METADATA), "utf8"),
        );
        if (
          (await NodeFSP.realpath(metadata.root)) !== (await NodeFSP.realpath(installationRoot))
        ) {
          throw new Error(
            "The MATLAB installation changed. Repair the connection helper for this installation, or choose an existing Engine host.",
          );
        }
        return { executable: current.executable, engineDirectory: NodePath.join(root, "engine") };
      },
      catch: (cause) =>
        new ComputeRuntimeError({
          operation: "discover",
          message:
            cause instanceof Error
              ? cause.message
              : "Unable to inspect the MATLAB connection helper.",
          cause,
        }),
    });
  const status = () =>
    controller.status().pipe(
      Effect.flatMap((currentStatus) =>
        Effect.tryPromise({
          try: async () => {
            const current = await manager.inspect();
            if (!current || current.record.active.generationId !== currentStatus.generationId)
              return currentStatus;
            const metadata = decodeInstallation(
              await NodeFSP.readFile(
                NodePath.join(generationRoot(current.executable), METADATA),
                "utf8",
              ),
            );
            return {
              ...currentStatus,
              installationExecutable: NodePath.join(
                metadata.root,
                "bin",
                input.platform === "win32" ? "matlab.exe" : "matlab",
              ),
            };
          },
          catch: (cause) =>
            new ComputeRuntimeError({
              operation: "discover",
              message: "The helper's installation metadata could not be read.",
              cause,
            }),
        }).pipe(Effect.orElseSucceed(() => currentStatus)),
      ),
    );
  return { manager, controller: { ...controller, status }, hostFor };
}
