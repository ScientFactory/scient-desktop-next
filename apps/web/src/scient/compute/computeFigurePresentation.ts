import type { ComputeExecutionId, ComputeOutput, ComputeSessionRecord } from "@t3tools/contracts";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

type ComputeImageOutput = Extract<ComputeOutput, { readonly _tag: "image" }>;

/**
 * Builds a durable viewer descriptor from compute-owned image metadata.
 * Signed URLs stay inside the existing asset viewer and are never persisted.
 */
export function computeFigureSurface(input: {
  readonly session: ComputeSessionRecord;
  readonly executionId: ComputeExecutionId | null;
  readonly output: ComputeImageOutput;
  readonly ordinal: number;
  readonly sourcePath: string | null;
}): PreviewStaticImageSurfaceDescriptor {
  const extension = input.output.mediaType === "image/png" ? "png" : "svg";
  const projectPath =
    input.output.origin?._tag === "project-file" ? input.output.origin.path : null;
  const fileName = projectPath?.split("/").at(-1) ?? `figure-${input.ordinal}.${extension}`;
  const label = projectPath === null ? `Figure ${input.ordinal}` : fileName;
  return {
    surfaceId: [
      "compute",
      input.session.projectId,
      input.session.sessionId,
      input.executionId ?? "session",
      input.output.contentHash,
    ].join(":"),
    label,
    fileName,
    mediaType: input.output.mediaType,
    sourcePath: projectPath ?? input.sourcePath ?? `${input.session.label} / ${fileName}`,
    resource: {
      _tag: "compute-output",
      projectId: input.session.projectId,
      sessionId: input.session.sessionId,
      executionId: input.executionId,
      contentHash: input.output.contentHash,
    },
  };
}
