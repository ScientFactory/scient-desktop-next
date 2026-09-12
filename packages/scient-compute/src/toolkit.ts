import * as Schema from "effect/Schema";

import { ComputeLanguageId, ComputeRuntimeProfile } from "./contract.ts";
import { Label, ShortText, Slug } from "./primitives.ts";

/** Stable product identity for a reviewed scientific-computing Toolkit. */
export const ComputeToolkitId = Slug.pipe(Schema.brand("ComputeToolkitId"));
export type ComputeToolkitId = typeof ComputeToolkitId.Type;

/**
 * A package requirement used to assess an existing runtime.
 *
 * Exact packages selected for a Scient-managed environment belong to its
 * separately reviewed lock. This requirement is intentionally only the
 * minimum compatibility contract used during discovery.
 */
export const ComputeToolkitPackageRequirement = Schema.Struct({
  name: Slug,
  displayName: Label,
  minimumVersion: Schema.NullOr(Label),
});
export type ComputeToolkitPackageRequirement = typeof ComputeToolkitPackageRequirement.Type;

/**
 * User-facing capability metadata. It describes what a Toolkit enables, not
 * how a Python, R, Julia, or vendor-specific installer happens to provide it.
 */
export const ComputeToolkitDescriptor = Schema.Struct({
  toolkitId: ComputeToolkitId,
  languageId: ComputeLanguageId,
  displayName: Label,
  summary: ShortText,
  packageRequirements: Schema.Array(ComputeToolkitPackageRequirement).check(Schema.isMaxLength(64)),
});
export type ComputeToolkitDescriptor = typeof ComputeToolkitDescriptor.Type;

export const ComputeToolkitReadiness = Schema.Literals([
  "ready",
  "missing-requirement",
  "runtime-unavailable",
]);
export type ComputeToolkitReadiness = typeof ComputeToolkitReadiness.Type;

/** Toolkit readiness for one exact runtime candidate. */
export const ComputeToolkitAssessment = Schema.Struct({
  toolkitId: ComputeToolkitId,
  runtime: ComputeRuntimeProfile,
  readiness: ComputeToolkitReadiness,
  missingRequirements: Schema.Array(Label).check(Schema.isMaxLength(64)),
});
export type ComputeToolkitAssessment = typeof ComputeToolkitAssessment.Type;
