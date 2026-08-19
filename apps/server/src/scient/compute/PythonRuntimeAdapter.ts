// @effect-diagnostics nodeBuiltinImport:off -- discovery checks .venv existence and resolves paths.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  ComputeEnvironmentFingerprint,
  ComputeLanguageId,
  ComputeRuntimeError,
  ComputeRuntimeProfile,
  ComputeRuntimeReadiness,
  ComputeRuntimeSource,
  ComputeRuntimeVerification,
  ComputeTransportKind,
  type ComputeDiagnostic,
  type ComputeDiscoveryRequest,
  type ComputeLanguageAdapter,
  type ComputeLaunchPlan,
  type ComputeLaunchRequest,
  type ComputeRuntimeErrorReport,
} from "@scientfactory/compute";

import { normalizePythonDiagnostic } from "./PythonDiagnostic.ts";

// ---------------------------------------------------------------------------
// Language and transport identity
// ---------------------------------------------------------------------------

export const PYTHON_LANGUAGE_ID = ComputeLanguageId.make("python");
export const JUPYTER_BRIDGE_TRANSPORT_KIND = ComputeTransportKind.make("jupyter-bridge");

// ---------------------------------------------------------------------------
// Minimum version requirements (from Phase 2 plan §2.6)
// ---------------------------------------------------------------------------

const MIN_PYTHON_VERSION = "3.10";
const MIN_JUPYTER_CLIENT_VERSION = "8.6";
const MIN_IPYKERNEL_VERSION = "6.29";

// ---------------------------------------------------------------------------
// Probe schema
// ---------------------------------------------------------------------------

const ProbeResult = Schema.Struct({
  executable: Schema.String,
  implementation: Schema.String,
  version: Schema.String,
  architecture: Schema.NullOr(Schema.String),
  prefix: Schema.String,
  base_prefix: Schema.String,
  platform: Schema.String,
  packages: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});
type ProbeResult = typeof ProbeResult.Type;

const decodeProbe = Schema.decodeUnknownSync(ProbeResult);

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function meetsMinimum(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}

// ---------------------------------------------------------------------------
// Probe script
// ---------------------------------------------------------------------------

/**
 * A standard-library-only Python script that prints one JSON object describing
 * the interpreter.  Run with `<python> -I -c PROBE_SCRIPT` to avoid project
 * site-packages altering the result.
 */
export const PROBE_SCRIPT = [
  "import json, sys, platform",
  "r = {",
  '  "executable": sys.executable,',
  '  "implementation": platform.python_implementation(),',
  '  "version": platform.python_version(),',
  '  "architecture": platform.machine() or None,',
  '  "prefix": sys.prefix,',
  '  "base_prefix": sys.base_prefix,',
  '  "platform": sys.platform,',
  '  "packages": {},',
  "}",
  'for pkg in ["jupyter_client", "ipykernel", "matplotlib", "numpy", "pandas"]:',
  "    try:",
  "        m = __import__(pkg)",
  '        r["packages"][pkg] = getattr(m, "__version__", "unknown")',
  "    except ImportError:",
  '        r["packages"][pkg] = None',
  "print(json.dumps(r))",
].join("\n");

// ---------------------------------------------------------------------------
// Pure functions (testable without Python)
// ---------------------------------------------------------------------------

/**
 * Parses the JSON output of the probe script.
 * @throws on malformed JSON or missing fields.
 */
export function parseProbeOutput(stdout: string): ProbeResult {
  const json = stdout.trim().split("\n").pop();
  if (json === undefined) throw new Error("Probe produced no output.");
  return decodeProbe(JSON.parse(json));
}

/**
 * Checks whether a probe result meets the minimum requirements for the bridge.
 */
