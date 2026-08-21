import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeLanguageId,
  ComputeOutput,
  ComputeProjectId,
  ComputeSessionId,
} from "@t3tools/contracts";

type ComputeImageOutput = Extract<ComputeOutput, { readonly _tag: "image" }>;
type ComputeContentHash = ComputeImageOutput["contentHash"];
type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

/**
 * Stable identity of one figure presentation.
 *
 * Snapshots name immutable retained bytes. Followable references name a
 * logical project file or a runtime display position, independent of one
 * language adapter's transport and one session lifetime.
 */
export type ComputeFigureReference =
  | {
      readonly _tag: "snapshot";
      readonly projectId: ComputeProjectId;
      readonly sessionId: ComputeSessionId;
      readonly executionId: ComputeExecutionId | null;
      readonly contentHash: ComputeContentHash;
    }
  | {
      readonly _tag: "project-file";
      readonly projectId: ComputeProjectId;
      readonly path: string;
    }
  | {
      readonly _tag: "runtime-display";
      readonly projectId: ComputeProjectId;
      readonly languageId: ComputeLanguageId;
      readonly path: string;
      readonly ordinal: number;
    };

export interface ComputeFigureRevision {
  readonly sessionCreatedAt: string;
  readonly sessionId: ComputeSessionId;
  readonly submittedAt: string;
  readonly executionId: ComputeExecutionId;
}

const SURFACE_PREFIX = "compute-figure:v1";

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function decodePart(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function normalizeComputeFigurePath(path: string): string | null {
  const normalizedSeparators = path.trim().replaceAll("\\", "/");
  if (
    normalizedSeparators.length === 0 ||
    normalizedSeparators.includes("\0") ||
    normalizedSeparators.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedSeparators)
  ) {
    return null;
  }
  const segments = normalizedSeparators.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "..")) return null;
  const canonical = segments.filter((segment) => segment !== ".").join("/");
  return canonical.length > 0 ? canonical : null;
}

export function computeFigureSurfaceId(reference: ComputeFigureReference): string {
  switch (reference._tag) {
    case "snapshot":
      return [
        SURFACE_PREFIX,
        "snapshot",
        encodePart(reference.projectId),
        encodePart(reference.sessionId),
        reference.executionId === null ? "-" : encodePart(reference.executionId),
        encodePart(reference.contentHash),
      ].join(":");
    case "project-file":
      return [
        SURFACE_PREFIX,
        "project-file",
        encodePart(reference.projectId),
        encodePart(reference.path),
      ].join(":");
    case "runtime-display":
      return [
        SURFACE_PREFIX,
        "runtime-display",
        encodePart(reference.projectId),
        encodePart(reference.languageId),
        encodePart(reference.path),
        String(reference.ordinal),
      ].join(":");
  }
}

export function parseComputeFigureSurfaceId(surfaceId: string): ComputeFigureReference | null {
  const parts = surfaceId.split(":");
  if (parts[0] !== "compute-figure" || parts[1] !== "v1") return null;
  switch (parts[2]) {
    case "snapshot": {
      if (parts.length !== 7) return null;
      const projectId = decodePart(parts[3]);
      const sessionId = decodePart(parts[4]);
      const executionId = parts[5] === "-" ? null : decodePart(parts[5]);
      const contentHash = decodePart(parts[6]);
      if (
        !projectId ||
        !sessionId ||
        contentHash === null ||
        (executionId === null && parts[5] !== "-")
      ) {
        return null;
      }
      return {
        _tag: "snapshot",
        projectId: projectId as ComputeProjectId,
        sessionId: sessionId as ComputeSessionId,
        executionId: executionId as ComputeExecutionId | null,
        contentHash: contentHash as ComputeContentHash,
      };
    }
    case "project-file": {
      if (parts.length !== 5) return null;
      const projectId = decodePart(parts[3]);
      const path = decodePart(parts[4]);
      const normalizedPath = path === null ? null : normalizeComputeFigurePath(path);
      return !projectId || normalizedPath === null
        ? null
        : { _tag: "project-file", projectId: projectId as ComputeProjectId, path: normalizedPath };
    }
    case "runtime-display": {
      if (parts.length !== 7) return null;
      const projectId = decodePart(parts[3]);
      const languageId = decodePart(parts[4]);
      const path = decodePart(parts[5]);
      const normalizedPath = path === null ? null : normalizeComputeFigurePath(path);
      const ordinal = Number(parts[6]);
      if (
        !projectId ||
        !languageId ||
        normalizedPath === null ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 1
      ) {
        return null;
      }
      return {
        _tag: "runtime-display",
        projectId: projectId as ComputeProjectId,
        languageId: languageId as ComputeLanguageId,
        path: normalizedPath,
        ordinal,
      };
    }
    default:
      return null;
  }
}

