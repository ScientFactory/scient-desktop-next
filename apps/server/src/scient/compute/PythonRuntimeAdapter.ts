// @effect-diagnostics nodeBuiltinImport:off -- discovery checks .venv existence and resolves paths.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ComputeEnvironmentFingerprint,
  ComputeLanguageId,
  ComputeRuntimeError,
  ComputeRuntimeProfile,
  ComputeRuntimeReadiness,
  ComputeRuntimeSource,
  ComputeRuntimeVerification,
  ComputeTransportKind,
  type ComputeLanguageAdapter,
  type ComputeLaunchPlan,
  type ComputeLaunchRequest,
} from "@scientfactory/compute";

import { sanitizeComputeEnvironment, validateProjectRoot } from "./ComputeEnvironmentPolicy.ts";
import { normalizePythonDiagnostic } from "./PythonDiagnostic.ts";

// ---------------------------------------------------------------------------
// Language and transport identity
// ---------------------------------------------------------------------------

export const PYTHON_LANGUAGE_ID = ComputeLanguageId.make("python");
export const JUPYTER_BRIDGE_TRANSPORT_KIND = ComputeTransportKind.make("jupyter-bridge");

// ---------------------------------------------------------------------------
// Minimum version requirements (from Phase 2 plan §2.6)
// ---------------------------------------------------------------------------

/**
 * 3.10 is the floor because the bridge builds an `asyncio.Event` before a loop
 * is running, which 3.9 rejects outright. Verified against 3.9: the bridge's own
 * unit tests fail to construct it at all.
 */
const MIN_PYTHON_VERSION = "3.10";
const MIN_JUPYTER_CLIENT_VERSION = "8.6";
const MIN_IPYKERNEL_VERSION = "6.29";

// ---------------------------------------------------------------------------
// Probe schema
// ---------------------------------------------------------------------------