export function checkReadiness(probe: ProbeResult): {
  readonly readiness: ComputeRuntimeReadiness;
  readonly missing: ReadonlyArray<string>;
} {
  const missing: string[] = [];

  if (probe.implementation !== "CPython") {
    return {
      readiness: "unsupported-version",
      missing: [`CPython required, found ${probe.implementation}`],
    };
  }

  if (!meetsMinimum(probe.version, MIN_PYTHON_VERSION)) {
    missing.push(`Python >= ${MIN_PYTHON_VERSION} (found ${probe.version})`);
  }

  const jupyterClientVersion = probe.packages["jupyter_client"] ?? null;
  if (jupyterClientVersion === null) {
    missing.push("jupyter_client");
  } else if (!meetsMinimum(jupyterClientVersion, MIN_JUPYTER_CLIENT_VERSION)) {
    missing.push(`jupyter_client >= ${MIN_JUPYTER_CLIENT_VERSION} (found ${jupyterClientVersion})`);
  }

  const ipykernelVersion = probe.packages["ipykernel"] ?? null;
  if (ipykernelVersion === null) {
    missing.push("ipykernel");
  } else if (!meetsMinimum(ipykernelVersion, MIN_IPYKERNEL_VERSION)) {
    missing.push(`ipykernel >= ${MIN_IPYKERNEL_VERSION} (found ${ipykernelVersion})`);
  }

  if (missing.length > 0) {
    return { readiness: "missing-requirement", missing };
  }

  return { readiness: "ready", missing: [] };
}

/**
 * Builds a `ComputeRuntimeProfile` from a probe result.
 */
export function buildProfile(
  probe: ProbeResult,
  source: ComputeRuntimeSource,
): ComputeRuntimeProfile {
  return {
    languageId: PYTHON_LANGUAGE_ID,
    source,
    executable: probe.executable,
    languageVersion: probe.version,
    architecture: probe.architecture,
    displayName: `Python ${probe.version} (${source})`,
  };
}

/**
 * Builds the launch plan for the bridge process.
 *
 * The selected executable launches the checked-in bridge by absolute path:
 * `<selected-python> -I -u <absolute-bridge-path>`
 *
 * `-I` prevents project-controlled PYTHONPATH, user site packages, and current
 * directory imports from changing bridge code resolution.
 */
export function buildLaunchPlan(
  request: ComputeLaunchRequest,
  bridgePath: string,
): ComputeLaunchPlan {
  return {
    executable: request.profile.executable,
    args: ["-I", "-u", bridgePath],
    cwd: request.cwd,
    environment: request.environment,
  };
}

/**
 * Computes a provenance fingerprint from a profile.
 *
 * This is provenance, not a safe verification-cache key: package contents can
 * change without changing the interpreter executable.  Phase 2 does not cache
 * verification.
 */
