import {
  isPreviewStaticImageSurfaceDescriptor,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";
import {
  PdfSourceDescriptor,
  type PdfSourceDescriptor as PdfSourceDescriptorType,
} from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";
import {
  MAX_COMPUTE_CONTEXT_ID_LENGTH,
  type ComputeContextId,
} from "~/scient/compute/computeContextStore";

type GeneratedPdfSourceDescriptor = Extract<
  PdfSourceDescriptorType,
  { readonly _tag: "generated-pdf" }
>;
const isPdfSourceDescriptor = Schema.is(PdfSourceDescriptor);

export type ScientRightPanelSurface =
  | { readonly id: "scient:sources"; readonly kind: "scient"; readonly module: "sources" }
  | {
      readonly id: `scient:compute:${string}`;
      readonly kind: "scient";
      readonly module: "compute";
      readonly cwd: string;
      /** Absent means the project Compute overview; present means an owning tab. */
      readonly contextId?: ComputeContextId;
    }
  | {
      readonly id: `scient:source-pdf:${string}`;
      readonly kind: "scient";
      readonly module: "source-pdf";
      readonly sourceId: string;
      readonly attachmentId: string;
      readonly fileName: string;
    }
  | {
      readonly id: `scient:artifact:${string}`;
      readonly kind: "scient";
      readonly module: "artifact";
      readonly artifact: PreviewStaticImageSurfaceDescriptor;
    }
  | {
      readonly id: `scient:generated-pdf:${string}`;
      readonly kind: "scient";
      readonly module: "generated-pdf";
      readonly source: GeneratedPdfSourceDescriptor;
    }
  | {
      readonly id: `scient:file:${string}`;
      readonly kind: "scient";
      readonly module: "file";
      readonly path: string;
      readonly line: number | null;
    };

export function scientSourcesSurface(): Extract<ScientRightPanelSurface, { module: "sources" }> {
  return { id: "scient:sources", kind: "scient", module: "sources" };
}

export function scientComputeSurface(input: {
  readonly cwd: string;
  readonly contextId?: ComputeContextId;
}): Extract<ScientRightPanelSurface, { module: "compute" }> {
  const contextSuffix =
    input.contextId === undefined ? "" : `:${encodeURIComponent(input.contextId)}`;
  return {
    id: `scient:compute:${encodeURIComponent(input.cwd)}${contextSuffix}`,
    kind: "scient",
    module: "compute",
    cwd: input.cwd,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
  };
}

export function scientSourcePdfSurface(input: {
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly fileName: string;
}): Extract<ScientRightPanelSurface, { module: "source-pdf" }> {
  return {
    id: `scient:source-pdf:${encodeURIComponent(input.sourceId)}:${encodeURIComponent(input.attachmentId)}`,
    sourceId: input.sourceId,
    kind: "scient",
    module: "source-pdf",
    attachmentId: input.attachmentId,
    fileName: input.fileName,
  };
}

export function scientArtifactSurfaceId(
  artifact: PreviewStaticImageSurfaceDescriptor,
): `scient:artifact:${string}` {
  return `scient:artifact:${artifact.surfaceId}`;
}

export function scientArtifactSurface(
  artifact: PreviewStaticImageSurfaceDescriptor,
): Extract<ScientRightPanelSurface, { module: "artifact" }> {
  return {
    id: scientArtifactSurfaceId(artifact),
    kind: "scient",
    module: "artifact",
    artifact,
  };
}

export function scientGeneratedPdfSurface(
  source: GeneratedPdfSourceDescriptor,
): Extract<ScientRightPanelSurface, { module: "generated-pdf" }> {
  return {
    // Immutable revisions advance within one stable logical artifact tab.
    id: `scient:generated-pdf:${encodeURIComponent(source.authority)}:${encodeURIComponent(source.artifactId)}`,
    kind: "scient",
    module: "generated-pdf",
    source,
  };
}

export function scientEnvironmentFileSurface(input: {
  readonly path: string;
  readonly line?: number | null;
}): Extract<ScientRightPanelSurface, { module: "file" }> {
  return {
    id: `scient:file:${encodeURIComponent(input.path)}`,
    kind: "scient",
    module: "file",
    path: input.path,
    line:
      typeof input.line === "number" && Number.isFinite(input.line)
        ? Math.max(1, Math.trunc(input.line))
        : null,
  };
}

export function normalizeScientRightPanelSurface(value: unknown): ScientRightPanelSurface | null {
  if (typeof value !== "object" || value === null) return null;
  const surface = value as Record<string, unknown>;
  if (surface.kind !== "scient") return null;
  if (surface.id === "scient:sources" && surface.module === "sources") {
    return scientSourcesSurface();
  }
  if (
    surface.module === "compute" &&
    typeof surface.cwd === "string" &&
    surface.cwd.length > 0 &&
    surface.cwd.length <= 4_096 &&
    !surface.cwd.includes("\0")
  ) {
    const contextId = surface.contextId;
    if (
      contextId !== undefined &&
      (typeof contextId !== "string" ||
        contextId.length === 0 ||
        contextId.length > MAX_COMPUTE_CONTEXT_ID_LENGTH ||
        contextId.includes("\0"))
    ) {
      return null;
    }
    return scientComputeSurface({
      cwd: surface.cwd,
      ...(contextId === undefined ? {} : { contextId: contextId as ComputeContextId }),
    });
  }
  if (
    surface.module === "source-pdf" &&
    typeof surface.sourceId === "string" &&
    surface.sourceId.length > 0 &&
    typeof surface.attachmentId === "string" &&
    surface.attachmentId.length > 0 &&
    typeof surface.fileName === "string" &&
    surface.fileName.length > 0
  ) {
    return scientSourcePdfSurface({
      sourceId: surface.sourceId,
      attachmentId: surface.attachmentId,
      fileName: surface.fileName,
    });
  }
  if (surface.module === "artifact" && isPreviewStaticImageSurfaceDescriptor(surface.artifact)) {
    return scientArtifactSurface(surface.artifact);
  }
  if (surface.module === "generated-pdf" && isPdfSourceDescriptor(surface.source)) {
    const source = surface.source as PdfSourceDescriptorType;
    if (source._tag === "generated-pdf") return scientGeneratedPdfSurface(source);
  }
  if (
    surface.module === "file" &&
    typeof surface.path === "string" &&
    surface.path.length > 0 &&
    surface.path.length <= 4_096 &&
    !surface.path.includes("\0")
  ) {
    return scientEnvironmentFileSurface({
      path: surface.path,
      line: typeof surface.line === "number" ? surface.line : null,
    });
  }
  return null;
}

export function scientRightPanelSurfaceTitle(surface: ScientRightPanelSurface): string {
  switch (surface.module) {
    case "sources":
      return "Sources";
    case "compute":
      return surface.contextId === undefined ? "Compute history" : "Compute";
    case "source-pdf":
      return surface.fileName;
    case "artifact":
      return surface.artifact.label;
    case "generated-pdf":
      return surface.source.title;
    case "file": {
      const normalized = surface.path.replaceAll("\\", "/");
      return normalized.slice(normalized.lastIndexOf("/") + 1) || surface.path;
    }
  }
}
