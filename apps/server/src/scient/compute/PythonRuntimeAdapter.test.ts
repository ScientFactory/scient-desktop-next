// @effect-diagnostics preferSchemaOverJson:off -- test data uses JSON for probe simulation.
// @effect-diagnostics globalDate:off -- test uses process.hrtime for unique temp directories.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ComputeRuntimeError,
  type ComputeLaunchRequest,
  type ComputeRuntimeProfile,
} from "@scientfactory/compute";

import {
  PROBE_SCRIPT,
  buildLaunchPlan,
  buildProfile,
  checkReadiness,
  computeFingerprint,
  discoverCandidates,
  makePythonRuntimeAdapter,
  parseProbeOutput,
  PYTHON_LANGUAGE_ID,
  JUPYTER_BRIDGE_TRANSPORT_KIND,
} from "./PythonRuntimeAdapter.ts";

const validProbeOutput = JSON.stringify({
  executable: "/usr/bin/python3",
  implementation: "CPython",
  version: "3.12.0",
  architecture: "arm64",
  prefix: "/usr",
  base_prefix: "/usr",
  platform: "darwin",
  packages: {
    jupyter_client: "8.6.1",
    ipykernel: "6.29.0",
    matplotlib: "3.9.0",
    numpy: "1.26.0",
    pandas: "2.2.0",
  },
});

const profile: ComputeRuntimeProfile = {
  languageId: PYTHON_LANGUAGE_ID,
  source: "path",
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Python 3.12.0 (path)",
};

describe("python probe parsing", () => {
  it("parses valid probe output", () => {
    const result = parseProbeOutput(validProbeOutput);
    expect(result.executable).toBe("/usr/bin/python3");
    expect(result.implementation).toBe("CPython");
    expect(result.version).toBe("3.12.0");
    expect(result.packages["jupyter_client"]).toBe("8.6.1");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseProbeOutput("not json")).toThrow();
  });

  it("rejects output missing required fields", () => {
    expect(() => parseProbeOutput(JSON.stringify({ executable: "/python" }))).toThrow();
  });

  it("handles packages with null (absent) values", () => {
    const result = parseProbeOutput(
      JSON.stringify({
        executable: "/python",
        implementation: "CPython",
        version: "3.12.0",
        architecture: null,
        prefix: "/usr",
        base_prefix: "/usr",
        platform: "linux",
        packages: { jupyter_client: null, ipykernel: null },
      }),
    );
    expect(result.packages["jupyter_client"]).toBeNull();
  });
});

describe("python readiness check", () => {
  it("returns ready when all requirements are met", () => {
    const { readiness, missing } = checkReadiness(parseProbeOutput(validProbeOutput));
    expect(readiness).toBe("ready");
    expect(missing).toEqual([]);
  });

  it("returns unsupported-version for non-CPython", () => {
    const { readiness } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      implementation: "PyPy",
    });
    expect(readiness).toBe("unsupported-version");
  });

  it("returns missing-requirement for old Python", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      version: "3.9.0",
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing.some((m) => m.includes("Python"))).toBe(true);
  });

  it("returns missing-requirement for absent jupyter_client", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      packages: { ...parseProbeOutput(validProbeOutput).packages, jupyter_client: null },
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing).toContain("jupyter_client");
  });

  it("returns missing-requirement for old ipykernel", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      packages: { ...parseProbeOutput(validProbeOutput).packages, ipykernel: "6.28.0" },
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing.some((m) => m.includes("ipykernel"))).toBe(true);
  });
});

describe("python profile building", () => {
  it("builds a profile from a probe result", () => {
    const p = buildProfile(parseProbeOutput(validProbeOutput), "path");
    expect(p.languageId).toBe(PYTHON_LANGUAGE_ID);
    expect(p.source).toBe("path");
    expect(p.executable).toBe("/usr/bin/python3");
    expect(p.languageVersion).toBe("3.12.0");
  });
});

describe("python launch plan", () => {
  it("builds a launch plan with -I -u and the bridge path", () => {
    const request: ComputeLaunchRequest = {
      profile,
      cwd: "/project",
      environment: { PYTHONUTF8: "1" },
    };
    const plan = buildLaunchPlan(request, "/app/bridge.py");
    expect(plan.executable).toBe("/usr/bin/python3");
    expect(plan.args).toEqual(["-I", "-u", "/app/bridge.py"]);
    expect(plan.cwd).toBe("/project");
    expect(plan.environment).toEqual({ PYTHONUTF8: "1" });
  });
});

describe("python fingerprint", () => {
  it("computes a sha256 fingerprint with contributors", () => {
    const fp = computeFingerprint(profile, {
      jupyter_client: "8.6.1",
      ipykernel: "6.29.0",
      matplotlib: null,
      numpy: "1.26.0",
      pandas: null,
    });
    expect(fp.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.contributors).toContain("executable");
    expect(fp.contributors).toContain("languageVersion");
    expect(fp.contributors).toContain("jupyter_client");
    expect(fp.contributors).toContain("ipykernel");
  });
});