export function computeFigureReference(input: {
  readonly allowFollowing: boolean;
  readonly projectId: ComputeProjectId;
  readonly sessionId: ComputeSessionId;
  readonly executionId: ComputeExecutionId | null;
  readonly languageId: ComputeLanguageId;
  readonly output: ComputeImageOutput;
  readonly runtimeDisplayOrdinal: number;
  readonly source: ComputeExecutionSource | null;
}): ComputeFigureReference {
  if (input.allowFollowing && input.output.origin?._tag === "project-file") {
    const path = normalizeComputeFigurePath(input.output.origin.path);
    if (path !== null) return { _tag: "project-file", projectId: input.projectId, path };
  }
  if (
    input.allowFollowing &&
    input.output.origin?._tag === "runtime-display" &&
    input.source?._tag === "document" &&
    input.source.origin === "file" &&
    input.source.bufferState === "saved" &&
    Number.isSafeInteger(input.runtimeDisplayOrdinal) &&
    input.runtimeDisplayOrdinal >= 1
  ) {
    const path = normalizeComputeFigurePath(input.source.path);
    if (path !== null) {
      return {
        _tag: "runtime-display",
        projectId: input.projectId,
        languageId: input.languageId,
        path,
        ordinal: input.runtimeDisplayOrdinal,
      };
    }
  }
  return {
    _tag: "snapshot",
    projectId: input.projectId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    contentHash: input.output.contentHash,
  };
}

export function computeExecutionMayUpdateFigure(
  reference: ComputeFigureReference,
  projectId: ComputeProjectId,
  languageId: ComputeLanguageId,
  execution: ComputeExecutionRecord,
): boolean {
  if (reference._tag === "snapshot" || reference.projectId !== projectId) return false;
  if (reference._tag === "project-file") return true;
  const source = execution.request.source;
  return (
    reference.languageId === languageId &&
    source._tag === "document" &&
    source.origin === "file" &&
    source.bufferState === "saved" &&
    normalizeComputeFigurePath(source.path) === reference.path
  );
}

export function matchComputeFigureOutput(
  reference: ComputeFigureReference,
  outputs: ReadonlyArray<ComputeOutput>,
): ComputeImageOutput | null {
  let runtimeDisplayOrdinal = 0;
  for (const output of outputs) {
    if (output._tag !== "image") continue;
    if (reference._tag === "snapshot") {
      if (output.contentHash === reference.contentHash) return output;
      continue;
    }
    if (reference._tag === "project-file") {
      if (
        output.origin?._tag === "project-file" &&
        normalizeComputeFigurePath(output.origin.path) === reference.path
      ) {
        return output;
      }
      continue;
    }
    if (output.origin?._tag !== "runtime-display") continue;
    runtimeDisplayOrdinal += 1;
    if (runtimeDisplayOrdinal === reference.ordinal) return output;
  }
  return null;
}

export function compareComputeFigureRevisions(
  left: ComputeFigureRevision,
  right: ComputeFigureRevision,
): number {
  return (
    left.sessionCreatedAt.localeCompare(right.sessionCreatedAt) ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.submittedAt.localeCompare(right.submittedAt) ||
    left.executionId.localeCompare(right.executionId)
  );
}

export function computeFigureRevisionKey(revision: ComputeFigureRevision): string {
  return JSON.stringify([
    revision.sessionCreatedAt,
    revision.sessionId,
    revision.submittedAt,
    revision.executionId,
  ]);
}
