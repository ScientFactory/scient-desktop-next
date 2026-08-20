import { AssetResource, type AssetResource as AssetResourceType } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type PreviewStaticImageMediaType = "image/png" | "image/svg+xml";

/** Durable identity for a directly rendered image; signed URLs remain ephemeral renderer state. */
export interface PreviewStaticImageSurfaceDescriptor {
  readonly surfaceId: string;
  readonly label: string;
  readonly fileName: string;
  readonly mediaType: PreviewStaticImageMediaType;
  readonly sourcePath: string;
  readonly resource: AssetResourceType;
}

export function previewStaticImageRevisionKey(image: PreviewStaticImageSurfaceDescriptor): string {
  const resource = image.resource;
  switch (resource._tag) {
    case "workspace-file":
      return resource.cwd !== undefined && resource.relativePath !== undefined
        ? JSON.stringify([resource._tag, resource.cwd, resource.relativePath])
        : JSON.stringify([resource._tag, resource.threadId, resource.path]);
    case "attachment":
      return JSON.stringify([resource._tag, resource.attachmentId]);
    case "project-favicon":
      return JSON.stringify([resource._tag, resource.cwd, resource.path ?? null]);
    case "generated-document":
      return JSON.stringify([
        resource._tag,
        resource.authority,
        resource.artifactId,
        resource.revisionId,
      ]);
    case "analysis-artifact":
      return JSON.stringify([
        resource._tag,
        resource.projectId,
        resource.runId,
        resource.artifactId,
        resource.representationId,
      ]);
    // The content hash is the whole identity here: the same hash is the same
    // bytes, so nothing about how the transcript around it is read, trimmed, or
    // re-rendered can move this key. The session and execution ride along to
    // keep the same figure produced in a different one from sharing a key.
    case "compute-output":
      return JSON.stringify([
        resource._tag,
        resource.projectId,
        resource.sessionId,
        resource.executionId,
        resource.contentHash,
      ]);
    case "environment-file":
      return JSON.stringify([resource._tag, resource.path, resource.access]);
  }
}

const isAssetResource = Schema.is(AssetResource);

export function isPreviewStaticImageSurfaceDescriptor(
  value: unknown,
): value is PreviewStaticImageSurfaceDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PreviewStaticImageSurfaceDescriptor>;
  return (
    typeof candidate.surfaceId === "string" &&
    candidate.surfaceId.length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.length > 0 &&
    typeof candidate.fileName === "string" &&
    candidate.fileName.length > 0 &&
    (candidate.mediaType === "image/png" || candidate.mediaType === "image/svg+xml") &&
    typeof candidate.sourcePath === "string" &&
    candidate.sourcePath.length > 0 &&
    isAssetResource(candidate.resource)
  );
}
