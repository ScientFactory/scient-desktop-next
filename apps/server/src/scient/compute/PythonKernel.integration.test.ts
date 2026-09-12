// @effect-diagnostics nodeBuiltinImport:off -- gated integration test uses an explicitly selected Python.
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputeLanguageId,
  ComputeRequestId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  nextComputeSessionGeneration,
  projectComputeOutputs,
  type ComputeChannel,
  type ComputeRuntimeProfile,
  type ComputeTransportEvent,
} from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DuplexProcess, layer as duplexProcessLayer } from "../execution/LocalDuplexProcess.ts";
import { processExists } from "../execution/LocalProcessTestSupport.ts";
import { makeComputeBridgeTransport } from "./ComputeBridgeTransport.ts";
import { buildLaunchPlan } from "./PythonRuntimeAdapter.ts";

/**
 * Every case here is `it.live` rather than `it.effect`.
 *
 * `it.effect` installs a `TestClock`, where time only moves when a test moves
 * it. That is right for logic and wrong for this suite: these tests wait on real
 * processes, so a `sleep` would never wake and the `timeout` guarding each case
 * would never fire -- a hang would present as the whole file stalling instead of
 * as one failing test.
 */
const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const bridgePath = NodePath.join(here, "bridge", "scient_compute_bridge.py");
const Live = duplexProcessLayer.pipe(Layer.provideMerge(NodeServices.layer));

const sessionId = ComputeSessionId.make("python-integration-session");
const python = ComputeLanguageId.make("python");
const transportKind = ComputeTransportKind.make("jupyter-bridge");
type ReadyEvent = Extract<ComputeTransportEvent, { readonly _tag: "ready" }>;
interface IntegrationHarness {
  readonly channel: ComputeChannel;
  readonly events: Queue.Dequeue<ComputeTransportEvent>;
  readonly ready: ReadyEvent;
}

function outputText(event: ComputeTransportEvent): string | null {
  if (event._tag !== "output") return null;
  if (event.output._tag === "stream") return event.output.text;
  if (event.output._tag !== "display-data" && event.output._tag !== "execute-result") return null;
  const plain = event.output.bundle.representations.find(
    (representation) => representation.mediaType === "text/plain",
  );
  return plain?.data._tag === "text" ? plain.data.text : null;
}

function richResource(event: ComputeTransportEvent, mediaType: "image/png" | "image/svg+xml") {
  if (
    event._tag !== "output" ||
    (event.output._tag !== "display-data" && event.output._tag !== "execute-result")
  ) {
    return null;
  }
  const representation = event.output.bundle.representations.find(
    (candidate) => candidate.mediaType === mediaType && candidate.data._tag === "resource",
  );
  if (representation?.data._tag !== "resource") return null;
  const contentHash = representation.data.contentHash;
  const resource = event.resources.find((candidate) => candidate.contentHash === contentHash);
  return resource ?? null;
}

function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(NodeProcess.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

/**
 * Waits for a process to be gone, rather than asking whether it is gone yet.
 *
 * Nothing here removes a process synchronously.  `cancelProcessTree` signals
 * and returns, and a kernel orphaned by a bridge that was killed outright is
 * removed by ipykernel's own parent poller, which checks about once a second.
 * Asking immediately would be testing the scheduler, not the behaviour.
 */
const awaitProcessGone = (pid: number, within = "10 seconds" as const) =>
  Effect.gen(function* () {
    while (processExists(pid)) yield* Effect.sleep("100 millis");
  }).pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => Effect.sync(() => expect(processExists(pid)).toBe(false)),
    }),
  );

const takeMatching = (
  queue: Queue.Dequeue<ComputeTransportEvent>,
  predicate: (event: ComputeTransportEvent) => boolean,
): Effect.Effect<ComputeTransportEvent> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  });

const integration = Effect.fn("PythonKernel.integration")(function* () {
  if (!TEST_PYTHON) return yield* Effect.die("SCIENT_TEST_PYTHON is not set.");
  const processes = yield* DuplexProcess;
  const transport = makeComputeBridgeTransport(processes, {});
  const profile: ComputeRuntimeProfile = {
    languageId: python,
    source: "configured",
    executable: TEST_PYTHON,
    languageVersion: "unknown",
    architecture: null,
    displayName: "Python (integration)",
  };
  // Through the adapter rather than hand-built: a launch plan that skipped
  // `buildLaunchPlan` would also skip the environment policy, and then this
  // test would be proving the bridge works under conditions production never
  // gives it.
  const launch = buildLaunchPlan(
    { profile, cwd: here, environment: hostEnvironment() },
    bridgePath,
  );
  const channel = yield* transport.open({
    sessionId,
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    languageId: python,
    transportKind,
    launch,
    requiredCapabilities: ["execute", "interrupt", "restart", "shutdown"],
  });
  const events = yield* Queue.unbounded<ComputeTransportEvent>();
  yield* channel.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.ignore,
    Effect.forkScoped,
  );
  const ready = yield* takeMatching(events, (event) => event._tag === "ready");
  if (ready._tag !== "ready") return yield* Effect.die("Expected ready event.");
  return { channel, events, ready };
});

