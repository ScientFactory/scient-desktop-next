import { describe, expect, it } from "vite-plus/test";

import {
  normalizeScientRightPanelSurface,
  scientArtifactSurface,
  scientComputeSurface,
  scientEnvironmentFileSurface,
  scientGeneratedPdfSurface,
  scientRightPanelSurfaceTitle,
  scientSourcePdfSurface,
  scientSourcesSurface,
} from "./surfaces";
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import type { ComputeContextId } from "~/scient/compute/computeContextStore";
import { MAX_COMPUTE_CONTEXT_ID_LENGTH } from "~/scient/compute/computeContextStore";

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
  const generatedPdf = PdfSourceDescriptor.make({
    _tag: "generated-pdf",
    authority: ArtifactAuthority.make("environment-1"),
    logicalDocumentKey: LogicalDocumentKey.make("browser-export:fixture"),
    title: "Fixture export",
    fileName: "Fixture export.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: ArtifactId.make("artifact-1"),
    revisionId: ArtifactRevisionId.make("revision-1"),
    bindingGeneration: BindingGeneration.make(1),
    bindingStatus: "current",
    staleReason: null,
    pageCount: 1,
  });
  if (generatedPdf._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");

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

  it("distinguishes an owning Compute tab from the project overview", () => {
    const contextId = "owner-1" as ComputeContextId;
    const owner = scientComputeSurface({ cwd: "/project", contextId });
    expect(owner).toEqual({
      id: "scient:compute:%2Fproject:owner-1",
      kind: "scient",
      module: "compute",
      cwd: "/project",
      contextId,
    });
    expect(normalizeScientRightPanelSurface(owner)).toEqual(owner);
    expect(scientComputeSurface({ cwd: "/project" }).id).not.toBe(owner.id);
  });

  it("does not discard a valid long persisted owning context id", () => {
    const contextId = `context-${"x".repeat(2_048)}` as unknown as ComputeContextId;
    const surface = scientComputeSurface({ cwd: "/project", contextId });

    expect(contextId.length).toBeLessThanOrEqual(MAX_COMPUTE_CONTEXT_ID_LENGTH);
    expect(normalizeScientRightPanelSurface(surface)).toEqual(surface);
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
        module: "generated-pdf",
        source: generatedPdf,
      }),
    ).toMatchObject({ module: "generated-pdf", source: generatedPdf });
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

  it("keeps generated PDF tabs stable while immutable revisions advance", () => {
    const nextRevision = PdfSourceDescriptor.make({
      ...generatedPdf,
      revisionId: ArtifactRevisionId.make("revision-2"),
      bindingGeneration: BindingGeneration.make(2),
      pageCount: 2,
    });
    if (nextRevision._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");

    expect(scientGeneratedPdfSurface(nextRevision).id).toBe(
      scientGeneratedPdfSurface(generatedPdf).id,
    );
    expect(scientGeneratedPdfSurface(nextRevision).source.revisionId).toBe("revision-2");
  });

  it("keeps user-visible titles inside the Scient-owned registry", () => {
    expect(scientRightPanelSurfaceTitle(scientSourcesSurface())).toBe("Sources");
    expect(scientRightPanelSurfaceTitle(scientComputeSurface({ cwd: "/project" }))).toBe(
      "Compute history",
    );
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
      scientRightPanelSurfaceTitle({
        id: "scient:generated-pdf:environment-1:artifact-1:revision-1",
        kind: "scient",
        module: "generated-pdf",
        source: generatedPdf,
      }),
    ).toBe("Fixture export");
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
