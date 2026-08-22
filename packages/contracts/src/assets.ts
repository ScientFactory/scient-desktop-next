import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
} from "@scientfactory/document-artifacts";
import { AnalysisArtifactResourceRef } from "@scientfactory/analysis";
import { ComputeOutputResourceRef } from "@scientfactory/compute";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentFilePath } from "./fileOpening.ts";
import { ProjectFaviconPath } from "./orchestration.ts";

const WORKSPACE_ASSET_PATH_MAX_LENGTH = 1_024;
const ENVIRONMENT_ASSET_PATH_MAX_LENGTH = 4_096;
const ASSET_RELATIVE_URL_MAX_LENGTH = 32_768;

const WorkspaceFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKSPACE_ASSET_PATH_MAX_LENGTH),
);

const WorkspaceFileAssetResource = Schema.TaggedStruct("workspace-file", {
  // SCIENT-WORKSPACE-ASSET: cwd + relativePath are the document locator.
  // The legacy thread pair remains optional during client/server version skew.
  cwd: Schema.optional(WorkspaceFilePath),
  relativePath: Schema.optional(WorkspaceFilePath),
  threadId: Schema.optional(ThreadId),
  path: Schema.optional(WorkspaceFilePath),
});

const workspaceFileLocatorFilter = Schema.makeFilter(
  (input: typeof WorkspaceFileAssetResource.Type) => {
    const hasRootedLocator = input.cwd !== undefined || input.relativePath !== undefined;
    const hasLegacyLocator = input.threadId !== undefined || input.path !== undefined;
    if (!hasRootedLocator && !hasLegacyLocator) {
      return "A workspace file requires a rooted or legacy locator.";
    }
    if ((input.cwd === undefined) !== (input.relativePath === undefined)) {
      return "cwd and relativePath must be provided together.";
    }
    if ((input.threadId === undefined) !== (input.path === undefined)) {
      return "threadId and path must be provided together.";
    }
    return true;
  },
  { identifier: "WorkspaceFileAssetResource" },
);

export const AssetResource = Schema.Union([
  WorkspaceFileAssetResource.check(workspaceFileLocatorFilter),
  Schema.TaggedStruct("attachment", {
    attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.TaggedStruct("project-favicon", {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WORKSPACE_ASSET_PATH_MAX_LENGTH)),
    // A cache-key hint only. The server reads the authoritative path from the
    // project projection before it issues the signed URL.
    path: Schema.optional(ProjectFaviconPath),
  }),
  Schema.TaggedStruct("generated-document", {
    authority: ArtifactAuthority,
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
  }),
  Schema.TaggedStruct("analysis-artifact", {
    ...AnalysisArtifactResourceRef.fields,
  }),
  // An image a compute session produced. Addressed by content hash rather than
  // by position in a transcript, so a reference stays valid however the
  // transcript around it is later read, trimmed, or re-rendered.
  Schema.TaggedStruct("compute-output", {
    ...ComputeOutputResourceRef.fields,
  }),
  Schema.TaggedStruct("environment-file", {
    path: EnvironmentFilePath,
    access: Schema.Literals(["exact", "html-document"]),
  }),
]);
export type AssetResource = typeof AssetResource.Type;

export const AssetCreateUrlInput = Schema.Struct({
  resource: AssetResource,
});
export type AssetCreateUrlInput = typeof AssetCreateUrlInput.Type;

export const AssetCreateUrlResult = Schema.Struct({
  // Environment-file claims contain the canonical path in their signed token.
  // The URL can therefore be longer than the path itself after JSON/base64url
  // encoding, especially for non-ASCII Windows paths.
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_RELATIVE_URL_MAX_LENGTH)),
  expiresAt: Schema.Number,
  sourcePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ENVIRONMENT_ASSET_PATH_MAX_LENGTH)),
  ),
});
export type AssetCreateUrlResult = typeof AssetCreateUrlResult.Type;

export class AssetWorkspaceContextNotFoundError extends Schema.TaggedErrorClass<AssetWorkspaceContextNotFoundError>()(
  "AssetWorkspaceContextNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Workspace context was not found.";
  }
}

export class AssetWorkspaceContextResolutionError extends Schema.TaggedErrorClass<AssetWorkspaceContextResolutionError>()(
  "AssetWorkspaceContextResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve workspace context.";
  }
}

export class AssetWorkspaceRootNormalizationError extends Schema.TaggedErrorClass<AssetWorkspaceRootNormalizationError>()(
  "AssetWorkspaceRootNormalizationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to normalize the workspace root.";
  }
}

export class AssetWorkspacePathValidationError extends Schema.TaggedErrorClass<AssetWorkspacePathValidationError>()(
  "AssetWorkspacePathValidationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Workspace file path must be relative to the project root.";
  }
}

