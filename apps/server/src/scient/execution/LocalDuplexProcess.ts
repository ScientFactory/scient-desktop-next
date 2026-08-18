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

      const readStream = <E>(stream: Stream.Stream<Uint8Array, E>, name: "stdout" | "stderr") =>
        stream.pipe(
          Stream.mapError((cause) =>
            processError("output", `Unable to read duplex process ${name}.`, cause),
          ),
        );

      const exitCode = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) =>
          processError("exit", "Unable to observe the duplex process exit.", cause),
        ),
      );

      // Effect's Node handle targets the detached process group on Unix and uses
      // taskkill /T /F on Windows. Keep this as a tree operation; the integration
      // fixture proves a spawned descendant exits with its parent.
      const cancelProcessTree = child
        .kill(LOCAL_OWNED_PROCESS_KILL_OPTIONS)
        .pipe(
          Effect.mapError((cause) =>
            processError("cancel", "Unable to stop the duplex process tree.", cause),
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
