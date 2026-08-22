import { ChildProcess } from "effect/unstable/process";

export interface LocalOwnedProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Whether to merge the host environment into `environment`. Defaults to
   * `true` for backward compatibility. Compute launches pass a complete
   * sanitized environment with `extendEnv: false`; passing a sanitized record
   * while the process layer silently re-adds the host environment is not
   * sanitization.
   */
  readonly extendEnv?: boolean;
}

export const LOCAL_OWNED_PROCESS_KILL_OPTIONS = {
  killSignal: "SIGTERM",
  forceKillAfter: "5 seconds",
} as const;

/**
 * One no-shell spawn policy for every Scient-owned local process tree.
 *
 * Keeping the policy here prevents the one-shot and duplex adapters from
 * drifting on environment inheritance, process groups, or kill deadlines.
 */
export function makeLocalOwnedProcess(
  request: LocalOwnedProcessRequest,
  platform: NodeJS.Platform,
  options?: { readonly keepInputOpen?: boolean },
): ChildProcess.Command {
  return ChildProcess.make(request.executable, request.args, {
    cwd: request.cwd,
    env: request.environment,
    extendEnv: request.extendEnv ?? true,
    shell: false,
    detached: platform !== "win32",
    ...LOCAL_OWNED_PROCESS_KILL_OPTIONS,
    ...(options?.keepInputOpen === true
      ? { stdin: { stream: "pipe" as const, endOnDone: false } }
      : {}),
  });
}