export class AssetPreviewTypeValidationError extends Schema.TaggedErrorClass<AssetPreviewTypeValidationError>()(
  "AssetPreviewTypeValidationError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Only browser documents and images can be previewed.";
  }
}

export class AssetWorkspaceAssetInspectionError extends Schema.TaggedErrorClass<AssetWorkspaceAssetInspectionError>()(
  "AssetWorkspaceAssetInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to inspect the workspace asset.";
  }
}

export class AssetWorkspaceAssetNotFoundError extends Schema.TaggedErrorClass<AssetWorkspaceAssetNotFoundError>()(
  "AssetWorkspaceAssetNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Workspace asset was not found.";
  }
}

export class AssetWorkspaceResolutionError extends Schema.TaggedErrorClass<AssetWorkspaceResolutionError>()(
  "AssetWorkspaceResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve workspace.";
  }
}

export class AssetAttachmentNotFoundError extends Schema.TaggedErrorClass<AssetAttachmentNotFoundError>()(
  "AssetAttachmentNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Attachment was not found.";
  }
}

export class AssetProjectFaviconResolutionError extends Schema.TaggedErrorClass<AssetProjectFaviconResolutionError>()(
  "AssetProjectFaviconResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve project favicon.";
  }
}

export class AssetProjectFaviconInspectionError extends Schema.TaggedErrorClass<AssetProjectFaviconInspectionError>()(
  "AssetProjectFaviconInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to inspect the project favicon.";
  }
}

export class AssetProjectFaviconNotFoundError extends Schema.TaggedErrorClass<AssetProjectFaviconNotFoundError>()(
  "AssetProjectFaviconNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Project favicon was not found.";
  }
}

export class AssetGeneratedDocumentNotFoundError extends Schema.TaggedErrorClass<AssetGeneratedDocumentNotFoundError>()(
  "AssetGeneratedDocumentNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Generated document was not found.";
  }
}

export class AssetGeneratedDocumentAuthorityMismatchError extends Schema.TaggedErrorClass<AssetGeneratedDocumentAuthorityMismatchError>()(
  "AssetGeneratedDocumentAuthorityMismatchError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Generated document belongs to another environment.";
  }
}

export class AssetGeneratedDocumentResolutionError extends Schema.TaggedErrorClass<AssetGeneratedDocumentResolutionError>()(
  "AssetGeneratedDocumentResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve generated document.";
  }
}

export class AssetAnalysisArtifactNotFoundError extends Schema.TaggedErrorClass<AssetAnalysisArtifactNotFoundError>()(
  "AssetAnalysisArtifactNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Analysis artifact was not found.";
  }
}

export class AssetAnalysisArtifactResolutionError extends Schema.TaggedErrorClass<AssetAnalysisArtifactResolutionError>()(
  "AssetAnalysisArtifactResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve analysis artifact.";
  }
}

export class AssetComputeOutputNotFoundError extends Schema.TaggedErrorClass<AssetComputeOutputNotFoundError>()(
  "AssetComputeOutputNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Compute output was not found.";
  }
}

export class AssetComputeOutputResolutionError extends Schema.TaggedErrorClass<AssetComputeOutputResolutionError>()(
  "AssetComputeOutputResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve compute output.";
  }
}

export class AssetSigningKeyLoadError extends Schema.TaggedErrorClass<AssetSigningKeyLoadError>()(
  "AssetSigningKeyLoadError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the asset signing key.";
  }
}

export class AssetEnvironmentFilePathValidationError extends Schema.TaggedErrorClass<AssetEnvironmentFilePathValidationError>()(
  "AssetEnvironmentFilePathValidationError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "The environment file path is not valid for this preview.";
  }
}

export class AssetEnvironmentFileInspectionError extends Schema.TaggedErrorClass<AssetEnvironmentFileInspectionError>()(
  "AssetEnvironmentFileInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to inspect the environment file.";
  }
}

export class AssetEnvironmentFileNotFoundError extends Schema.TaggedErrorClass<AssetEnvironmentFileNotFoundError>()(
  "AssetEnvironmentFileNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "The environment file was not found.";
  }
}

export const AssetAccessError = Schema.Union([
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  AssetWorkspaceRootNormalizationError,
  AssetWorkspacePathValidationError,
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceResolutionError,
  AssetAttachmentNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetGeneratedDocumentNotFoundError,
  AssetGeneratedDocumentAuthorityMismatchError,
  AssetGeneratedDocumentResolutionError,
  AssetAnalysisArtifactNotFoundError,
  AssetAnalysisArtifactResolutionError,
  AssetComputeOutputNotFoundError,
  AssetComputeOutputResolutionError,
  AssetEnvironmentFilePathValidationError,
  AssetEnvironmentFileInspectionError,
  AssetEnvironmentFileNotFoundError,
  AssetSigningKeyLoadError,
]);
export type AssetAccessError = typeof AssetAccessError.Type;