describe("python candidate discovery", () => {
  it("places configured executable first", () => {
    const candidates = discoverCandidates("/project", "/custom/python", "darwin");
    expect(candidates[0]).toEqual({ executable: "/custom/python", source: "configured" });
  });

  it("places project .venv before PATH candidates", () => {
    // This test uses a real directory that may or may not have .venv.
    // The important assertion is ordering when .venv exists.
    const tmpDir = `/tmp/scient-test-${process.hrtime.bigint()}`;
    try {
      require("node:fs").mkdirSync(`${tmpDir}/.venv/bin`, { recursive: true });
      require("node:fs").writeFileSync(`${tmpDir}/.venv/bin/python`, "");
      const candidates = discoverCandidates(tmpDir, null, "darwin");
      expect(candidates[0]).toEqual({
        executable: `${tmpDir}/.venv/bin/python`,
        source: "project",
      });
      expect(candidates[1]).toEqual({ executable: "python3", source: "path" });
    } finally {
      require("node:fs").rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists python3 before python on Unix", () => {
    const candidates = discoverCandidates("/nonexistent", null, "darwin");
    const pathCandidates = candidates.filter((c) => c.source === "path");
    expect(pathCandidates[0]).toEqual({ executable: "python3", source: "path" });
    expect(pathCandidates[1]).toEqual({ executable: "python", source: "path" });
  });

  it("lists python.exe before python3.exe on Windows", () => {
    const candidates = discoverCandidates("C:\\project", null, "win32");
    const pathCandidates = candidates.filter((c) => c.source === "path");
    expect(pathCandidates[0]).toEqual({ executable: "python.exe", source: "path" });
    expect(pathCandidates[1]).toEqual({ executable: "python3.exe", source: "path" });
  });

  it("deduplicates candidates", () => {
    const candidates = discoverCandidates("/nonexistent", "python3", "darwin");
    const pathSources = candidates.filter((c) => c.source === "path");
    expect(pathSources).toHaveLength(1);
  });
});

describe("python runtime adapter", () => {
  const fakeSpawnProbe = (stdout: string) => (executable: string) => Effect.succeed(stdout);

  const fakeFailingProbe = (executable: string) =>
    Effect.fail(new ComputeRuntimeError({ operation: "discover", message: "Probe failed." }));

  it.effect("discovers profiles from viable candidates", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      const profiles = yield* adapter.discover({
        projectRoot: "/nonexistent",
        configuredExecutable: null,
      });
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles[0]!.languageId).toBe(PYTHON_LANGUAGE_ID);
    }),
  );

  it.effect("returns a configured-but-invalid profile without replacing it", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(fakeFailingProbe, "/app/bridge.py");
      const profiles = yield* adapter.discover({
        projectRoot: "/nonexistent",
        configuredExecutable: "/bad/python",
      });
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.source).toBe("configured");
      expect(profiles[0]!.languageVersion).toBe("unknown");
    }),
  );

  it.effect("verifies a ready environment", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      const verification = yield* adapter.verify({
        profile,
        cwd: "/project",
        environment: {},
      });
      expect(verification.readiness).toBe("ready");
    }),
  );

  it.effect("verifies a missing-requirement environment", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(
        fakeSpawnProbe(
          JSON.stringify({
            ...JSON.parse(validProbeOutput),
            packages: {
              jupyter_client: null,
              ipykernel: null,
              matplotlib: null,
              numpy: null,
              pandas: null,
            },
          }),
        ),
        "/app/bridge.py",
      );
      const verification = yield* adapter.verify({
        profile,
        cwd: "/project",
        environment: {},
      });
      expect(verification.readiness).toBe("missing-requirement");
      expect(verification.missingRequirements).toContain("jupyter_client");
    }),
  );

  it.effect("builds a launch plan through prepareLaunch", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      const plan = yield* adapter.prepareLaunch({
        profile,
        cwd: "/project",
        environment: { PYTHONUTF8: "1" },
      });
      expect(plan.args).toEqual(["-I", "-u", "/app/bridge.py"]);
    }),
  );

  it("normalizes diagnostics through the adapter", () => {
    const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
    const diagnostics = adapter.normalizeDiagnostic({
      name: "ValueError",
      value: "bad value",
      traceback: ["line 1", "line 2"],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.errorName).toBe("ValueError");
  });

  it.effect("computes a fingerprint through the adapter", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      const fp = yield* adapter.fingerprintEnvironment(profile);
      expect(fp.hash).toMatch(/^sha256:/);
    }),
  );

  it("reports the correct language and transport kind", () => {
    const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
    expect(adapter.languageId).toBe(PYTHON_LANGUAGE_ID);
    expect(adapter.transportKind).toBe(JUPYTER_BRIDGE_TRANSPORT_KIND);
  });
});