const execute = Effect.fn("PythonKernel.execute")(function* (
  harness: IntegrationHarness,
  id: string,
  code: string,
  generation = INITIAL_COMPUTE_SESSION_GENERATION,
) {
  const requestId = ComputeRequestId.make(id);
  NodeProcess.stderr.write(`real-kernel send: ${id}\n`);
  yield* harness.channel.execute({ requestId, expectedGeneration: generation, code });
  NodeProcess.stderr.write(`real-kernel sent: ${id}\n`);
  const observed: ComputeTransportEvent[] = [];
  for (;;) {
    const event = yield* Queue.take(harness.events);
    NodeProcess.stderr.write(`real-kernel event: ${event._tag}\n`);
    if (event._tag === "output") {
      NodeProcess.stderr.write(`real-kernel output: ${event.output._tag}\n`);
    }
    observed.push(event);
    if (event._tag === "completed" && event.requestId === requestId) {
      return observed;
    }
  }
});

describe.runIf(Boolean(TEST_PYTHON))("Python kernel integration", () => {
  it.live(
    "emits bounded dataframe previews and Plotly MIME without browser launch or namespace pollution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* integration();
          const observed = yield* execute(
            harness,
            "table-and-plotly",
            [
              "import pandas as pd",
              "from IPython.display import display",
              "frame = pd.DataFrame({f'column_{i}': range(150) for i in range(30)})",
              "display(frame)",
              "display({'application/vnd.plotly.v1+json': {'data': [{'type': 'scatter', 'x': [1, 2], 'y': [3, 4]}]}}, raw=True)",
              "assert 'table_preview' not in globals()",
            ].join("\n"),
          );
          const outputs = observed.flatMap((event) =>
            event._tag === "output" ? [event.output] : [],
          );
          const representations = outputs.flatMap((output) =>
            output._tag === "display-data" ? output.bundle.representations : [],
          );
          const table = representations.find(
            (item) => item.mediaType === "application/vnd.dataresource+json",
          );
          if (table?.data._tag !== "json") throw new Error("Expected bounded dataframe JSON");
          const data = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                data: Schema.Array(Schema.Unknown),
                schema: Schema.Struct({ fields: Schema.Array(Schema.Unknown) }),
                scientPreview: Schema.Struct({ truncated: Schema.Boolean }),
              }),
            ),
          )(table.data.json);
          expect(data.data).toHaveLength(100);
          expect(data.schema.fields).toHaveLength(21);
          expect(data.scientPreview.truncated).toBe(true);
          expect(
            representations.some((item) => item.mediaType === "application/vnd.plotly.v1+json"),
          ).toBe(true);
          yield* harness.channel.shutdown({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
        }),
      ).pipe(Effect.provide(Live), Effect.timeout("60 seconds")),
  );

  it.live("retains complete MIME bundles and projects display updates and delayed clears", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        const observed = yield* execute(
          harness,
          "rich-display-lifecycle",
          [
            "from IPython.display import display, update_display, clear_output",
            "class Rich:",
            "    def __init__(self, label): self.label = label",
            "    def _repr_mimebundle_(self, include=None, exclude=None):",
            "        return ({",
            "            'text/plain': self.label,",
            "            'application/json': {'label': self.label},",
            "            'image/svg+xml': f'<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{self.label}</text></svg>',",
            "        }, {'image/svg+xml': {'isolated': True}})",
            "first_handle = display(Rich('first'), display_id='shared-display')",
            "update_display(Rich('updated'), display_id='shared-display')",
            "clear_output(wait=True)",
            "final_handle = display(Rich('final'))",
          ].join("\n"),
        );
        const outputs = observed.flatMap((event) =>
          event._tag === "output" ? [event.output] : [],
        );
        const displayOutputs = outputs.filter((output) => output._tag !== "stream");
        expect(displayOutputs.map(({ _tag }) => _tag)).toEqual([
          "display-data",
          "display-update",
          "clear-output",
          "display-data",
        ]);
        const first = displayOutputs[0];
        if (first?._tag !== "display-data") throw new Error("Expected display data.");
        expect(first.bundle.representations.map(({ mediaType }) => mediaType)).toEqual([
          "text/plain",
          "application/json",
          "image/svg+xml",
        ]);
        expect(first.displayId).toBe("shared-display");
        const projected = projectComputeOutputs(displayOutputs);
        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({
          _tag: "representation",
          kind: "display-data",
          displayId: null,
        });
        const final = projected[0];
        if (final?._tag !== "representation") throw new Error("Expected final representation.");
        expect(
          final.bundle.representations.find(({ mediaType }) => mediaType === "text/plain"),
        ).toMatchObject({ data: { _tag: "text", text: "final" } });
        yield* harness.channel.shutdown({ expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION });
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("60 seconds")),
  );

  it.live("executes statefully, maps output and PNG, interrupts, restarts, and shuts down", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        expect(harness.ready.runtime.languageId).toBe("python");
        expect(harness.ready.capabilities).toContain("variables");
        const bridgePid = harness.ready.runtime.transportProcessId!;
        const firstKernelPid = harness.ready.runtime.runtimeProcessId!;
        expect(processExists(bridgePid)).toBe(true);
        expect(processExists(firstKernelPid)).toBe(true);

        const arithmetic = yield* execute(harness, "arithmetic", "1 + 1");
        yield* Effect.logInfo("real-kernel: arithmetic complete");
        expect(arithmetic.some((event) => outputText(event)?.includes("2") === true)).toBe(true);

        yield* execute(harness, "state-write", "answer = 41");
        const stateRead = yield* execute(harness, "state-read", "answer + 1");
        yield* Effect.logInfo("real-kernel: state retention complete");
        expect(stateRead.some((event) => outputText(event)?.includes("42") === true)).toBe(true);

        const variables = yield* harness.channel.inspectVariables({
          requestId: ComputeRequestId.make("variables-after-state"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        expect(variables.variables).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "answer", typeName: "int", preview: "41" }),
          ]),
        );

        const streamsAndError = yield* execute(
          harness,
          "streams-error",
          "import sys\nprint('stdout-marker')\nprint('stderr-marker', file=sys.stderr)\nraise ValueError('failure-marker')",
        );
        yield* Effect.logInfo("real-kernel: streams and error complete");
        expect(
          streamsAndError.some(
            (event) =>
              event._tag === "output" &&
              event.output._tag === "stream" &&
              event.output.stream === "stdout" &&
              event.output.text.includes("stdout-marker"),
          ),
        ).toBe(true);
        expect(
          streamsAndError.some(
            (event) =>
              event._tag === "output" &&
              event.output._tag === "stream" &&
              event.output.stream === "stderr" &&
              event.output.text.includes("stderr-marker"),
          ),
        ).toBe(true);
        expect(
          streamsAndError.some(
            (event) =>
              event._tag === "runtime-error" && event.report.value.includes("failure-marker"),
          ),
        ).toBe(true);

        const figure = yield* execute(
          harness,
          "figure",
          "import matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4])\nplt.show()",
        );
        yield* Effect.logInfo("real-kernel: figure complete");
        const image = figure.map((event) => richResource(event, "image/png")).find(Boolean);
        expect(image?.bytes.byteLength).toBeGreaterThan(100);

        const svgFigure = yield* execute(
          harness,
          "svg-figure",
          [
            "class InlineSvg:",
            "    def _repr_svg_(self):",
            '        return \'<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>\'',
            "display(InlineSvg())",
          ].join("\n"),
        );
        yield* Effect.logInfo("real-kernel: SVG figure complete");
        const svgImage = svgFigure
          .map((event) => richResource(event, "image/svg+xml"))
          .find(Boolean);
        expect(new TextDecoder().decode(svgImage?.bytes)).toContain("<svg");

        const loopId = ComputeRequestId.make("interrupt-loop");
        NodeProcess.stderr.write("real-kernel send: interrupt-loop\n");
        yield* harness.channel.execute({
          requestId: loopId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "while True:\n    pass",
        });
        yield* takeMatching(
          harness.events,
          (event) => event._tag === "accepted" && event.requestId === loopId,
        );
        NodeProcess.stderr.write("real-kernel accepted: interrupt-loop\n");
        yield* harness.channel.interrupt({
          requestId: loopId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        });
        NodeProcess.stderr.write("real-kernel interrupt acknowledged\n");
        const interrupted = yield* takeMatching(
          harness.events,
          (event) => event._tag === "completed" && event.requestId === loopId,
        );
        yield* Effect.logInfo("real-kernel: interrupt complete");
        expect(interrupted).toMatchObject({ _tag: "completed", outcome: "cancelled" });

        const nextGeneration = nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION);
        yield* harness.channel.restart({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          nextGeneration,
        });
        const restarted = yield* takeMatching(
          harness.events,
          (event) => event._tag === "restarted",
        );
        yield* Effect.logInfo("real-kernel: restart complete");
        expect(restarted._tag).toBe("restarted");
        if (restarted._tag === "restarted") {
          expect(restarted.runtime.runtimeProcessId).not.toBe(firstKernelPid);
        }
        expect(processExists(firstKernelPid)).toBe(false);

        const cleared = yield* execute(harness, "state-cleared", "answer", nextGeneration);
        yield* Effect.logInfo("real-kernel: cleared-state check complete");
        expect(
          cleared.some(
            (event) => event._tag === "runtime-error" && event.report.name === "NameError",
          ),
        ).toBe(true);

        const tableAfterRestart = yield* execute(
          harness,
          "table-after-restart",
          "import pandas as pd\nfrom IPython.display import display\ndisplay(pd.DataFrame({'answer': [42]}))",
          nextGeneration,
        );
        expect(
          tableAfterRestart.some(
            (event) =>
              event._tag === "output" &&
              event.output._tag === "display-data" &&
              event.output.bundle.representations.some(
                (item) => item.mediaType === "application/vnd.dataresource+json",
              ),
          ),
        ).toBe(true);

        yield* harness.channel.shutdown({ expectedGeneration: nextGeneration });
        yield* Effect.logInfo("real-kernel: shutdown complete");
        yield* awaitProcessGone(bridgePid);
        if (restarted._tag === "restarted" && restarted.runtime.runtimeProcessId !== null) {
          yield* awaitProcessGone(restarted.runtime.runtimeProcessId);
        }
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("90 seconds")),
  );

  it.live("reports bridge loss and removes its kernel process", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* integration();
          const bridgePid = harness.ready.runtime.transportProcessId!;
          const kernelPid = harness.ready.runtime.runtimeProcessId!;
          NodeProcess.stderr.write(`real-kernel crash: ${bridgePid}/${kernelPid}\n`);
          NodeProcess.kill(bridgePid, "SIGKILL");
          const lost = yield* takeMatching(harness.events, (event) => event._tag === "lost");
          NodeProcess.stderr.write("real-kernel lost received\n");
          expect(lost._tag).toBe("lost");
          return { bridgePid, kernelPid };
        }),
      ).pipe(Effect.provide(Live), Effect.timeout("30 seconds"));

      yield* awaitProcessGone(result.bridgePid);
      yield* awaitProcessGone(result.kernelPid);
    }),
  );

  it.live("reports a kernel that dies under a bridge that survives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        const bridgePid = harness.ready.runtime.transportProcessId!;
        const kernelPid = harness.ready.runtime.runtimeProcessId!;
        // The bridge is still there to explain what happened, which is the
        // difference between this and a bridge crash: the session must end with
        // a reason rather than with silence.
        NodeProcess.kill(kernelPid, "SIGKILL");
        const requestId = ComputeRequestId.make("after-kernel-death");
        yield* harness.channel
          .execute({
            requestId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "1 + 1",
          })
          .pipe(Effect.ignore);
        const lost = yield* takeMatching(harness.events, (event) => event._tag === "lost");
        if (lost._tag !== "lost") throw new Error("Expected loss.");
        expect(lost.reason.length).toBeGreaterThan(0);
        yield* awaitProcessGone(kernelPid);
        yield* awaitProcessGone(bridgePid);
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("60 seconds")),
  );

  it.live("survives a grandchild writing straight to the bridge's stdout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        // A `subprocess.run` inherits file descriptor 1.  If that descriptor
        // were still the protocol stream, these bytes would land inside a frame
        // and every later message would be unreadable -- so the real assertion
        // here is that the two executions after it still work.
        const corrupting = yield* execute(
          harness,
          "raw-fd-write",
          "import subprocess, sys\nsubprocess.run([sys.executable, '-c', \"import os; os.write(1, b'RAWSUB')\"])\nprint('after-subprocess')",
        );
        expect(corrupting.at(-1)).toMatchObject({ _tag: "completed", outcome: "succeeded" });

        const afterwards = yield* execute(harness, "after-raw-fd", "7 * 6");
        expect(afterwards.some((event) => outputText(event)?.includes("42") === true)).toBe(true);

        yield* harness.channel.shutdown({
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        });
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("60 seconds")),
  );
  it.live("carries a flood of output and stays readable afterwards", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        // Twenty thousand lines as fast as a kernel can produce them. The point
        // is the drain: the bridge queues frames without a cap and flushes on a
        // high-water mark, so what this holds it to is that nothing was dropped
        // and nothing was torn -- and the execution after it still parses.
        const flood = yield* execute(
          harness,
          "flood",
          "for index in range(20000):\n    print(f'line-{index}')",
        );
        expect(flood.at(-1)).toMatchObject({ _tag: "completed", outcome: "succeeded" });
        const text = flood
          .flatMap((event) =>
            event._tag === "output" && event.output._tag === "stream" ? [event.output.text] : [],
          )
          .join("");
        expect(text).toContain("line-0\n");
        expect(text).toContain("line-19999\n");
        // Count only the flood lines. Older kernels can emit a leading stderr
        // warning, which must not be mistaken for a dropped or extra payload line.
        const lines = text.split("\n").filter((line) => /^line-\d+$/.test(line));
        expect(lines).toHaveLength(20000);
        expect(lines.find((line, index) => line !== `line-${index}`)).toBeUndefined();

        const afterwards = yield* execute(harness, "after-flood", "6 * 7");
        expect(afterwards.some((event) => outputText(event)?.includes("42") === true)).toBe(true);
        yield* harness.channel.shutdown({ expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION });
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("120 seconds")),
  );

  it.live("stays correct through rapid executions and an interrupt storm", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        // Back-to-back cells, the way re-running a notebook produces them. Each
        // one has to be correlated to its own reply, and the mapping has to be
        // clean again before the next arrives.
        for (let index = 0; index < 40; index += 1) {
          const observed = yield* execute(harness, `rapid-${index}`, `${index} * 3 + 1`);
          expect(observed.at(-1)).toMatchObject({ _tag: "completed", outcome: "succeeded" });
          expect(
            observed.some((event) => outputText(event)?.includes(String(index * 3 + 1)) === true),
          ).toBe(true);
        }

        for (let round = 0; round < 6; round += 1) {
          const loopId = ComputeRequestId.make(`storm-${round}`);
          yield* harness.channel.execute({
            requestId: loopId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            code: "while True:\n    pass",
          });
          yield* takeMatching(
            harness.events,
            (event) => event._tag === "accepted" && event.requestId === loopId,
          );
          yield* harness.channel.interrupt({
            requestId: loopId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          const ended = yield* takeMatching(
            harness.events,
            (event) => event._tag === "completed" && event.requestId === loopId,
          );
          expect(ended).toMatchObject({ _tag: "completed", outcome: "cancelled" });
        }

        // The namespace is what a session exists to hold, and six interrupts in
        // a row must not have cost it.
        yield* execute(harness, "storm-state-write", "survivor = 11");
        const read = yield* execute(harness, "storm-state-read", "survivor + 1");
        expect(read.some((event) => outputText(event)?.includes("12") === true)).toBe(true);
        yield* harness.channel.shutdown({ expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION });
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("240 seconds")),
  );

  it.live("survives being restarted over and over", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* integration();
        yield* execute(harness, "before-restarts", "keeper = 3");
        let generation = INITIAL_COMPUTE_SESSION_GENERATION;
        let kernelPid = harness.ready.runtime.runtimeProcessId!;

        for (let round = 0; round < 4; round += 1) {
          const nextGeneration = nextComputeSessionGeneration(generation);
          yield* harness.channel.restart({ expectedGeneration: generation, nextGeneration });
          const restarted = yield* takeMatching(
            harness.events,
            (event) => event._tag === "restarted",
          );
          if (restarted._tag !== "restarted") throw new Error("Expected a restart.");
          expect(restarted.generation).toBe(nextGeneration);
          const replacement = restarted.runtime.runtimeProcessId!;
          expect(replacement).not.toBe(kernelPid);
          // The kernel a restart replaced is gone rather than merely detached:
          // four restarts must not leave four kernels behind on the machine.
          yield* awaitProcessGone(kernelPid);
          kernelPid = replacement;
          generation = nextGeneration;

          // Each generation is a new namespace, and each one still runs code.
          const cleared = yield* execute(harness, `after-restart-${round}`, "keeper", generation);
          expect(
            cleared.some(
              (event) => event._tag === "runtime-error" && event.report.name === "NameError",
            ),
          ).toBe(true);
        }

        yield* harness.channel.shutdown({ expectedGeneration: generation });
        yield* awaitProcessGone(harness.ready.runtime.transportProcessId!);
        yield* awaitProcessGone(kernelPid);
      }),
    ).pipe(Effect.provide(Live), Effect.timeout("240 seconds")),
  );
});
