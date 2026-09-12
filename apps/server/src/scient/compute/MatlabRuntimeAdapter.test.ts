import { ComputeRuntimeError, type ComputeRuntimeProfile } from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import {
  MATLAB_LANGUAGE_ID,
  computeMatlabFingerprint,
  discoverMatlabCandidates,
  makeMatlabRuntimeAdapter,
  matlabEngineDirectory,
  matlabInstallationRoot,
  matlabProfile,
  matlabReleaseFromExecutablePath,
  type MatlabEngineProbeResult,
} from "./MatlabRuntimeAdapter.ts";

const executable = "/Applications/MATLAB_R2026a.app/bin/matlab";
const probe: MatlabEngineProbeResult = {
  executable,
  executableRealpath: executable,
  executableMtimeNs: "1724112000000000000",
  installationRoot: "/Applications/MATLAB_R2026a.app",
  release: "R2026a",
  version: "26.1",
  architecture: "maca64",
  engineDirectory: "/Applications/MATLAB_R2026a.app/extern/engines/python/dist",
  hostExecutable: "/opt/homebrew/bin/python3.12",
  hostVersion: "3.12.13",
};

const profile: ComputeRuntimeProfile = matlabProfile(probe, "conventional");

describe("MATLAB runtime adapter", () => {
  it.effect(
    "lists alternatives and deduplicates configured aliases without widening execution discovery",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-matlab-alternatives-")).then(
              (path) => NodeFSP.realpath(path),
            ),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const first = NodePath.join(root, "first", "bin", "matlab");
        const second = NodePath.join(root, "second", "bin", "matlab");
        const alias = NodePath.join(root, "alias", "matlab");
        yield* Effect.promise(async () => {
          for (const candidate of [first, second]) {
            await NodeFSP.mkdir(NodePath.dirname(candidate), { recursive: true });
            await NodeFSP.writeFile(candidate, "synthetic executable", { mode: 0o755 });
            await NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(NodePath.dirname(candidate)), "VersionInfo.xml"),
              "<release>R2026a</release><version>26.1</version>",
            );
          }
          await NodeFSP.mkdir(NodePath.dirname(alias));
          await NodeFSP.symlink(first, alias);
        });
        const environment = {
          PATH: [NodePath.dirname(first), NodePath.dirname(second)].join(NodePath.delimiter),
        };
        const runtime = makeMatlabRuntimeAdapter(() => Effect.never, environment, "linux");
        for (let n = 0; n < 20; n++) {
          const rows = yield* runtime.adapter.listInstallations!({
            projectRoot: null,
            configuredExecutable: alias,
            refresh: true,
          });
          expect(rows.filter((row) => row.executable.startsWith(root))).toEqual([
            {
              executable: first,
              source: "path",
              configured: true,
              version: "R2026a",
              problem: null,
            },
            { executable: second, source: "path", version: "R2026a", problem: null },
          ]);
        }
        expect(discoverMatlabCandidates(alias, environment, "linux")).toEqual([
          { executable: alias, source: "configured" },
        ]);
        expect(discoverMatlabCandidates("/missing/matlab", environment, "linux")).toEqual([
          { executable: "/missing/matlab", source: "configured" },
        ]);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "refreshes installation metadata after removal and reinstall without an Engine import",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-matlab-inventory-")).then(
              (path) => NodeFSP.realpath(path),
            ),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const candidate = NodePath.join(root, "bin", "matlab");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(candidate));
          await NodeFSP.writeFile(candidate, "synthetic executable", { mode: 0o755 });
          await NodeFSP.writeFile(
            NodePath.join(root, "VersionInfo.xml"),
            "<release>R2026a</release><version>26.1</version>",
          );
        });
        const runtime = makeMatlabRuntimeAdapter(() => Effect.never, {}, "linux");
        const request = { projectRoot: null, configuredExecutable: candidate, refresh: true };
        for (let n = 0; n < 20; n += 1) {
          const rows = yield* runtime.adapter.listInstallations!(request);
          expect(rows.filter((row) => row.executable.startsWith(root))).toEqual([
            {
              executable: yield* Effect.promise(() => NodeFSP.realpath(candidate)),
              source: "configured",
              configured: true,
              version: "R2026a",
              problem: null,
            },
          ]);
        }
        yield* Effect.promise(() => NodeFSP.unlink(candidate));
        expect((yield* runtime.adapter.listInstallations!(request))[0]?.problem).toContain(
          "not found",
        );
        yield* Effect.promise(() => NodeFSP.writeFile(candidate, "reinstalled", { mode: 0o755 }));
        expect((yield* runtime.adapter.listInstallations!(request))[0]?.problem).toBeNull();
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "VersionInfo.xml"), "broken"),
        );
        expect((yield* runtime.adapter.listInstallations!(request))[0]?.problem).toContain(
          "VersionInfo.xml",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "shares failures between discovery and verification but explicitly retries on refresh",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const runtime = makeMatlabRuntimeAdapter(
          () =>
            Effect.suspend(() => {
              calls += 1;
              return Effect.fail(
                new ComputeRuntimeError({
                  operation: "discover",
                  message: "No compatible Engine host.",
                }),
              );
            }),
          {},
          "darwin",
        );
        yield* runtime.adapter.discover({
          projectRoot: null,
          configuredExecutable: executable,
          refresh: true,
        });
        yield* runtime.adapter.verify({ profile, cwd: "/project", environment: {} });
        expect(calls).toBe(1);
        yield* Effect.exit(runtime.readProbe(executable, true));
        expect(calls).toBe(2);
      }),
  );

  it.effect(
    "deduplicates overlapping probes and does not cache a result invalidated in flight",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const runtime = makeMatlabRuntimeAdapter(
          () =>
            Effect.gen(function* () {
              calls += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return probe;
            }),
          {},
          "darwin",
        );
        const first = yield* Effect.forkChild(runtime.readProbe(executable));
        yield* Deferred.await(entered);
        runtime.clearProbeCache();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Effect.all([runtime.readProbe(executable), runtime.readProbe(executable)], {
          concurrency: 2,
        });
        expect(calls).toBe(2);
      }),
  );

  it.effect("does not retain cancellation as a failed installation check", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      const runtime = makeMatlabRuntimeAdapter(
        () =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 1) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return probe;
          }),
        {},
        "darwin",
      );
      const first = yield* Effect.forkChild(runtime.readProbe(executable));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      expect(yield* runtime.readProbe(executable)).toEqual(probe);
      expect(calls).toBe(2);
    }),
  );
  it.effect(
    "keeps an automatically discovered installation visible when its helper is broken",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-matlab-discovery-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const candidate = NodePath.join(root, "matlab.exe");
        yield* Effect.promise(() => NodeFSP.writeFile(candidate, "synthetic executable"));
        const runtime = makeMatlabRuntimeAdapter(
          () =>
            Effect.fail(
              new ComputeRuntimeError({
                operation: "discover",
                message: "The MATLAB installation changed. Repair the connection helper.",
              }),
            ),
          { PATH: root },
          "win32",
        );
        const profiles = yield* runtime.adapter.discover({
          projectRoot: root,
          configuredExecutable: null,
          refresh: true,
        });
        expect(profiles).toHaveLength(1);
        expect(profiles[0]?.executable).toBe(candidate);
        const verification = yield* runtime.adapter.verify({
          profile: profiles[0]!,
          cwd: root,
          environment: {},
        });
        expect(verification.readiness).toBe("unusable");
        expect(verification.message).toContain("Repair the connection helper");
      }).pipe(Effect.scoped),
  );
  it("derives installation paths and releases without launching MATLAB", () => {
    expect(matlabInstallationRoot(executable)).toBe("/Applications/MATLAB_R2026a.app");
    expect(matlabEngineDirectory(executable)).toBe(probe.engineDirectory);
    expect(matlabReleaseFromExecutablePath(executable)).toBe("R2026a");
  });

  it("keeps an explicitly configured executable authoritative", () => {
    expect(discoverMatlabCandidates(executable, {}, "darwin")).toEqual([
      { executable, source: "configured" },
    ]);
  });

  it("builds a MATLAB profile and provenance fingerprint including its Engine host", () => {
    expect(profile).toMatchObject({
      languageId: MATLAB_LANGUAGE_ID,
      languageVersion: "R2026a",
      architecture: "maca64",
    });
    const fingerprint = computeMatlabFingerprint(profile, probe);
    expect(fingerprint.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(fingerprint.contributors).toContain("engineHostExecutable");
    expect(computeMatlabFingerprint(profile, { ...probe, hostVersion: "3.13.7" }).hash).not.toBe(
      fingerprint.hash,
    );
  });

  it("maps only the controlled submission sentinel or project paths to clickable frames", () => {
    const runtime = makeMatlabRuntimeAdapter(() => Effect.succeed(probe), {}, "darwin");
    const [diagnostic] = runtime.adapter.normalizeDiagnostic(
      {
        name: "Scient:Expected",
        value: "failure",
        traceback: [
          "<submitted>:3:scient_submission",
          "/project/helpers/model.m:8:model",
          "/private/runtime/secret.m:4:secret",
        ],
      },
      {
        projectRoot: "/project",
        submittedSource: { relativePath: "analysis.m", startLine: 10 },
      },
    );
    expect(diagnostic?.frames).toEqual([
      expect.objectContaining({ relativePath: "analysis.m", line: 13 }),
      expect.objectContaining({ relativePath: "helpers/model.m", line: 8 }),
    ]);
  });

  it.effect("discovers and verifies through one cached Engine inspection", () =>
    Effect.gen(function* () {
      let calls = 0;
      const runtime = makeMatlabRuntimeAdapter(
        () =>
          Effect.sync(() => {
            calls += 1;
            return probe;
          }),
        {},
        "darwin",
      );
      const [discovered] = yield* runtime.adapter.discover({
        projectRoot: "/project",
        configuredExecutable: executable,
        refresh: false,
      });
      expect(discovered?.languageId).toBe(MATLAB_LANGUAGE_ID);
      const verification = yield* runtime.adapter.verify({
        profile,
        cwd: "/project",
        environment: {},
      });
      expect(verification.readiness).toBe("ready");
      expect(calls).toBe(1);
    }),
  );

  it.effect("reports a missing Engine requirement without hiding the selected profile", () =>
    Effect.gen(function* () {
      const runtime = makeMatlabRuntimeAdapter(
        () =>
          Effect.fail(
            new ComputeRuntimeError({
              operation: "discover",
              message: "No compatible Engine host.",
            }),
          ),
        {},
        "darwin",
      );
      const verification = yield* runtime.adapter.verify({
        profile,
        cwd: "/project",
        environment: {},
      });
      expect(verification.profile).toBe(profile);
      expect(verification.readiness).toBe("missing-requirement");
      expect(verification.missingRequirements).toEqual(["MATLAB Engine for Python"]);
    }),
  );

  it.effect("does not misreport a broken MATLAB installation as a missing Engine package", () =>
    Effect.gen(function* () {
      const runtime = makeMatlabRuntimeAdapter(
        () =>
          Effect.fail(
            new ComputeRuntimeError({
              operation: "discover",
              message: "MATLAB VersionInfo.xml could not be read.",
            }),
          ),
        {},
        "darwin",
      );
      const verification = yield* runtime.adapter.verify({
        profile,
        cwd: "/project",
        environment: {},
      });
      expect(verification.readiness).toBe("unusable");
      expect(verification.missingRequirements).toEqual([]);
      expect(verification.message).toContain("VersionInfo.xml");
    }),
  );

  it.effect(
    "rechecks the exact MATLAB installation at launch instead of trusting cached readiness",
    () =>
      Effect.gen(function* () {
        let removed = false;
        const runtime = makeMatlabRuntimeAdapter(
          () =>
            removed
              ? Effect.fail(
                  new ComputeRuntimeError({
                    operation: "discover",
                    message: "MATLAB was removed.",
                  }),
                )
              : Effect.succeed(probe),
          {},
          "darwin",
          "/app/scient_matlab_engine_bridge.py",
        );
        yield* runtime.adapter.verify({ profile, cwd: "/project", environment: {} });
        const launch = yield* runtime.adapter.prepareLaunch!({
          profile,
          cwd: "/project",
          environment: { GH_TOKEN: "secret" },
        });
        expect(launch.executable).toBe(probe.hostExecutable);
        expect(launch.args.slice(0, 3)).toEqual(["-I", "-B", "-u"]);
        expect(launch.environment.GH_TOKEN).toBeUndefined();
        removed = true;
        const result = yield* runtime.adapter.prepareLaunch!({
          profile,
          cwd: "/project",
          environment: {},
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
  );
});
// @effect-diagnostics nodeBuiltinImport:off -- synthetic executable discovery fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