const ProbeResult = Schema.Struct({
  executable: Schema.String,
  executableRealpath: Schema.String,
  executableMtimeNs: Schema.String,
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

interface ComparablePythonVersion {
  readonly release: ReadonlyArray<number>;
  readonly prerelease: boolean;
}

/**
 * The readiness gate needs only PEP 440's ordering around a final minimum.
 * Parse that subset explicitly instead of letting `Number("rc1")` become NaN
 * and accidentally treating malformed or pre-release versions as equal.
 */
function parseComparableVersion(value: string): ComparablePythonVersion | null {
  const match =
    /^(\d+(?:\.\d+)*)(?:(a|b|rc)\d+|(?:[._-]?dev)\d*)?(?:(?:[._-]?post)\d*)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i.exec(
      value.trim(),
    );
  if (match === null) return null;
  return {
    release: match[1]!.split(".").map((segment) => Number.parseInt(segment, 10)),
    prerelease: match[2] !== undefined || /(?:^|[._-])dev\d*/i.test(value),
  };
}

function compareVersions(a: ComparablePythonVersion, b: ComparablePythonVersion): number {
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const va = a.release[i] ?? 0;
    const vb = b.release[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
}

function meetsMinimum(actual: string, minimum: string): boolean {
  const parsedActual = parseComparableVersion(actual);
  const parsedMinimum = parseComparableVersion(minimum);
  return (
    parsedActual !== null &&
    parsedMinimum !== null &&
    compareVersions(parsedActual, parsedMinimum) >= 0
  );
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
  "import importlib.metadata as metadata, json, os, sys, platform",
  "r = {",
  '  "executable": sys.executable,',
  '  "executableRealpath": os.path.realpath(sys.executable),',
  '  "executableMtimeNs": str(os.stat(sys.executable).st_mtime_ns),',
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
  '        r["packages"][pkg] = metadata.version(pkg)',
  "    except metadata.PackageNotFoundError:",
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
 *
 * The environment policy is applied here rather than by the caller. This is the
 * only function that produces a plan, so enforcing it here means no caller can
 * forget to -- and the raw environment a caller passes in is treated as an
 * input to sanitize rather than a decision to honour.
 */
export function buildLaunchPlan(
  request: ComputeLaunchRequest,
  bridgePath: string,
): ComputeLaunchPlan {
  const cwd = validateProjectRoot(request.cwd);
  const { environment } = sanitizeComputeEnvironment(request.environment);
  return {
    executable: request.profile.executable,
    args: ["-I", "-u", bridgePath],
    cwd,
    environment,
  };
}

/**
 * Computes a provenance fingerprint from the selected profile and its probe.
 *
 * This is provenance, not a safe verification-cache key: package contents can
 * change without changing the interpreter executable. The short probe cache is
 * only startup deduplication and does not make this a verification-cache key.
 */
export function computeFingerprint(
  profile: ComputeRuntimeProfile,
  probe: ProbeResult,
): ComputeEnvironmentFingerprint {
  const contributors = [
    "executable",
    "executableMtimeNs",
    "languageVersion",
    "architecture",
    "implementation",
    "prefix",
    "basePrefix",
    "platform",
    ...Object.keys(probe.packages).sort(),
  ];
  const data = [
    probe.executableRealpath,
    probe.executableMtimeNs,
    profile.languageVersion,
    profile.architecture ?? "",
    probe.implementation,
    probe.prefix,
    probe.base_prefix,
    probe.platform,
    ...Object.entries(probe.packages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  ].join("|");
  const hash = NodeCrypto.createHash("sha256").update(data).digest("hex");
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
    ? NodePath.join(projectRoot, ".venv", "Scripts", "python.exe")
    : NodePath.join(projectRoot, ".venv", "bin", "python");
  if (NodeFS.existsSync(venvPython)) {
    candidates.push({ executable: venvPython, source: "project" });
  }

  if (isWindows) {
    candidates.push({ executable: "python.exe", source: "path" });
    candidates.push({ executable: "python3.exe", source: "path" });
  } else {
    candidates.push({ executable: "python3", source: "path" });
    candidates.push({ executable: "python", source: "path" });
  }

  // Deduplicate by executable, preserving precedence order.  A configured
  // executable that also happens to be the project venv is probed once, under
  // the stronger source.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.executable)) return false;
    seen.add(candidate.executable);
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
  const probeCache = new Map<
    string,
    { readonly probe: ProbeResult; readonly observedAt: number }
  >();
  const probeCacheTtlMs = 30_000;

  const cachedProbe = (executable: string, now: number): ProbeResult | null => {
    const cached = probeCache.get(executable);
    if (cached === undefined) return null;
    if (now - cached.observedAt > probeCacheTtlMs) {
      probeCache.delete(executable);
      return null;
    }
    return cached.probe;
  };

  const rememberProbe = (
    requestedExecutable: string,
    probe: ProbeResult,
    observedAt: number,
  ): ProbeResult => {
    const entry = { probe, observedAt };
    probeCache.set(requestedExecutable, entry);
    probeCache.set(probe.executable, entry);
    return probe;
  };

  const readProbe = (executable: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cachedProbe(executable, now);
      if (cached !== null) return cached;
      const stdout = yield* spawnProbe(executable);
      return yield* Effect.try({
        try: () => rememberProbe(executable, parseProbeOutput(stdout), now),
        catch: (cause) =>
          runtimeError("verify", `Probe output from ${executable} was malformed.`, cause),
      });
    });

  const discover: ComputeLanguageAdapter["discover"] = (request) =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const candidates = discoverCandidates(
        request.projectRoot,
        request.configuredExecutable,
        platform,
      );

      const profiles: ComputeRuntimeProfile[] = [];
      for (const candidate of candidates) {
        const result = yield* Effect.matchEffect(readProbe(candidate.executable), {
          onFailure: () => Effect.succeed({ success: false as const, probe: null }),
          onSuccess: (probe) => Effect.succeed({ success: true as const, probe }),
        });
        // Malformed probe output is as unusable as a probe that would not run
        // at all: a runtime that cannot describe itself is not one to offer.
        const profile = result.success
          ? Option.some(buildProfile(result.probe, candidate.source))
          : Option.none();
        if (Option.isSome(profile)) profiles.push(profile.value);
        // An interpreter the user named is answered with its own result rather
        // than quietly replaced by whatever else happens to be installed.
        if (candidate.source === "configured" && Option.isNone(profile)) {
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
      const parsed = yield* Effect.result(
        readProbe(launchRequest.profile.executable).pipe(
          Effect.mapError((cause) => runtimeError("verify", cause.message, cause)),
        ),
      );
      if (parsed._tag === "Failure") {
        return {
          profile: launchRequest.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: `Probe failed: ${parsed.failure.message}`,
        } satisfies ComputeRuntimeVerification;
      }
      const probe = parsed.success;

      const { readiness, missing } = checkReadiness(probe);

      // The profile records the interpreter's own `sys.executable`, so a launch
      // built from it must name that same interpreter.  A mismatch means the
      // profile was not produced by `discover` against this interpreter and the
      // readiness answer above would describe a different runtime.
      if (launchRequest.profile.executable !== probe.executable) {
        return {
          profile: launchRequest.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: `Probe executable ${probe.executable} differs from launch executable ${launchRequest.profile.executable}.`,
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
    Effect.try({
      try: () => buildLaunchPlan(request, bridgePath),
      catch: (cause) => runtimeError("prepare", "The launch request was not usable.", cause),
    });

  const normalizeDiagnostic: ComputeLanguageAdapter["normalizeDiagnostic"] = (report) =>
    normalizePythonDiagnostic(report);

  const fingerprintEnvironment: ComputeLanguageAdapter["fingerprintEnvironment"] = (profile) =>
    Effect.gen(function* () {
      const probe = yield* readProbe(profile.executable).pipe(
        Effect.mapError((cause) => runtimeError("fingerprint", cause.message, cause)),
      );
      return computeFingerprint(profile, probe);
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
