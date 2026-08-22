import {
  DuplexProcessError,
  type DuplexProcessHandle,
  type DuplexProcessPort,
} from "@scientfactory/execution";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { LOCAL_OWNED_PROCESS_KILL_OPTIONS, makeLocalOwnedProcess } from "./LocalOwnedProcess.ts";

export class DuplexProcess extends Context.Service<DuplexProcess, DuplexProcessPort>()(
  "t3/scient/execution/LocalDuplexProcess/DuplexProcess",
) {}

/**
 * How long output is still drained after the direct child has exited.
 *
 * Long enough that anything already buffered in the operating-system pipe is
 * delivered even to a briefly stalled consumer, short enough that a leaked
 * descendant holding the inherited descriptor cannot stall a consumer for
 * long. Losing a peer's final protocol frame is the worse failure, so this
 * errs on the generous side.
 */
const OUTPUT_DRAIN_GRACE = "1 second";

function processError(
  operation: DuplexProcessError["operation"],
  message: string,
  cause?: unknown,
): DuplexProcessError {
  return new DuplexProcessError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;

  const start: DuplexProcessPort["start"] = (request) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(makeLocalOwnedProcess(request, platform, { keepInputOpen: true }))
        .pipe(
          Effect.mapError((cause) =>
            processError("spawn", "Unable to start the duplex process.", cause),
          ),
        );

      // One writer at a time: the peer reads a framed byte stream, so two
      // requests that overlap would arrive as one unreadable request.
      const writeGate = yield* Semaphore.make(1);
      const write = (bytes: Uint8Array) =>
        child.isRunning.pipe(
          Effect.mapError((cause) =>
            processError("write", "Unable to inspect the duplex process before writing.", cause),
          ),
          Effect.flatMap((isRunning) =>
            isRunning
              ? Effect.raceFirst(
                  Stream.run(Stream.make(bytes), child.stdin).pipe(
                    Effect.mapError((cause) =>
                      processError("write", "Unable to send input to the duplex process.", cause),
                    ),
                  ),
                  child.exitCode.pipe(
                    Effect.matchCauseEffect({
                      onFailure: (cause) =>
                        Effect.fail(
                          processError(
                            "write",
                            "Unable to send input because the duplex process stopped.",
                            cause,
                          ),
                        ),
                      onSuccess: () =>
                        Effect.fail(
                          processError(
                            "write",
                            "Unable to send input because the duplex process stopped.",
                          ),
                        ),
                    }),
                  ),
                )
              : Effect.fail(
                  processError(
                    "write",
                    "Unable to send input because the duplex process has stopped.",
                  ),
                ),
          ),
          writeGate.withPermits(1),
        );

      const exitCode = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) =>
          processError("exit", "Unable to observe the duplex process exit.", cause),
        ),
      );

      // A descendant that inherited the child's stdout keeps the pipe open
      // after the child itself is gone, so end-of-file alone can leave a
      // consumer pulling forever. Wait for the child to exit, then allow one
      // drain window so buffered frames — a peer's final protocol reply, for
      // instance — are still delivered, and only then stop pulling. The exit
      // outcome is deliberately discarded: a cancelled process exits by
      // signal, and that is a normal end of output, not a read failure.
      const outputDrainDeadline = exitCode.pipe(
        Effect.exit,
        Effect.andThen(Effect.sleep(OUTPUT_DRAIN_GRACE)),
      );

      const readStream = <E>(stream: Stream.Stream<Uint8Array, E>, name: "stdout" | "stderr") =>
        stream.pipe(
          Stream.mapError((cause) =>
            processError("output", `Unable to read duplex process ${name}.`, cause),
          ),
          Stream.haltWhen(outputDrainDeadline),
        );

      // `kill` signals the detached group on Unix and the tree via taskkill on
      // Windows, falls back to the direct child, and resolves only once that
      // child has exited — the stop acknowledgement the port promises. A tree
      // that is already gone reports the absence differently on every platform
      // (`ESRCH` once reaped, `EPERM` for an unreaped macOS zombie, a non-zero
      // taskkill exit on Windows), so the child's own liveness, not the signal
      // result, decides whether cancellation actually failed.
      const cancelProcessTree = child.kill(LOCAL_OWNED_PROCESS_KILL_OPTIONS).pipe(
        Effect.catch((cause) =>
          child.isRunning.pipe(
            Effect.catchCause(() => Effect.succeed(true)),
            Effect.flatMap((isRunning) =>
              isRunning
                ? Effect.fail(
                    processError("cancel", "Unable to stop the duplex process tree.", cause),
                  )
                : Effect.void,
            ),
          ),
        ),
      );

      return {
        pid: Number(child.pid),
        stdout: readStream(child.stdout, "stdout"),
        stderr: readStream(child.stderr, "stderr"),
        write,
        exitCode,
        cancelProcessTree,
      } satisfies DuplexProcessHandle;
    });

  return DuplexProcess.of({ start });
});

export const layer = Layer.effect(DuplexProcess, make);
