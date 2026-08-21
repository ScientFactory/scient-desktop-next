import { describe, expect, it } from "vite-plus/test";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  type ComputeOutput,
} from "@t3tools/contracts";

import {
  compareComputeFigureRevisions,
  computeExecutionMayUpdateFigure,
  computeFigureReference,
  computeFigureSurfaceId,
  matchComputeFigureOutput,
  normalizeComputeFigurePath,
  parseComputeFigureSurfaceId,
  type ComputeFigureReference,
} from "./computeFigureReference";

const projectId = ComputeProjectId.make("project-1");
const sessionId = ComputeSessionId.make("session-1");
const executionId = ComputeExecutionId.make("execution-1");
const languageId = ComputeLanguageId.make("python");
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;

function image(
  seed: string,
  origin?:
    | { readonly _tag: "runtime-display" }
    | { readonly _tag: "project-file"; readonly path: string; readonly revision: string },
): Extract<ComputeOutput, { readonly _tag: "image" }> {
  return {
    _tag: "image",
    sequence: 1,
    observedAt: "2026-08-21T00:00:00.000Z",
    mediaType: "image/png",
    contentHash: hash(seed),
    byteLength: 10,
    width: null,
    height: null,
    ...(origin === undefined ? {} : { origin }),
  };
}

const savedFile = {
  _tag: "document",
  origin: "file",
  path: "analysis.py",
  bufferState: "saved",
  revision: null,
  range: null,
} as const;

describe("compute figure references", () => {
  it("round-trips typed references and rejects malformed identities", () => {
    const references: ReadonlyArray<ComputeFigureReference> = [
      { _tag: "snapshot", projectId, sessionId, executionId, contentHash: hash("a") },
      { _tag: "project-file", projectId, path: "results/figure one.svg" },
      { _tag: "runtime-display", projectId, languageId, path: "analysis.py", ordinal: 2 },
    ];
    for (const reference of references) {
      expect(parseComputeFigureSurfaceId(computeFigureSurfaceId(reference))).toEqual(reference);
    }
    expect(parseComputeFigureSurfaceId("compute-figure:v2:project-file:x:y")).toBeNull();
    expect(parseComputeFigureSurfaceId("compute-figure:v1:runtime-display:x:y:z:0")).toBeNull();
    expect(parseComputeFigureSurfaceId("unrelated")).toBeNull();
  });

  it("normalizes portable project-relative paths without accepting escape", () => {
    expect(normalizeComputeFigurePath("results\\plots//figure.svg")).toBe(
      "results/plots/figure.svg",
    );
    expect(normalizeComputeFigurePath("./plots/figure.svg")).toBe("plots/figure.svg");
    expect(normalizeComputeFigurePath("../secret.png")).toBeNull();
    expect(normalizeComputeFigurePath("/absolute.png")).toBeNull();
    expect(normalizeComputeFigurePath("C:\\absolute.png")).toBeNull();
  });

  it("makes historical, dirty, cell, and unprovenanced outputs immutable snapshots", () => {
    const make = (
      allowFollowing: boolean,
      source: Parameters<typeof computeFigureReference>[0]["source"],
    ) =>
      computeFigureReference({
        allowFollowing,
        projectId,
        sessionId,
        executionId,
        languageId,
        output: image("a", { _tag: "runtime-display" }),
        runtimeDisplayOrdinal: 1,
        source,
      });
    expect(make(false, savedFile)._tag).toBe("snapshot");
    expect(make(true, { ...savedFile, bufferState: "dirty" })._tag).toBe("snapshot");
    expect(make(true, { ...savedFile, origin: "cell" })._tag).toBe("snapshot");
    expect(make(true, { _tag: "console" })._tag).toBe("snapshot");
    expect(
      computeFigureReference({
        allowFollowing: true,
        projectId,
        sessionId,
        executionId,
        languageId,
        output: image("a", { _tag: "runtime-display" }),
        runtimeDisplayOrdinal: 0,
        source: savedFile,
      })._tag,
    ).toBe("snapshot");
    expect(make(true, savedFile)).toEqual({
      _tag: "runtime-display",
      projectId,
      languageId,
      path: "analysis.py",
      ordinal: 1,
    });
  });

  it("matches runtime positions without project-file images shifting the ordinal", () => {
    const reference: ComputeFigureReference = {
      _tag: "runtime-display",
      projectId,
      languageId,
      path: "analysis.py",
      ordinal: 2,
    };
    const outputs = [
      image("p", { _tag: "project-file", path: "out.svg", revision: hash("p") }),
      image("a", { _tag: "runtime-display" }),
      image("b", { _tag: "runtime-display" }),
    ];
    expect(matchComputeFigureOutput(reference, outputs)?.contentHash).toBe(hash("b"));
  });

  it("isolates runtime followers by project, language, source path, and saved-file authority", () => {
    const reference: ComputeFigureReference = {
      _tag: "runtime-display",
      projectId,
      languageId,
      path: "analysis.py",
      ordinal: 1,
    };
    const execution = {
      request: {
        executionId,
        sessionId,
        submittedAt: "2026-08-21T00:00:00.000Z",
        source: savedFile,
      },
      result: null,
    } as Parameters<typeof computeExecutionMayUpdateFigure>[3];
    expect(computeExecutionMayUpdateFigure(reference, projectId, languageId, execution)).toBe(true);
    expect(
      computeExecutionMayUpdateFigure(
        reference,
        ComputeProjectId.make("other-project"),
        languageId,
        execution,
      ),
    ).toBe(false);
    expect(
      computeExecutionMayUpdateFigure(
        reference,
        projectId,
        ComputeLanguageId.make("julia"),
        execution,
      ),
    ).toBe(false);
    expect(
      computeExecutionMayUpdateFigure(reference, projectId, languageId, {
        ...execution,
        request: { ...execution.request, source: { ...savedFile, path: "other.py" } },
      }),
    ).toBe(false);
    expect(
      computeExecutionMayUpdateFigure(reference, projectId, languageId, {
        ...execution,
        request: {
          ...execution.request,
          source: { ...savedFile, bufferState: "dirty" },
        },
      }),
    ).toBe(false);
  });

  it("orders revisions across session lifetimes before asynchronous application", () => {
    const base = {
      sessionCreatedAt: "2026-08-21T00:00:00.000Z",
      sessionId,
      submittedAt: "2026-08-21T00:01:00.000Z",
      executionId,
    };
    expect(
      compareComputeFigureRevisions({ ...base, submittedAt: "2026-08-21T00:02:00.000Z" }, base),
    ).toBeGreaterThan(0);
    expect(
      compareComputeFigureRevisions(
        {
          ...base,
          sessionCreatedAt: "2026-08-21T01:00:00.000Z",
          sessionId: ComputeSessionId.make("session-2"),
        },
        base,
      ),
    ).toBeGreaterThan(0);
  });
});
