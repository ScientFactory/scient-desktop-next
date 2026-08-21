import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeSessionRecord,
} from "@t3tools/contracts";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import {
  computeFigureReference,
  computeFigureSurfaceId,
  type ComputeFigureReference,
} from "./computeFigureReference";

type ComputeImageOutput = Extract<ComputeOutput, { readonly _tag: "image" }>;
type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

export interface ComputeFigurePresentation {
  /** Immutable retained bytes used by the inline result card. */
  readonly inline: PreviewStaticImageSurfaceDescriptor;
  /** Snapshot or stable logical reference used by full and floating viewers. */
  readonly viewer: PreviewStaticImageSurfaceDescriptor;
  readonly reference: ComputeFigureReference;
}

function figureNames(output: ComputeImageOutput, runtimeDisplayOrdinal: number) {
  const extension = output.mediaType === "image/png" ? "png" : "svg";
  const projectPath = output.origin?._tag === "project-file" ? output.origin.path : null;
  const fileName = projectPath?.split("/").at(-1) ?? `figure-${runtimeDisplayOrdinal}.${extension}`;
  return {
    fileName,
    label: projectPath === null ? `Figure ${runtimeDisplayOrdinal}` : fileName,
    sourcePath: projectPath,
  };
}

function computeOutputResource(input: {
  readonly session: Pick<ComputeSessionRecord, "projectId" | "sessionId">;
  readonly executionId: ComputeExecutionId | null;
  readonly output: ComputeImageOutput;
}) {
  return {
    _tag: "compute-output" as const,
    projectId: input.session.projectId,
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    contentHash: input.output.contentHash,
  };
}

export function computeFigureDescriptorForRevision(input: {
  readonly cwd: string;
  readonly reference: ComputeFigureReference;
  readonly session: Pick<ComputeSessionRecord, "projectId" | "sessionId">;
  readonly executionId: ComputeExecutionId | null;
  readonly output: ComputeImageOutput;
}): PreviewStaticImageSurfaceDescriptor {
  const ordinal = input.reference._tag === "runtime-display" ? input.reference.ordinal : 1;
  const names = figureNames(input.output, ordinal);
  const projectPath = input.reference._tag === "project-file" ? input.reference.path : null;
  const sourcePath =
    input.reference._tag === "runtime-display"
      ? input.reference.path
      : (projectPath ?? names.label);
  return {
    surfaceId: computeFigureSurfaceId(input.reference),
    label: names.label,
    fileName: names.fileName,
    mediaType: input.output.mediaType,
    sourcePath,
    contentKey: input.output.contentHash,
    reloadKey:
      input.output.origin?._tag === "project-file"
        ? input.output.origin.revision
        : input.output.contentHash,
    resource:
      projectPath === null
        ? computeOutputResource(input)
        : { _tag: "workspace-file", cwd: input.cwd, relativePath: projectPath },
  };
}

/**
 * Separates immutable result rendering from viewer follow behavior. A retained
 * result never changes under the Results card; only an explicitly opened
 * current figure can resolve through a stable logical reference.
 */
export function computeFigurePresentation(input: {
  readonly allowFollowing: boolean;
  readonly cwd: string;
  readonly session: Pick<ComputeSessionRecord, "projectId" | "sessionId" | "languageId" | "label">;
  readonly executionId: ComputeExecutionId | null;
  readonly output: ComputeImageOutput;
  readonly displayOrdinal: number;
  readonly runtimeDisplayOrdinal: number;
  readonly source: ComputeExecutionSource | null;
}): ComputeFigurePresentation {
  const reference = computeFigureReference({
    allowFollowing: input.allowFollowing,
    projectId: input.session.projectId,
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    languageId: input.session.languageId,
    output: input.output,
    runtimeDisplayOrdinal: input.runtimeDisplayOrdinal,
    source: input.source,
  });
  const names = figureNames(
    input.output,
    input.output.origin?._tag === "runtime-display"
      ? input.runtimeDisplayOrdinal
      : input.displayOrdinal,
  );
  const inline: PreviewStaticImageSurfaceDescriptor = {
    surfaceId: computeFigureSurfaceId({
      _tag: "snapshot",
      projectId: input.session.projectId,
      sessionId: input.session.sessionId,
      executionId: input.executionId,
      contentHash: input.output.contentHash,
    }),
    label: names.label,
    fileName: names.fileName,
    mediaType: input.output.mediaType,
    sourcePath:
      names.sourcePath ??
      (input.source?._tag === "document"
        ? input.source.path
        : `${input.session.label} / ${names.fileName}`),
    contentKey: input.output.contentHash,
    resource: computeOutputResource(input),
  };
  const viewer =
    reference._tag === "snapshot"
      ? inline
      : computeFigureDescriptorForRevision({
          cwd: input.cwd,
          reference,
          session: input.session,
          executionId: input.executionId,
          output: input.output,
        });
  return { inline, viewer, reference };
}
