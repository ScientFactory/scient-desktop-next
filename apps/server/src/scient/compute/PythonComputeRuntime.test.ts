// @effect-diagnostics nodeBuiltinImport:off -- the layouts under test are paths.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExecutionProcessError,
  ExecutionRunId,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  BRIDGE_SCRIPT_NAME,
  MAXIMUM_PROBE_STDOUT_BYTES,
  STAGED_BRIDGE_DIRECTORY,
  bridgePathCandidates,
  makeSpawnProbe,
  moduleDirectory,
  resolveBridgePath,
} from "./PythonComputeRuntime.ts";

interface ProbeScript {
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
  readonly exitCode?: number;
  /** Never exits, so the probe's own deadline is what ends it. */
  readonly silent?: boolean;
  /** Exits, but leaves stdout held open, so end-of-file never arrives. */
  readonly outputNeverEnds?: boolean;
  readonly unstartable?: boolean;
}

interface FakeProcesses {
  readonly port: ExecutionProcessPort;
  readonly requests: Effect.Effect<ReadonlyArray<Parameters<ExecutionProcessPort["start"]>[0]>>;
  readonly cancelled: Effect.Effect<number>;
}

const fakeProcesses = (script: ProbeScript): Effect.Effect<FakeProcesses> =>
  Effect.gen(function* () {
    const requestsRef = yield* Ref.make<
      ReadonlyArray<Parameters<ExecutionProcessPort["start"]>[0]>
    >([]);
    const cancelledRef = yield* Ref.make(0);
    const port: ExecutionProcessPort = {
      start: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(requestsRef, (requests) => [...requests, request]);
          if (script.unstartable === true) {
            return yield* new ExecutionProcessError({
              operation: "spawn",
              message: "No such file or directory.",
            });
          }
          const written = Stream.fromArray([
            ...(script.stdout ?? []).map((text) => ({ stream: "stdout" as const, text })),
            ...(script.stderr ?? []).map((text) => ({ stream: "stderr" as const, text })),
          ]);
          return {
            output:
              script.outputNeverEnds === true ? Stream.concat(written, Stream.never) : written,
            exitCode: script.silent === true ? Effect.never : Effect.succeed(script.exitCode ?? 0),
            cancel: Ref.update(cancelledRef, (count) => count + 1),
          };
        }),
    };
    return {
      port,
      requests: Ref.get(requestsRef),
      cancelled: Ref.get(cancelledRef),
    };
  });

const probeFor = (script: ProbeScript, cwd = "/tmp") =>
  Effect.gen(function* () {
    const processes = yield* fakeProcesses(script);
    const probe = yield* makeSpawnProbe(processes.port, {
      environment: { PATH: "/usr/bin", PYTHONIOENCODING: "utf-8" },
      cwd,
    });
    return { ...processes, probe };
  });

