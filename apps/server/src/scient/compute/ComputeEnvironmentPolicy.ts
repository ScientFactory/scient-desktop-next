// @effect-diagnostics nodeBuiltinImport:off -- canonical path validation needs node:path.
import * as NodePath from "node:path";

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
  "PYTHONEXECUTABLE",
  // Jupyter/IPython overrides. Each of these can redirect which code the
  // kernel loads: a kernelspec, a config file, an IPython startup script.
  // `JUPYTER_RUNTIME_DIR` is deliberately not here -- it only chooses where the
  // connection file is written, cannot introduce code, and a container that
  // points it at the one writable directory it has needs it to survive.
  "JUPYTER_CONFIG_DIR",
  "JUPYTER_PATH",
  "JUPYTER_DATA_DIR",
  "IPYTHONDIR",
  // Credentials this application itself puts in the environment. They belong
  // here for the same reason as the keys below, but they are the ones most
  // likely to actually be present: the server was started with them.
  // `ANTHROPIC_AUTH_TOKEN` and friends are already covered by the `ANTHROPIC_`
  // prefix; these two are the sign-in tokens that carry no such prefix.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
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
 * Rejects a working directory that is not absolute or not lexically canonical.
 *
 * Authorization happens before the adapter; this layer rejects malformed or
 * noncanonical launch inputs so a relative or traversal-bearing path cannot
 * reach the process layer.
 *
 * Symlinks are deliberately not resolved. Whoever authorized this root
 * authorized the path as written, and answering with a different path would
 * silently move the session outside what was approved -- on macOS it would
 * rewrite every `/tmp` root to `/private/tmp`. What is being rejected here is
 * a malformed string, not an unexpected inode.
 *
 * Throws rather than returning a failure: an absolute canonical path is a
 * precondition every caller has already established, so reaching this with a
 * relative path is a defect in the caller, not a condition to recover from.
 */
export function validateProjectRoot(root: string): string {
  if (!NodePath.isAbsolute(root)) {
    throw new Error(`Project root must be an absolute path, received: ${root}`);
  }
  const resolved = NodePath.resolve(root);
  if (resolved !== root) {
    throw new Error(`Project root must be canonical, received: ${root}, resolved: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * The one spelling of a key that matching happens on.
 *
 * Windows environment variables are case-insensitive, and so is Python's own
 * reading of them there, so a host that exported `PythonPath` would hand user
 * code exactly the override this list exists to remove. Unix keys are
 * case-sensitive, but every name here is a conventional all-caps one, so
 * folding case can only remove more than intended in cases that do not occur --
 * and removing too much from a compute launch is the harmless direction.
 *
 * `toUpperCase` rather than `toLocaleUpperCase`: this must fold the same way on
 * every machine, including a Turkish one where `i` does not uppercase to `I`.
 */
const canonicalKey = (key: string): string => key.toUpperCase();

const DENIED_KEYS: ReadonlySet<string> = new Set(ENVIRONMENT_DENYLIST.map(canonicalKey));
const DENIED_PREFIXES: ReadonlyArray<string> = ENVIRONMENT_PREFIX_DENYLIST.map(canonicalKey);

function isDenied(key: string): boolean {
  const canonical = canonicalKey(key);
  if (DENIED_KEYS.has(canonical)) return true;
  return DENIED_PREFIXES.some((prefix) => canonical.startsWith(prefix));
}

/**
 * Builds a complete sanitized environment for a compute launch.
 *
 * Starts from the host environment, removes every denied key, and applies the
 * UTF-8 and unbuffered overrides.  The process layer must use
 * `extendEnv: false` with this record; otherwise the host environment is
 * silently re-added.
 *
 * Never logs values.  `removedKeys` returns only the key names that were
 * removed, for test observability.
 */
export function sanitizeComputeEnvironment(hostEnv: Readonly<Record<string, string>>): {
  readonly environment: Record<string, string>;
  readonly removedKeys: ReadonlyArray<string>;
} {
  const removed: string[] = [];
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(hostEnv)) {
    if (isDenied(key)) {
      removed.push(key);
    } else {
      env[key] = value;
    }
  }

  // A differently-cased copy of an override key would sit beside it in the
  // record and win on Windows, where the two are the same variable. Take the
  // host's spelling out before putting ours in, so the launch has exactly one.
  const overridden = new Set(Object.keys(ENVIRONMENT_OVERRIDES).map(canonicalKey));
  for (const key of Object.keys(env)) {
    if (overridden.has(canonicalKey(key))) delete env[key];
  }
  Object.assign(env, ENVIRONMENT_OVERRIDES);

  return { environment: env, removedKeys: removed };
}
