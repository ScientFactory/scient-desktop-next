// @effect-diagnostics nodeBuiltinImport:off -- the bridge is a file shipped
// beside this module, so finding it means asking the loader where this module
// is; the probe's working directory is the host's temporary directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ComputeRuntimeError } from "@scientfactory/compute";
import { ExecutionRunId, type ExecutionProcessPort } from "@scientfactory/execution";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { DuplexProcess } from "../execution/LocalDuplexProcess.ts";
import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import { layerWithRuntimeBindings, type ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { makeJupyterBridgeTransport } from "./JupyterBridgeTransport.ts";
import { PROBE_SCRIPT, makePythonRuntimeAdapter } from "./PythonRuntimeAdapter.ts";

/**
 * The Python runtime as the running server has it: a real interpreter probe and
 * the bridge script on disk.
 *
 * Everything language-specific is already in `PythonRuntimeAdapter`, and
 * everything protocol-specific is already in `JupyterBridgeTransport`. What is
 * left, and all this module does, is the two things neither of them can answer
 * for itself: where the bridge script lives in this installation, and how a
 * probe process actually gets run.
 */

export const BRIDGE_SCRIPT_NAME = "scient_compute_bridge.py";

/**
 * Where the build stages the bridge next to the bundled server.
 *
 * Named rather than inlined because two places have to agree on it: the build
 * that copies the bridge there and the resolver below that looks for it.
 */
export const STAGED_BRIDGE_DIRECTORY = "scient-compute-bridge";

/**
 * How long a probe may take before it is treated as no answer.
 *
 * A probe is one interpreter importing five modules, so a healthy one answers
 * in well under a second. The number is generous because the slow case is a
 * cold interpreter on a cold disk, and the failure this guards against is not
 * slowness but silence: an interpreter that never answers would otherwise hold
 * discovery open for as long as the user is willing to wait.
 */
const PROBE_TIMEOUT = Duration.seconds(20);

/**
 * How long the probe keeps reading after the interpreter is done.
 *
 * By then the bytes are already in the operating-system pipe, so this is only
 * the time it takes to copy them, and generous for that. What it guards against
 * is the same thing the duplex port guards against: a descendant that inherited
 * stdout keeps the pipe open after the interpreter itself is gone, so
 * end-of-file never arrives and a reader waiting for it waits forever. A
 * configured interpreter can be any program the user named -- a wrapper script,
 * an activation shim -- so this is not only a theoretical shape.
 */
const PROBE_DRAIN_GRACE = Duration.seconds(2);

/** A probe emits one small JSON object; anything larger is not a probe result. */
export const MAXIMUM_PROBE_STDOUT_BYTES = 256 * 1024;

const PROBE_ARGS: ReadonlyArray<string> = ["-I", "-c", PROBE_SCRIPT];

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

/**
 * The directory this module was loaded from.
 *
 * From source that is this source directory; from the bundle it is the
 * directory holding the one file the server was collapsed into.
 */
export function moduleDirectory(): string {
  return NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
}

/**
 * The places the bridge script can be, in the order they are tried.
 *
 * The server runs two ways and the bridge sits differently in each: from
 * source it is in `bridge/` beside this module, and from the bundle it is in a
 * directory the build staged beside the bundled entry point. Source is tried
 * first so that a developer editing the bridge is never served a copy an
 * earlier build left behind.
 */
export function bridgePathCandidates(directory: string): ReadonlyArray<string> {
  return [
    NodePath.join(directory, "bridge", BRIDGE_SCRIPT_NAME),
    NodePath.join(directory, STAGED_BRIDGE_DIRECTORY, BRIDGE_SCRIPT_NAME),
  ];
}

/**
 * Finds the bridge script, or explains where it was looked for.
 *
 * Resolved once when the service is built rather than per launch: an
 * installation that is missing the bridge is broken in a way no session can
 * work around, and saying so at startup is more useful than saying it the
 * first time a user opens a panel.
 */
export const resolveBridgePath = (
  directory: string,
): Effect.Effect<string, ComputeRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = bridgePathCandidates(directory);
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) return candidate;
    }
    return yield* runtimeError(
      `Unable to find ${BRIDGE_SCRIPT_NAME}. Looked in: ${candidates.join(", ")}.`,
    );
  });

/**
 * Runs the probe script on one candidate interpreter and returns its stdout.
 *
 * This is the adapter's only process boundary, and it is deliberately thin: it
 * decides nothing about what the output means. A candidate that cannot be
 * spawned, exits non-zero, or says nothing in time all fail here, and the
 * adapter reads a failure as "not a usable interpreter" without needing to
 * know which of the three happened.
 *
 * The environment is the sanitized one, passed with `extendEnv: false`, so a
 * probe sees what a launch will see. Without that the probe could report
 * packages that the bridge, started under the launch policy, cannot import.
 */