describe("python bridge location", () => {
  it("looks beside the source before anything a build staged", () => {
    expect(bridgePathCandidates("/app")).toEqual([
      NodePath.join("/app", "bridge", BRIDGE_SCRIPT_NAME),
      NodePath.join("/app", STAGED_BRIDGE_DIRECTORY, BRIDGE_SCRIPT_NAME),
    ]);
  });

  it.effect("finds the bridge this repository checks in", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBridgePath(moduleDirectory());
      expect(resolved).toBe(NodePath.join(moduleDirectory(), "bridge", BRIDGE_SCRIPT_NAME));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // The build stages the bridge by spelling its destination out again, because
  // a build script that imported this module would drag its dependency graph
  // into every build. That duplication is only safe if something notices when
  // the two halves stop agreeing, and nothing else would: the publish gate
  // checks its own constant, so a rename here would pass every lane and ship an
  // app whose compute silently reports no runtime.
  it.effect("agrees with the build about where a packaged bridge goes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cli = yield* fileSystem.readFileString(
        NodePath.join(moduleDirectory(), "..", "..", "..", "scripts", "cli.ts"),
      );

      expect(cli).toContain(`dist/${STAGED_BRIDGE_DIRECTORY}/${BRIDGE_SCRIPT_NAME}`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a staged bridge when there is no source tree to read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-compute-staged-",
      });
      const staged = NodePath.join(directory, STAGED_BRIDGE_DIRECTORY);
      yield* fileSystem.makeDirectory(staged, { recursive: true });
      yield* fileSystem.writeFileString(NodePath.join(staged, BRIDGE_SCRIPT_NAME), "");

      expect(yield* resolveBridgePath(directory)).toBe(NodePath.join(staged, BRIDGE_SCRIPT_NAME));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says where it looked when the bridge is not installed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-compute-absent-",
      });

      const failure = yield* Effect.flip(resolveBridgePath(directory));
      expect(failure.message).toContain(BRIDGE_SCRIPT_NAME);
      for (const candidate of bridgePathCandidates(directory)) {
        expect(failure.message).toContain(candidate);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("python interpreter probe", () => {
  it.effect("returns what the interpreter printed, and nothing it warned about", () =>
    Effect.gen(function* () {
      const { probe } = yield* probeFor({
        stdout: ['{"version":', '"3.12.0"}\n'],
        stderr: ["a warning nobody asked for\n"],
      });

      expect(yield* probe("/usr/bin/python3")).toBe('{"version":"3.12.0"}\n');
    }),
  );

  it.effect("runs isolated, in one place, with exactly the environment it was given", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* probeFor({ stdout: ["{}"] }, "/var/folders/tmp");
      yield* probe("/usr/bin/python3");

      const [request] = yield* requests;
      expect(request?.executable).toBe("/usr/bin/python3");
      expect(request?.args.slice(0, 2)).toEqual(["-I", "-c"]);
      expect(request?.cwd).toBe("/var/folders/tmp");
      // The launch policy is only a policy if the process layer is told not to
      // put back what the policy took out.
      expect(request?.extendEnv).toBe(false);
      expect(request?.environment).toEqual({ PATH: "/usr/bin", PYTHONIOENCODING: "utf-8" });
    }),
  );

  it.effect("tells two probes apart", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* probeFor({ stdout: ["{}"] });
      yield* probe("/usr/bin/python3");
      yield* probe("/usr/local/bin/python3");

      expect((yield* requests).map((request) => request.runId)).toEqual([
        ExecutionRunId.make("scient-compute-probe-1"),
        ExecutionRunId.make("scient-compute-probe-2"),
      ]);
    }),
  );

  it.effect("fails when the interpreter refuses the probe", () =>
    Effect.gen(function* () {
      const { probe } = yield* probeFor({ stderr: ["No module named json\n"], exitCode: 1 });

      const failure = yield* Effect.flip(probe("/usr/bin/python3"));
      expect(failure.message).toContain("exited with code 1");
    }),
  );

  it.effect("fails when there is no interpreter there to run", () =>
    Effect.gen(function* () {
      const { probe } = yield* probeFor({ unstartable: true });

      const failure = yield* Effect.flip(probe("/nope/python3"));
      expect(failure.message).toContain("/nope/python3");
    }),
  );

  it.effect("stops reading once a leaked descendant is all that holds the pipe open", () =>
    Effect.gen(function* () {
      // The interpreter answered and exited; something it left behind still has
      // stdout, so end-of-file never comes. The answer is already in hand, and
      // waiting for a file that will not end would hold discovery open forever.
      const { probe } = yield* probeFor({
        stdout: ['{"version":"3.12.0"}\n'],
        outputNeverEnds: true,
      });

      const running = yield* Effect.forkChild(probe("/usr/bin/python3"));
      yield* TestClock.adjust("30 seconds");

      expect(yield* Fiber.join(running)).toBe('{"version":"3.12.0"}\n');
    }),
  );

  it.effect("stops an interpreter that never answers, rather than waiting on it", () =>
    Effect.gen(function* () {
      const { probe, cancelled } = yield* probeFor({ silent: true });

      const running = yield* Effect.forkChild(probe("/usr/bin/python3"));
      yield* TestClock.adjust("60 seconds");
      const failure = yield* Effect.flip(Fiber.join(running));

      expect(failure.message).toContain("did not answer");
      // Killed as a tree: an interpreter with nothing to say may still have
      // started something that does.
      expect(yield* cancelled).toBe(1);
    }),
  );

  it.effect("stops a probe as soon as its stdout exceeds the aggregate limit", () =>
    Effect.gen(function* () {
      const { probe, cancelled } = yield* probeFor({
        stdout: ["x".repeat(MAXIMUM_PROBE_STDOUT_BYTES), "overflow"],
        silent: true,
      });

      const failure = yield* Effect.flip(probe("/project/.venv/bin/python"));

      expect(failure.message).toContain("probe output limit");
      expect(yield* cancelled).toBe(1);
    }),
  );
});
