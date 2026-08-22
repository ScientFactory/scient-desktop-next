// @effect-diagnostics nodeBuiltinImport:off -- gated integration test uses an explicit host Python.
import * as NodeProcess from "node:process";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  INITIAL_COMPUTE_SESSION_GENERATION,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "./ComputeSessionService.ts";
import { makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import * as PythonComputeRuntime from "./PythonComputeRuntime.ts";

const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const PYTHON = ComputeLanguageId.make("python");

const waitForTerminal = Effect.fn("ComputeProduct.waitForTerminal")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
) {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    const executions = yield* gateway.listExecutions({ cwd, sessionId, limit: 100 });
    const execution = executions.find((candidate) => candidate.request.executionId === executionId);
    if (
      execution !== undefined &&
      execution.result !== null &&
      TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
    ) {
      return execution;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`Execution '${executionId}' did not finish.`));
});

describe.runIf(Boolean(TEST_PYTHON))("compute product backend", () => {
  it.live("runs the Phase 4 gateway through the durable service and a real kernel", () =>
    Effect.gen(function* () {
      if (!TEST_PYTHON) return yield* Effect.die("SCIENT_TEST_PYTHON is not set.");
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-compute-product-project-",
      });
      const stateRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-compute-product-state-",
      });
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

      const computeLayer = PythonComputeRuntime.layer.pipe(
        Layer.provide(LocalComputeStore.layer),
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provide(LocalDuplexProcess.layer),
        Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
        Layer.provide(NodeServices.layer),
      );
      const workspaceLayer = WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const compute = yield* ComputeSessionService.ComputeSessionService;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const gateway = makeComputeRpcGateway({
          compute,
          workspaceFileSystem,
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              scientificComputing: {
                schemaVersion: 1,
                languages: {
                  python: { enabled: true, executable: TEST_PYTHON },
                },
              },
            }),
          },
        });

        const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
        const runtime = inspection.languages
          .find((language) => language.descriptor.languageId === PYTHON)
          ?.runtimes.find((candidate) => candidate.verification.readiness === "ready");
        if (runtime === undefined) return yield* Effect.die("No ready Python runtime was found.");
        expect(runtime.profile.source).toBe("configured");
        expect(yield* fs.exists(runtime.profile.executable)).toBe(true);

        const sessionId = ComputeSessionId.make("phase-4-session-1");
        const session = yield* gateway.startSession({
          cwd: projectRoot,
          sessionId,
          languageId: PYTHON,
          executable: runtime.profile.executable,
        });
        expect(session.status).toBe("ready");

        const writeId = ComputeExecutionId.make("phase-4-write");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: writeId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "answer = 41",
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, writeId)).result?.status,
        ).toBe("succeeded");
        expect(
          yield* gateway.inspectVariables({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: session.generation,
          }),
        ).toMatchObject({
          generation: session.generation,
          variables: expect.arrayContaining([
            expect.objectContaining({ name: "answer", typeName: "int", preview: "41" }),
          ]),
        });

        const readId = ComputeExecutionId.make("phase-4-read");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: readId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "print(answer + 1)",
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, readId)).result?.status,
        ).toBe("succeeded");
        const output = yield* gateway.listOutputs({
          cwd: projectRoot,
          sessionId,
          executionId: readId,
        });
        expect(
          output.outputs.some(
            (item) =>
              item._tag === "stream" && item.stream === "stdout" && item.text.includes("42"),
          ),
        ).toBe(true);

        const diagnosticCode = "value = 1\nraise ValueError('project failure')\n";
        const diagnosticFile = yield* workspaceFileSystem.writeFile({
          cwd: projectRoot,
          relativePath: "diagnostic_test.py",
          contents: diagnosticCode,
        });
        const diagnosticId = ComputeExecutionId.make("phase-4-project-diagnostic");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: diagnosticId,
          expectedGeneration: session.generation,
          code: diagnosticCode,
          source: {
            _tag: "document",
            origin: "file",
            path: diagnosticFile.relativePath,
            bufferState: "saved",
            revision: diagnosticFile.revision,
            range: null,
          },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, diagnosticId)).result?.status,
        ).toBe("failed");
        const diagnosticOutput = yield* gateway.listOutputs({
          cwd: projectRoot,
          sessionId,
          executionId: diagnosticId,
        });
        expect(
          diagnosticOutput.outputs.flatMap((item) =>
            item._tag === "diagnostic" ? item.diagnostic.frames : [],
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ relativePath: "diagnostic_test.py", line: 2 }),
          ]),
        );

        const failedId = ComputeExecutionId.make("phase-4-failed-state");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: failedId,
          expectedGeneration: session.generation,
          code: [
            "repr_called = False",
            "class Hostile:",
            "    def __repr__(self):",
            "        global repr_called",
            "        repr_called = True",
            "        raise RuntimeError('must not run')",
            "hostile = Hostile()",
            "retained_after_failure = 7",
            "raise ValueError('expected failure')",
          ].join("\n"),
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, failedId)).result?.status,
        ).toBe("failed");
        const variablesAfterFailure = yield* gateway.inspectVariables({
          cwd: projectRoot,
          sessionId,
          expectedGeneration: session.generation,
        });
        expect(variablesAfterFailure.variables).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "repr_called", preview: "False" }),
            expect.objectContaining({ name: "retained_after_failure", preview: "7" }),
            expect.objectContaining({ name: "hostile", preview: null }),
          ]),
        );

        const figureId = ComputeExecutionId.make("phase-4-svg-figure");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: figureId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: [
            "class InlineSvg:",
            "    def _repr_svg_(self):",
            '        return \'<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>\'',
            "display(InlineSvg())",
          ].join("\n"),
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, figureId)).result?.status,
        ).toBe("succeeded");
        const figureOutput = yield* gateway.listOutputs({
          cwd: projectRoot,
          sessionId,
          executionId: figureId,
        });
        const svg = figureOutput.outputs.find(
          (item) => item._tag === "image" && item.mediaType === "image/svg+xml",
        );
        expect(svg?._tag).toBe("image");
        if (svg?._tag === "image") {
          const resolved = yield* compute.resolveOutputImage({
            projectId: session.projectId,
            sessionId,
            executionId: figureId,
            contentHash: svg.contentHash,
          });
          if (resolved === null) return yield* Effect.die("SVG output was not durable.");
          expect(resolved).toMatchObject({
            mediaType: "image/svg+xml",
            contentHash: svg.contentHash,
          });
          expect(resolved.fileName.endsWith(".svg")).toBe(true);
          expect(new TextDecoder().decode(yield* fs.readFile(resolved.path))).toContain("<svg");
        }

        const followedRuntimeHashes: Array<ReadonlyArray<string>> = [];
        for (const revision of ["first", "second"] as const) {
          const code = [
            "class FollowedSvg:",
            "    def __init__(self, label): self.label = label",
            "    def _repr_svg_(self):",
            "        return f'<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{self.label}</text></svg>'",
            `display(FollowedSvg('${revision}-one'))`,
            `display(FollowedSvg('${revision}-two'))`,
          ].join("\n");
          const file = yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            relativePath: "followed_figures.py",
            contents: code,
          });
          const executionId = ComputeExecutionId.make(`phase-4-follow-${revision}`);
          yield* gateway.submitExecution({
            cwd: projectRoot,
            sessionId,
            executionId,
            expectedGeneration: session.generation,
            code,
            source: {
              _tag: "document",
              origin: "file",
              path: file.relativePath,
              bufferState: "saved",
              revision: file.revision,
              range: null,
            },
          });
          expect(
            (yield* waitForTerminal(gateway, projectRoot, sessionId, executionId)).result?.status,
          ).toBe("succeeded");
          const outputs = yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId,
          });
          const runtimeImages = outputs.outputs.flatMap((item) =>
            item._tag === "image" && item.origin?._tag === "runtime-display" ? [item] : [],
          );
          expect(runtimeImages).toHaveLength(2);
          followedRuntimeHashes.push(runtimeImages.map((item) => item.contentHash));
        }
        expect(followedRuntimeHashes[1]?.[0]).not.toBe(followedRuntimeHashes[0]?.[0]);
        expect(followedRuntimeHashes[1]?.[1]).not.toBe(followedRuntimeHashes[0]?.[1]);

        const generatedFiguresId = ComputeExecutionId.make("phase-4-generated-figures");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: generatedFiguresId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: [
            "import base64",
            "from pathlib import Path",
            "template = '<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{}</text></svg>'",
            "for name in ('decay', 'scatter', 'distribution'):",
            "    Path(f'figure_{name}.svg').write_text(template.format(name), encoding='utf-8')",
            "pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3V8AAAAASUVORK5CYII='",
            "Path('figure_pixel.png').write_bytes(base64.b64decode(pixel))",
            "print('Created three SVG figures and one PNG figure')",
          ].join("\n"),
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, generatedFiguresId)).result
            ?.status,
        ).toBe("succeeded");
        const generatedFigureOutput = yield* gateway.listOutputs({
          cwd: projectRoot,
          sessionId,
          executionId: generatedFiguresId,
        });
        const generatedImages = generatedFigureOutput.outputs.filter(
          (item) => item._tag === "image",
        );
        expect(generatedImages).toHaveLength(4);
        expect(generatedImages.filter((item) => item.mediaType === "image/svg+xml")).toHaveLength(
          3,
        );
        expect(generatedImages.filter((item) => item.mediaType === "image/png")).toHaveLength(1);
        expect(
          (yield* gateway.listExecutions({ cwd: projectRoot, sessionId, limit: 100 })).find(
            (execution) => execution.request.executionId === generatedFiguresId,
          )?.result?.imageCount,
        ).toBe(4);
        expect(
          generatedImages
            .flatMap((item) => (item.origin?._tag === "project-file" ? [item.origin.path] : []))
            .toSorted(),
        ).toEqual([
          "figure_decay.svg",
          "figure_distribution.svg",
          "figure_pixel.png",
          "figure_scatter.svg",
        ]);
        expect(
          generatedImages.every(
            (item) =>
              item.origin?._tag === "project-file" && item.origin.revision === item.contentHash,
          ),
        ).toBe(true);
        for (const generatedImage of generatedImages) {
          const resolved = yield* compute.resolveOutputImage({
            projectId: session.projectId,
            sessionId,
            executionId: generatedFiguresId,
            contentHash: generatedImage.contentHash,
          });
          if (resolved === null) return yield* Effect.die("Generated figure was not durable.");
          expect(yield* fs.exists(resolved.path)).toBe(true);
        }
        const retainedDecay = generatedImages.find(
          (item) => item.origin?._tag === "project-file" && item.origin.path === "figure_decay.svg",
        );
        if (retainedDecay === undefined) return yield* Effect.die("Decay figure was not retained.");
        yield* fs.writeFileString(
          `${projectRoot}/figure_decay.svg`,
          "<svg><text>changed</text></svg>",
        );
        const retainedDecayBytes = yield* compute.resolveOutputImage({
          projectId: session.projectId,
          sessionId,
          executionId: generatedFiguresId,
          contentHash: retainedDecay.contentHash,
        });
        if (retainedDecayBytes === null) {
          return yield* Effect.die("Historical decay figure was not durable.");
        }
        expect(new TextDecoder().decode(yield* fs.readFile(retainedDecayBytes.path))).toContain(
          "decay",
        );

        const fileId = ComputeExecutionId.make("phase-4-project-file");
        yield* gateway.submitExecution({
          cwd: projectRoot,
          sessionId,
          executionId: fileId,
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "from pathlib import Path\nPath('generated-by-compute.txt').write_text('ordinary project file')",
          source: { _tag: "console" },
        });
        expect(
          (yield* waitForTerminal(gateway, projectRoot, sessionId, fileId)).result?.status,
        ).toBe("succeeded");
        expect(yield* fs.readFileString(`${projectRoot}/generated-by-compute.txt`)).toBe(
          "ordinary project file",
        );

        const restarted = yield* gateway.restartSession({
          cwd: projectRoot,
          sessionId,
          expectedGeneration: session.generation,
        });
        const variablesAfterRestart = yield* gateway.inspectVariables({
          cwd: projectRoot,
          sessionId,
          expectedGeneration: restarted.generation,
        });
        expect(variablesAfterRestart.variables).toEqual([]);

        const stopped = yield* gateway.stopSession({
          cwd: projectRoot,
          sessionId,
          expectedGeneration: restarted.generation,
        });
        expect(stopped.status).toBe("stopped");

        const next = yield* gateway.startSession({
          cwd: projectRoot,
          sessionId: ComputeSessionId.make("phase-4-session-2"),
          languageId: PYTHON,
          executable: runtime.profile.executable,
        });
        expect(yield* gateway.listSessions({ cwd: projectRoot })).toHaveLength(2);
        yield* gateway.stopSession({
          cwd: projectRoot,
          sessionId: next.sessionId,
          expectedGeneration: next.generation,
        });
      }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.timeout("90 seconds")),
  );
});
