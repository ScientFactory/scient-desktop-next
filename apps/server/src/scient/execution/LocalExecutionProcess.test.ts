// @effect-diagnostics nodeBuiltinImport:off -- integration fixture probes its captured child PID.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionRunId } from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ExecutionProcess, layer } from "./LocalExecutionProcess.ts";
import { descendantFixture, processExists } from "./LocalProcessTestSupport.ts";

const Live = layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("LocalExecutionProcess", () => {
  it.effect("cancels a spawned descendant with the owned process tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ExecutionProcess;
        const handle = yield* processes.start({
          runId: ExecutionRunId.make("process-tree-test"),
          executable: NodeProcess.execPath,
          args: ["-e", descendantFixture],
          cwd: NodeProcess.cwd(),
          environment: {},
        });
        const childPidLine = yield* handle.output.pipe(
          Stream.filter((output) => output.stream === "stdout"),
          Stream.map((output) => output.text),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const childPid = Number(childPidLine);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(processExists(childPid)).toBe(true);

        yield* handle.cancel;

        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(Live)),
  );
});
