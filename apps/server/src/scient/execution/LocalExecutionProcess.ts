import {
  ExecutionProcessError,
  type ExecutionProcessHandle,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { LOCAL_OWNED_PROCESS_KILL_OPTIONS, makeLocalOwnedProcess } from "./LocalOwnedProcess.ts";

export class ExecutionProcess extends Context.Service<ExecutionProcess, ExecutionProcessPort>()(
  "t3/scient/execution/LocalExecutionProcess/ExecutionProcess",
) {}

function processError(
  operation: ExecutionProcessError["operation"],
  message: string,
  cause: unknown,
): ExecutionProcessError {
  return new ExecutionProcessError({ operation, message, cause });
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;

  const start: ExecutionProcessPort["start"] = (request) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(makeLocalOwnedProcess(request, platform))
        .pipe(
          Effect.mapError((cause) =>
            processError("spawn", "Unable to start the execution process.", cause),
          ),
        );
      const output = Stream.merge(
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.map((text) => ({ stream: "stdout" as const, text })),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.map((text) => ({ stream: "stderr" as const, text })),
        ),
      ).pipe(
        Stream.mapError((cause) =>
          processError("output", "Unable to read execution process output.", cause),
        ),
      );
      const exitCode = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) =>
          processError("exit", "Unable to observe the execution process exit.", cause),
        ),
      );
      // Effect's Node handle targets the detached process group on Unix and uses
      // taskkill /T /F on Windows. Keep this as a tree operation; the integration
      // fixture proves a spawned descendant exits with its parent.
      const cancel = child
        .kill(LOCAL_OWNED_PROCESS_KILL_OPTIONS)
        .pipe(
          Effect.mapError((cause) =>
            processError("cancel", "Unable to stop the execution process tree.", cause),
          ),
        );
      return { output, exitCode, cancel } satisfies ExecutionProcessHandle;
    });

  return ExecutionProcess.of({ start });
});

export const layer = Layer.effect(ExecutionProcess, make);
