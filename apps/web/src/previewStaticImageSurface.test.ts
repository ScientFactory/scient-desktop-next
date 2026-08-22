import { describe, expect, it } from "vite-plus/test";

import {
  isPreviewStaticImageSurfaceDescriptor,
  previewStaticImageContentKey,
  previewStaticImageDescriptorKey,
  previewStaticImageReloadKey,
  previewStaticImageRevisionKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "./previewStaticImageSurface";

type Resource = PreviewStaticImageSurfaceDescriptor["resource"];

const keyFor = (resource: Resource): string =>
  previewStaticImageRevisionKey({
    surfaceId: "surface",
    label: "Label",
    fileName: "image.png",
    mediaType: "image/png",
    sourcePath: "source",
    resource,
  });

const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

const computeOutput = (
  overrides: {
    readonly sessionId?: string;
    readonly executionId?: string | null;
    readonly contentHash?: string;
  } = {},
): Resource =>
  ({
    _tag: "compute-output",
    projectId: "project-a",
    sessionId: overrides.sessionId ?? "session-a",
    executionId: overrides.executionId === undefined ? "execution-a" : overrides.executionId,
    contentHash: overrides.contentHash ?? hashA,
  }) as Resource;

describe("previewStaticImageRevisionKey", () => {
  // The key decides whether the renderer treats an image as the one it already
  // has. A compute output is addressed by the hash of its bytes, so re-reading
  // the transcript it came from has to land on the same key, and anything that
  // is a different image has to land on a different one.
  it("gives a compute output the identity of its bytes", () => {
    expect(keyFor(computeOutput())).toBe(keyFor(computeOutput()));
    expect(keyFor(computeOutput({ sessionId: "session-b" }))).not.toBe(keyFor(computeOutput()));
    expect(keyFor(computeOutput({ executionId: "execution-b" }))).not.toBe(keyFor(computeOutput()));
    // A figure a session drew outside any execution is not the same figure as
    // one drawn inside execution-a, even at the same hash.
    expect(keyFor(computeOutput({ executionId: null }))).not.toBe(keyFor(computeOutput()));
    expect(keyFor(computeOutput({ contentHash: hashB }))).not.toBe(keyFor(computeOutput()));
  });

  // Every kind of asset shares one key space, so a new variant that forgot to
  // name itself would quietly show one resource's image in another's place.
  it("never gives two kinds of resource the same key", () => {
    const resources = [
      { _tag: "workspace-file", cwd: "/project", relativePath: "figure.png" },
      { _tag: "workspace-file", threadId: "thread-a", path: "figure.png" },
      { _tag: "attachment", attachmentId: "attachment-a" },
      { _tag: "project-favicon", cwd: "/project" },
      { _tag: "project-favicon", cwd: "/project", path: "icon.png" },
      {
        _tag: "generated-document",
        authority: "thread",
        artifactId: "artifact-a",
        revisionId: "revision-a",
      },
      {
        _tag: "analysis-artifact",
        projectId: "project-a",
        runId: "run-a",
        artifactId: "figure-001",
        representationId: "static-png",
      },
      { _tag: "environment-file", path: "/project/figure.png", access: "exact" },
    ].map((resource) => resource as Resource);
    const keys = [...resources, computeOutput()].map(keyFor);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("separates byte identity, reload requests, and compact viewer status", () => {
    const base: PreviewStaticImageSurfaceDescriptor = {
      surfaceId: "logical-figure",
      label: "Figure 1",
      fileName: "figure.png",
      mediaType: "image/png",
      sourcePath: "figure.png",
      resource: { _tag: "workspace-file", cwd: "/project", relativePath: "figure.png" },
      contentKey: hashA,
      reloadKey: "run-1",
    };
    const next = { ...base, reloadKey: "run-2", statusLabel: "Previous figure" };
    expect(previewStaticImageContentKey(next)).toBe(hashA);
    expect(previewStaticImageReloadKey(next)).toBe("run-2");
    expect(previewStaticImageDescriptorKey(next)).not.toBe(previewStaticImageDescriptorKey(base));
    expect(isPreviewStaticImageSurfaceDescriptor(next)).toBe(true);
    expect(isPreviewStaticImageSurfaceDescriptor({ ...next, statusLabel: "" })).toBe(false);
  });
});