export function computeFingerprint(
  profile: ComputeRuntimeProfile,
  packageVersions: Readonly<Record<string, string | null>>,
): ComputeEnvironmentFingerprint {
  const contributors = ["executable", "languageVersion", ...Object.keys(packageVersions).sort()];
  const data = [
    profile.executable,
    profile.languageVersion,
    ...Object.entries(packageVersions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  ].join("|");
  const hash = Crypto.createHash("sha256").update(data).digest("hex");
  return {
    hash: `sha256:${hash}`,
    contributors,
  };
}

/**
 * Builds the ordered candidate executable list for discovery.
 *
 * Does not pre-check candidates.  The probe classifies spawn errors directly.
 */
export function discoverCandidates(
  projectRoot: string,
  configuredExecutable: string | null,
  platform: string,
): ReadonlyArray<{ readonly executable: string; readonly source: ComputeRuntimeSource }> {
  const candidates: Array<{ executable: string; source: ComputeRuntimeSource }> = [];
  const isWindows = platform.startsWith("win");

  if (configuredExecutable !== null) {
    candidates.push({ executable: configuredExecutable, source: "configured" });
  }

  const venvPython = isWindows
    ? Path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : Path.join(projectRoot, ".venv", "bin", "python");
  if (FS.existsSync(venvPython)) {
    candidates.push({ executable: venvPython, source: "project" });
  }

  if (isWindows) {
    candidates.push({ executable: "python.exe", source: "path" });
    candidates.push({ executable: "python3.exe", source: "path" });
  } else {
    candidates.push({ executable: "python3", source: "path" });
    candidates.push({ executable: "python", source: "path" });
  }

  // Deduplicate by canonical executable, preserving precedence order.
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = Path.isAbsolute(c.executable) ? c.executable : c.executable;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

function runtimeError(
  operation: ComputeRuntimeError["operation"],
  message: string,
  cause?: unknown,
): ComputeRuntimeError {
  return new ComputeRuntimeError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Creates the Python runtime adapter.
 *
 * Pure helpers (`parseProbeOutput`, `checkReadiness`, `buildProfile`,
 * `buildLaunchPlan`, `computeFingerprint`, `discoverCandidates`) are exported
 * separately for unit testing without Python.
 *
 * @param spawnProbe - A function that runs the probe script on a candidate
 *   executable and returns its stdout.  This is the only process boundary;
 *   tests inject a fake.
 * @param bridgePath - Absolute path to the checked-in bridge script.
 */
export function makePythonRuntimeAdapter(
  spawnProbe: (executable: string) => Effect.Effect<string, ComputeRuntimeError>,
  bridgePath: string,
): ComputeLanguageAdapter {
  const discover: ComputeLanguageAdapter["discover"] = (request) =>
    Effect.gen(function* () {
      const candidates = discoverCandidates(
        request.projectRoot,
        request.configuredExecutable,
        process.platform,
      );

      const profiles: ComputeRuntimeProfile[] = [];
      for (const candidate of candidates) {
        const result = yield* Effect.matchEffect(spawnProbe(candidate.executable), {
          onFailure: () => Effect.succeed({ success: false as const, stdout: "" }),
          onSuccess: (stdout) => Effect.succeed({ success: true as const, stdout }),
        });
        if (result.success) {
          try {
            const probe = parseProbeOutput(result.stdout);
            profiles.push(buildProfile(probe, candidate.source));
          } catch {
            // Skip candidates whose probe output is malformed.
          }
        }
        // If an explicit configured executable fails, return its invalid
        // profile rather than silently replacing it.
        if (candidate.source === "configured" && !result.success && profiles.length === 0) {
          return [
            {
              languageId: PYTHON_LANGUAGE_ID,
              source: "configured",
              executable: candidate.executable,
              languageVersion: "unknown",
              architecture: null,
              displayName: `Python (configured, not found)`,
            },
          ];
        }
      }

      return profiles;
    });

  const verify: ComputeLanguageAdapter["verify"] = (launchRequest) =>
    Effect.gen(function* () {
      const stdout = yield* spawnProbe(launchRequest.profile.executable).pipe(
        Effect.mapError((cause) =>
          runtimeError("verify", `Failed to probe ${launchRequest.profile.executable}.`, cause),
        ),
      );

      let probe: ProbeResult;
      try {
        probe = parseProbeOutput(stdout);
      } catch (cause) {
        return {
          profile: launchRequest.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: `Probe output was malformed: ${(cause as Error).message}`,
        };
      }

      const { readiness, missing } = checkReadiness(probe);

      // Verify that prepareLaunch produces the same executable as the probe.
      const plan = buildLaunchPlan(launchRequest, bridgePath);
      if (plan.executable !== probe.executable) {
        return {
          profile: launchRequest.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: `Probe executable ${probe.executable} differs from launch executable ${plan.executable}.`,
        };
      }

      return {
        profile: launchRequest.profile,
        readiness,
        missingRequirements: missing,
        message: readiness === "ready" ? null : missing.join(", "),
      } satisfies ComputeRuntimeVerification;
    });

  const prepareLaunch: ComputeLanguageAdapter["prepareLaunch"] = (request) =>
    Effect.succeed(buildLaunchPlan(request, bridgePath));

  const normalizeDiagnostic: ComputeLanguageAdapter["normalizeDiagnostic"] = (report) =>
    normalizePythonDiagnostic(report);

  const fingerprintEnvironment: ComputeLanguageAdapter["fingerprintEnvironment"] = (profile) =>
    Effect.gen(function* () {
      const stdout = yield* spawnProbe(profile.executable).pipe(
        Effect.mapError((cause) =>
          runtimeError("fingerprint", `Failed to probe ${profile.executable}.`, cause),
        ),
      );
      const probe = parseProbeOutput(stdout);
      return computeFingerprint(profile, probe.packages);
    });

  return {
    languageId: PYTHON_LANGUAGE_ID,
    transportKind: JUPYTER_BRIDGE_TRANSPORT_KIND,
    discover,
    verify,
    prepareLaunch,
    normalizeDiagnostic,
    fingerprintEnvironment,
  };
}
