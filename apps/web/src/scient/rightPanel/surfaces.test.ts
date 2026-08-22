import { describe, expect, it } from "vite-plus/test";

import {
  normalizeScientRightPanelSurface,
  scientArtifactSurface,
  scientComputeSurface,
  scientEnvironmentFileSurface,
  scientRightPanelSurfaceTitle,
  scientSourcePdfSurface,
  scientSourcesSurface,
} from "./surfaces";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

const artifact: PreviewStaticImageSurfaceDescriptor = {
  surfaceId: "project-a:script.m:figure-001",
  label: "Figure 1",
  fileName: "figure-001.png",
  mediaType: "image/png",
  sourcePath: "script.m",
  resource: {
    _tag: "analysis-artifact",
    projectId: "project-a",
    runId: "run-1",
    artifactId: "figure-001",
    representationId: "static-png",
  } as PreviewStaticImageSurfaceDescriptor["resource"],
};

describe("Scient right-panel surfaces", () => {
  it("builds stable Sources and source-PDF descriptors", () => {
    expect(scientSourcesSurface()).toEqual({
      id: "scient:sources",
      kind: "scient",
      module: "sources",
    });
    expect(
      scientSourcePdfSurface({
        sourceId: "source 1",
        attachmentId: "pdf 1",
        fileName: "Paper.pdf",
      }),
    ).toEqual({
      id: "scient:source-pdf:source%201:pdf%201",
      kind: "scient",
      module: "source-pdf",
      sourceId: "source 1",
      attachmentId: "pdf 1",
      fileName: "Paper.pdf",
    });
  });

  it("keeps one stable Compute surface per project root", () => {
    expect(scientComputeSurface({ cwd: "/research/Study 1" })).toEqual({
      id: "scient:compute:%2Fresearch%2FStudy%201",
      kind: "scient",
      module: "compute",
      cwd: "/research/Study 1",
    });
    expect(
      normalizeScientRightPanelSurface({
        id: "stale-compute-id",
        kind: "scient",
        module: "compute",
        cwd: "/research/Study 1",
      }),
    ).toEqual(scientComputeSurface({ cwd: "/research/Study 1" }));
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:compute:unsafe",
        kind: "scient",
        module: "compute",
        cwd: "/research/Study\0bad",
      }),
    ).toBeNull();
  });

  it("normalizes recognized persisted descriptors and rejects unsafe ones", () => {
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:source-pdf:legacy",
        kind: "scient",
        module: "source-pdf",
        sourceId: "source 1",
        attachmentId: "pdf 1",
        fileName: "Paper.pdf",
      }),
    ).toEqual(
      scientSourcePdfSurface({
        sourceId: "source 1",
        attachmentId: "pdf 1",
        fileName: "Paper.pdf",
      }),
    );
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:unknown",
        kind: "scient",
        module: "unknown",
      }),
    ).toBeNull();
    expect(
      normalizeScientRightPanelSurface({
        id: "stale-id",
        kind: "scient",
        module: "file",
        path: "/tmp/figure.svg",
        line: 0,
      }),
    ).toEqual(scientEnvironmentFileSurface({ path: "/tmp/figure.svg", line: 1 }));
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:file:bad",
        kind: "scient",
        module: "file",
        path: "/tmp/bad\0file",
      }),
    ).toBeNull();
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:artifact:stale-id",
        kind: "scient",
        module: "artifact",
        artifact,
      }),
    ).toEqual(scientArtifactSurface(artifact));
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:source-pdf:missing-file",
        kind: "scient",
        module: "source-pdf",
        attachmentId: "pdf 1",
      }),
    ).toBeNull();
  });

  it("keeps user-visible titles inside the Scient-owned registry", () => {
    expect(scientRightPanelSurfaceTitle(scientSourcesSurface())).toBe("Sources");
    expect(scientRightPanelSurfaceTitle(scientComputeSurface({ cwd: "/project" }))).toBe("Compute");
    expect(
      scientRightPanelSurfaceTitle(
        scientSourcePdfSurface({
          sourceId: "source_1",
          attachmentId: "pdf_1",
          fileName: "Paper.pdf",
        }),
      ),
    ).toBe("Paper.pdf");
    expect(scientRightPanelSurfaceTitle(scientArtifactSurface(artifact))).toBe("Figure 1");
    expect(
      scientRightPanelSurfaceTitle(
        scientEnvironmentFileSurface({ path: "C:\\Research\\figures\\result.svg" }),
      ),
    ).toBe("result.svg");
  });

  it("builds stable direct-file descriptors without embedding authorized URLs", () => {
    const surface = scientEnvironmentFileSurface({ path: "/tmp/results/paper.pdf", line: 42 });
    expect(surface).toEqual({
      id: "scient:file:%2Ftmp%2Fresults%2Fpaper.pdf",
      kind: "scient",
      module: "file",
      path: "/tmp/results/paper.pdf",
      line: 42,
    });
    expect(JSON.stringify(surface)).not.toContain("api/assets");
  });
});