export const makeSpawnProbe = (
  processes: ExecutionProcessPort,
  options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeout?: Duration.Duration;
  },
): Effect.Effect<(executable: string) => Effect.Effect<string, ComputeRuntimeError>> =>
  Effect.gen(function* () {
    // The port wants an id per run. Nothing reads it here; it only has to tell
    // two probes apart in a trace.
    const runCounter = yield* Ref.make(0);
    const timeout = options.timeout ?? PROBE_TIMEOUT;

    return (executable: string) =>
      Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(runCounter, (value) => value + 1);
        const handle = yield* processes
          .start({
            runId: ExecutionRunId.make(`scient-compute-probe-${String(count)}`),
            executable,
            args: PROBE_ARGS,
            cwd: options.cwd,
            environment: options.environment,
            extendEnv: false,
          })
          .pipe(Effect.mapError((cause) => runtimeError(`Unable to run ${executable}.`, cause)));
        // Drained on its own fiber, so an interpreter that writes more than a
        // pipe holds cannot block on a reader that is waiting for it to exit.
        const stdoutRef = yield* Ref.make("");
        const stdoutBytesRef = yield* Ref.make(0);
        const outputExceeded = yield* Deferred.make<void>();
        const drain = yield* handle.output.pipe(
          Stream.runForEach((chunk) =>
            chunk.stream !== "stdout"
              ? Effect.void
              : Effect.gen(function* () {
                  const bytes = Buffer.byteLength(chunk.text, "utf8");
                  const total = yield* Ref.updateAndGet(
                    stdoutBytesRef,
                    (current) => current + bytes,
                  );
                  if (total > MAXIMUM_PROBE_STDOUT_BYTES) {
                    yield* Deferred.succeed(outputExceeded, undefined);
                    return;
                  }
                  yield* Ref.update(stdoutRef, (text) => text + chunk.text);
                }),
          ),
          Effect.catchCause((cause) =>
            Effect.logDebug("compute probe output ended early", { cause }),
          ),
          Effect.forkScoped,
        );
        const exitCode = yield* Effect.raceFirst(
          handle.exitCode.pipe(
            Effect.mapError((cause) => runtimeError(`Unable to wait for ${executable}.`, cause)),
            Effect.timeoutOption(timeout),
          ),
          Deferred.await(outputExceeded).pipe(Effect.as(Option.none<number>())),
        );
        // A silent interpreter is killed as a tree: the probe is isolated, but
        // nothing stops it from having started something of its own.
        if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
        yield* Fiber.join(drain).pipe(
          Effect.timeoutOption(PROBE_DRAIN_GRACE),
          Effect.ignoreCause(),
        );
        if (Option.isNone(exitCode)) {
          if ((yield* Ref.get(stdoutBytesRef)) > MAXIMUM_PROBE_STDOUT_BYTES) {
            return yield* runtimeError(
              `${executable} exceeded the ${String(MAXIMUM_PROBE_STDOUT_BYTES)}-byte probe output limit.`,
            );
          }
          return yield* runtimeError(
            `${executable} did not answer the probe in ${Duration.format(timeout)}.`,
          );
        }
        if (exitCode.value !== 0) {
          return yield* runtimeError(`${executable} exited with code ${String(exitCode.value)}.`);
        }
        return yield* Ref.get(stdoutRef);
      }).pipe(Effect.scoped);
  });

/**
 * The Python binding this server can actually run.
 *
 * Built as an effect because both halves have to be acquired: the bridge is
 * found on disk and the probe needs the process port.
 */
export const pythonRuntimeBinding: Effect.Effect<
  ComputeRuntimeBinding,
  ComputeRuntimeError,
  DuplexProcess | ExecutionProcess | FileSystem.FileSystem
> = Effect.gen(function* () {
  const bridgePath = yield* resolveBridgePath(moduleDirectory());
  const processes = yield* ExecutionProcess;
  const duplexProcesses = yield* DuplexProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const spawnProbe = yield* makeSpawnProbe(processes, {
    environment,
    // A probe belongs to no project, so it runs somewhere that always exists
    // and holds nothing it could import. `-I` already keeps the working
    // directory off the interpreter's path; this keeps a deleted project
    // directory from failing a probe that has nothing to do with it.
    cwd: NodeOS.tmpdir(),
  });
  return {
    adapter: makePythonRuntimeAdapter(spawnProbe, bridgePath),
    transport: makeJupyterBridgeTransport(duplexProcesses, {}),
  };
});

/**
 * The compute session service as the server runs it: Python over the Jupyter
 * bridge, with no idle timeout.
 *
 * No idle timeout is the deliberate default. A kernel holds the state a user
 * has built up by running code, and taking that away while they are reading
 * their own output would be the service deciding their work is over. Sessions
 * end when the user ends them or when the server stops.
 *
 * An installation with no bridge script starts with no Python binding rather
 * than not starting. Compute is one feature of an application that has many,
 * and refusing to boot an editor because a `.py` file is missing would take
 * away everything else with it. The session service already has an answer for
 * a language it cannot run, so the loss is contained to opening a session, and
 * the release gate -- which asserts the bridge is staged -- is where a build
 * that shipped without it is supposed to be caught.
 */
export const layer = layerWithRuntimeBindings(
  pythonRuntimeBinding.pipe(
    Effect.map((binding) => [binding]),
    Effect.catch((cause) =>
      Effect.as(
        Effect.logWarning("compute is unavailable: no Python runtime could be prepared", {
          reason: cause.message,
        }),
        [],
      ),
    ),
  ),
);
