import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionGeneration,
  ComputeSessionId,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computeFigurePresentation } from "./computeFigurePresentation";
import { reconcileComputeFigureTarget } from "./computeFigureFollowerModel";
import {
  computeFigureSurfaceId,
  matchComputeFigureOutput,
  parseComputeFigureSurfaceId,
} from "./computeFigureReference";
import {
  COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
  MAX_COMPUTE_NATIVE_FIGURE_BYTES,
  computeProjectedStaticImage,
  projectComputeFigureOutputs,
} from "./computeResultPresentation";

const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}` as const;
const session = {
  projectId: ComputeProjectId.make("project"),
  sessionId: ComputeSessionId.make("session"),
  languageId: ComputeLanguageId.make("matlab"),
  label: "MATLAB",
  generation: INITIAL_COMPUTE_SESSION_GENERATION,
  createdAt: "2026-09-10T00:00:00Z",
} as ComputeSessionRecord;
const source = {
  _tag: "document",
  origin: "file",
  path: "figures.m",
  bufferState: "saved",
  revision: null,
  range: null,
} as const;
const execution = {
  request: {
    executionId: ComputeExecutionId.make("changed-second"),
    sessionId: session.sessionId,
    generation: session.generation,
    submittedAt: "2026-09-10T00:01:00Z",
    source,
  },
  result: { status: "succeeded" },
} as ComputeExecutionRecord;

function display(
  id: string,
  seed: string,
  update = false,
  nativeBytes: number | null = 4,
): ComputeOutput {
  return {
    _tag: update ? "display-update" : "display-data",
    sequence: 1,
    observedAt: "2026-09-10T00:00:00Z",
    displayId: id,
    bundle: {
      metadataJson: null,
      representations: [
        {
          mediaType: "image/png",
          data: { _tag: "resource", contentHash: hash(seed), byteLength: 3 },
        },
        ...(nativeBytes === null
          ? []
          : [
              {
                mediaType: COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
                data: {
                  _tag: "resource" as const,
                  contentHash: hash("f"),
                  byteLength: nativeBytes,
                },
              },
            ]),
      ],
    },
  };
}

function present(output: ComputeOutput, ordinal: number, allowFollowing = true) {
  const projected = projectComputeFigureOutputs([output])[0];
  if (projected?._tag !== "representation") throw new Error("Expected a retained display");
  const image = computeProjectedStaticImage(projected);
  if (image === null) throw new Error("Expected a retained image");
  return computeFigurePresentation({
    allowFollowing,
    cwd: "/synthetic",
    session,
    executionId: ComputeExecutionId.make("initial"),
    output: image,
    displayOrdinal: ordinal,
    runtimeDisplayOrdinal: ordinal,
    source,
  });
}

describe("native figure identity and retained alternatives", () => {
  it("uses the producing generation when opening an old result after restart", () => {
    const projected = projectComputeFigureOutputs([display("matlab-figure:1", "a")])[0];
    if (projected?._tag !== "representation") throw new Error("Expected a representation");
    const output = computeProjectedStaticImage(projected);
    if (output === null) throw new Error("Expected an image");
    const presentation = computeFigurePresentation({
      allowFollowing: true,
      cwd: "/synthetic",
      output,
      session: { ...session, generation: ComputeSessionGeneration.make(2) },
      executionId: execution.request.executionId,
      executionGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
      displayOrdinal: 1,
      runtimeDisplayOrdinal: 1,
      source,
    });
    expect(presentation.reference).toMatchObject({ generation: 1, displayId: "matlab-figure:1" });
  });
  it("keeps two figures distinct when only the second changes", () => {
    const first = present(display("matlab-figure:1", "a"), 1);
    const second = present(display("matlab-figure:2", "b"), 2);
    const updates = [display("matlab-figure:2", "c", true)];
    expect(first.viewer.surfaceId).not.toBe(second.viewer.surfaceId);
    expect(present(updates[0]!, 1).viewer.surfaceId).toBe(second.viewer.surfaceId);
    expect(parseComputeFigureSurfaceId(second.viewer.surfaceId)).toEqual(second.reference);
    expect(second.reference).toMatchObject({
      displayId: "matlab-figure:2",
      generation: 1,
      sessionId: session.sessionId,
    });
    const decisions = [first, second].map((presentation) =>
      reconcileComputeFigureTarget({
        appliedRevision: null,
        artifact: presentation.viewer,
        cwd: "/synthetic",
        reference: presentation.reference,
        candidate: { session, execution, outputs: updates },
      }),
    );
    expect(decisions[0]).toMatchObject({
      _tag: "apply",
      descriptor: { resource: first.viewer.resource, statusLabel: "Previous figure" },
    });
    expect(decisions[1]).toMatchObject({
      _tag: "apply",
      descriptor: {
        surfaceId: second.viewer.surfaceId,
        label: "Figure 2",
        contentKey: hash("c"),
        resource: { executionId: execution.request.executionId, contentHash: hash("c") },
      },
    });
    expect(first.inline.contentKey).toBe(hash("a"));
    expect(second.inline.contentKey).toBe(hash("b"));
  });

  it("never rebinds a closed or missing native ID to the remaining figure", () => {
    const first = present(display("matlab-figure:1", "a"), 1);
    const second = present(display("matlab-figure:2", "b"), 2);
    const closed: ComputeOutput = {
      _tag: "display-update",
      sequence: 3,
      observedAt: "2026-09-10T00:02:00Z",
      displayId: "matlab-figure:1",
      bundle: {
        metadataJson: '{"closed":true}',
        representations: [
          { mediaType: "text/plain", data: { _tag: "text", text: "MATLAB figure closed." } },
        ],
      },
    };
    for (const outputs of [
      [closed, display("matlab-figure:2", "d", true)],
      [
        display("matlab-figure:1", "a"),
        display("matlab-figure:2", "b"),
        closed,
        display("matlab-figure:2", "d", true),
      ],
    ]) {
      expect(matchComputeFigureOutput(first.reference, outputs)).toBeNull();
      expect(matchComputeFigureOutput(second.reference, outputs)?.contentHash).toBe(hash("d"));
      expect(
        reconcileComputeFigureTarget({
          appliedRevision: null,
          artifact: first.viewer,
          cwd: "/synthetic",
          reference: first.reference,
          candidate: { session, execution, outputs },
        }),
      ).toMatchObject({
        _tag: "apply",
        descriptor: { resource: first.viewer.resource, statusLabel: "Previous figure" },
      });
    }
    expect(matchComputeFigureOutput(second.reference, [closed])).toBeNull();
  });

  it("does not reuse native IDs from a restart or another session", () => {
    const figure = present(display("matlab-figure:1", "a"), 1);
    for (const request of [
      { ...execution.request, generation: ComputeSessionGeneration.make(2) },
      { ...execution.request, sessionId: ComputeSessionId.make("new-lifetime") },
    ]) {
      expect(
        reconcileComputeFigureTarget({
          appliedRevision: null,
          artifact: figure.viewer,
          cwd: "/synthetic",
          reference: figure.reference,
          candidate: {
            session,
            execution: { ...execution, request },
            outputs: [display("matlab-figure:1", "e")],
          },
        }),
      ).toEqual({ _tag: "unchanged" });
    }
    if (figure.reference._tag !== "runtime-display" || figure.reference.displayId === undefined)
      throw new Error("Expected native identity");
    expect(
      computeFigureSurfaceId({ ...figure.reference, generation: ComputeSessionGeneration.make(2) }),
    ).not.toBe(figure.viewer.surfaceId);
    expect(present(display("matlab-figure:1", "a"), 1, false).reference._tag).toBe("snapshot");
  });

  it("retains the native FIG as a separate exact download next to the PNG", () => {
    const figure = present(display("matlab-figure:2", "b"), 2);
    expect(figure.inline.resource).toMatchObject({ contentHash: hash("b") });
    expect(figure.nativeDownload).toEqual({
      resource: { ...figure.inline.resource, contentHash: hash("f") },
      fileName: "figure-2.fig",
      byteLength: 4,
    });
    for (const nativeBytes of [null, 0, MAX_COMPUTE_NATIVE_FIGURE_BYTES + 1]) {
      const pngOnly = present(display("matlab-figure:2", "b", false, nativeBytes), 2);
      expect(pngOnly.nativeDownload).toBeNull();
      expect(pngOnly.inline.contentKey).toBe(hash("b"));
    }
  });
});
