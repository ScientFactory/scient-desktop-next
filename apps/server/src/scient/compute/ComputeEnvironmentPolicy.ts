// @effect-diagnostics nodeBuiltinImport:off -- canonical path validation needs node:path.
import * as Path from "node:path";

// ---------------------------------------------------------------------------
// Exact-key denylist
// ---------------------------------------------------------------------------

/**
 * Environment variables removed by exact key from every compute launch.
 *
 * These are Python/Jupyter overrides that could change bridge code resolution
 * or kernel behavior, plus known credential keys.  This is credential-hygiene
 * defense in depth, not a sandbox: user code retains the filesystem, network,
 * and process authority of the server account.
 */
export const ENVIRONMENT_DENYLIST: ReadonlyArray<string> = [
  // Python overrides that could change bridge code resolution.
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONPYTHONPATH",
  // Jupyter/IPython overrides.
  "JUPYTER_CONFIG_DIR",
  "JUPYTER_PATH",
  "JUPYTER_DATA_DIR",
  "IPYTHONDIR",
  // Known cloud/provider credential keys (exact match).
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
  "SLACK_BOT_TOKEN",
] as const;

/**
 * Environment variable prefixes removed from every compute launch.
 *
 * Every key starting with one of these prefixes is removed.  These cover
 * Scient/T3-owned configuration, pairing, telemetry, updater, signing, and
 * service-credential namespaces that user code should not inherit.
 */
export const ENVIRONMENT_PREFIX_DENYLIST: ReadonlyArray<string> = [
  "SCIENT_",
  "T3_",
  "ANTHROPIC_",
  "OPENAI_",
  "FF_",
  "FFF_",
] as const;

// ---------------------------------------------------------------------------
// Overrides applied after sanitization
// ---------------------------------------------------------------------------

/**
 * Sets UTF-8 and unbuffered behavior so Python output is correct and prompt.
 */
const ENVIRONMENT_OVERRIDES: Readonly<Record<string, string>> = {
  PYTHONUTF8: "1",
  PYTHONUNBUFFERED: "1",
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Rejects a working directory that is not absolute or not canonical.
 *
 * Authorization happens before the adapter; this layer rejects malformed or
 * noncanonical launch inputs so a relative or traversal-bearing path cannot
 * reach the process layer.
 */
export function validateProjectRoot(root: string): string {
  if (!Path.isAbsolute(root)) {
    throw new Error(`Project root must be an absolute path, received: ${root}`);
  }
  const resolved = Path.resolve(root);
  if (resolved !== root) {
    throw new Error(`Project root must be canonical, received: ${root}, resolved: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function isDenied(key: string): boolean {
  if (ENVIRONMENT_DENYLIST.includes(key)) return true;
  return ENVIRONMENT_PREFIX_DENYLIST.some((prefix) => key.startsWith(prefix));
}

/**
 * Builds a complete sanitized environment for a compute launch.
 *
 * Starts from the host environment, removes every denied key, applies UTF-8
 * and unbuffered overrides, and optionally sets a Jupyter runtime directory
 * for connection files.  The process layer must use `extendEnv: false` with
 * this record; otherwise the host environment is silently re-added.
 *
 * Never logs values.  `removedKeysForDiagnostics` returns only the key names
 * that were removed, for test observability.
 */
export function sanitizeComputeEnvironment(
  hostEnv: Readonly<Record<string, string>>,
  options?: { readonly jupyterRuntimeDir?: string },
): { readonly environment: Record<string, string>; readonly removedKeys: ReadonlyArray<string> } {
  const removed: string[] = [];
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(hostEnv)) {
    if (isDenied(key)) {
      removed.push(key);
    } else {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(ENVIRONMENT_OVERRIDES)) {
    env[key] = value;
  }

  if (options?.jupyterRuntimeDir !== undefined) {
    env["JUPYTER_RUNTIME_DIR"] = options.jupyterRuntimeDir;
  }

  return { environment: env, removedKeys: removed };
}
