import {
  isPreviewStaticImageSurfaceDescriptor,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";

export type ScientRightPanelSurface =
  | { readonly id: "scient:sources"; readonly kind: "scient"; readonly module: "sources" }
  | {
      readonly id: `scient:compute:${string}`;
      readonly kind: "scient";
      readonly module: "compute";
      readonly cwd: string;
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
}): Extract<ScientRightPanelSurface, { module: "compute" }> {
  return {
    id: `scient:compute:${encodeURIComponent(input.cwd)}`,
    kind: "scient",
    module: "compute",
    cwd: input.cwd,
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
    return scientComputeSurface({ cwd: surface.cwd });
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
      return "Compute";
    case "source-pdf":
      return surface.fileName;
    case "artifact":
      return surface.artifact.label;
    case "file": {
      const normalized = surface.path.replaceAll("\\", "/");
      return normalized.slice(normalized.lastIndexOf("/") + 1) || surface.path;
    }
  }
}
