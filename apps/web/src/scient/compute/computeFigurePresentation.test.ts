import { describe, expect, it } from "vite-plus/test";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeOutput,
  type ComputeSessionRecord,
} from "@t3tools/contracts";

import { computeFigureSurface } from "./computeFigurePresentation";

describe("compute figure presentation", () => {
  it("keeps durable identity in the surface and leaves authorization to the viewer", () => {
    const session: ComputeSessionRecord = {
      sessionId: ComputeSessionId.make("session-1"),
      projectId: ComputeProjectId.make("project-1"),
      label: "Python",
      languageId: ComputeLanguageId.make("python"),
      transportKind: ComputeTransportKind.make("jupyter-bridge"),
      workingDirectory: "/project",
      runtime: null,
      identity: null,
      environmentFingerprint: null,
      generation: INITIAL_COMPUTE_SESSION_GENERATION,
      status: "ready",
      activity: "idle",
      activeExecutionId: null,
      pendingCount: 0,
      storage: {
        status: "retained",
        outputBytes: 0,
        imageBytes: 12,
        totalBytes: 12,
        removedAt: null,
      },
      createdAt: "2026-08-20T12:00:00.000Z",
      lastActivityAt: "2026-08-20T12:00:00.000Z",
      closedAt: null,
      lostReason: null,
    };
    const output: Extract<ComputeOutput, { _tag: "image" }> = {
      _tag: "image",
      sequence: 1,
      observedAt: "2026-08-20T12:00:01.000Z",
      mediaType: "image/png",
      contentHash: `sha256:${"a".repeat(64)}` as Extract<
        ComputeOutput,
        { _tag: "image" }
      >["contentHash"],
      byteLength: 12,
      width: 4,
      height: 3,
    };
    const surface = computeFigureSurface({
      session,
      executionId: ComputeExecutionId.make("execution-1"),
      output,
      ordinal: 1,
      sourcePath: "analysis.py",
    });

    expect(surface.resource).toEqual({
      _tag: "compute-output",
      projectId: session.projectId,
      sessionId: session.sessionId,
      executionId: "execution-1",
      contentHash: output.contentHash,
    });
    expect(JSON.stringify(surface)).not.toContain("api/assets");
    expect(JSON.stringify(surface)).not.toContain("token");
    expect(surface.sourcePath).toBe("analysis.py");
    expect(surface.fileName).toBe("figure-1.png");
  });

  it("uses an SVG file identity for SVG output", () => {
    const session = {
      sessionId: ComputeSessionId.make("session-1"),
      projectId: ComputeProjectId.make("project-1"),
      label: "Python",
    } as ComputeSessionRecord;
    const output = {
      _tag: "image",
      sequence: 1,
      observedAt: "2026-08-20T12:00:01.000Z",
      mediaType: "image/svg+xml",
      contentHash: `sha256:${"b".repeat(64)}`,
      byteLength: 12,
      width: null,
      height: null,
    } as Extract<ComputeOutput, { _tag: "image" }>;

    const surface = computeFigureSurface({
      session,
      executionId: ComputeExecutionId.make("execution-1"),
      output,
      ordinal: 2,
      sourcePath: "figure.py",
    });

    expect(surface.fileName).toBe("figure-2.svg");
    expect(surface.mediaType).toBe("image/svg+xml");
  });

  it("uses generated project-file provenance as the figure identity", () => {
    const session = {
      sessionId: ComputeSessionId.make("session-1"),
      projectId: ComputeProjectId.make("project-1"),
      label: "Python",
    } as ComputeSessionRecord;
    const output = {
      _tag: "image",
      sequence: 3,
      observedAt: "2026-08-20T12:00:01.000Z",
      mediaType: "image/svg+xml",
      contentHash: `sha256:${"c".repeat(64)}`,
      byteLength: 12,
      width: null,
      height: null,
      origin: {
        _tag: "project-file",
        path: "results/figure-decay.svg",
        revision: `sha256:${"c".repeat(64)}`,
      },
    } as Extract<ComputeOutput, { _tag: "image" }>;

    const surface = computeFigureSurface({
      session,
      executionId: ComputeExecutionId.make("execution-1"),
      output,
      ordinal: 1,
      sourcePath: "analysis.py",
    });

    expect(surface.label).toBe("figure-decay.svg");
    expect(surface.fileName).toBe("figure-decay.svg");
    expect(surface.sourcePath).toBe("results/figure-decay.svg");
  });
});
