import type {
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeSessionRecord,
} from "@t3tools/contracts";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import {
  compareComputeFigureRevisions,
  computeExecutionMayUpdateFigure,
  computeFigureRevisionKey,
  matchComputeFigureOutput,
  type ComputeFigureReference,
  type ComputeFigureRevision,
} from "./computeFigureReference";
import { computeFigureDescriptorForRevision } from "./computeFigurePresentation";

export interface ComputeFigureFollowCandidate {
  readonly session: ComputeSessionRecord;
  readonly execution: ComputeExecutionRecord;
  readonly outputs: ReadonlyArray<ComputeOutput> | null;
}

export type ComputeFigureFollowDecision =
  | { readonly _tag: "unchanged" }
  | {
      readonly _tag: "apply";
      readonly descriptor: PreviewStaticImageSurfaceDescriptor;
      readonly revision: ComputeFigureRevision;
    };

export function computeFigureRevision(
  session: ComputeSessionRecord,
  execution: ComputeExecutionRecord,
): ComputeFigureRevision {
  return {
    sessionCreatedAt: session.createdAt,
    sessionId: session.sessionId,
    submittedAt: execution.request.submittedAt,
    executionId: execution.request.executionId,
  };
}

export function latestSuccessfulFigureExecution(
  reference: ComputeFigureReference,
  session: ComputeSessionRecord,
  executions: ReadonlyArray<ComputeExecutionRecord>,
): ComputeExecutionRecord | null {
  if (reference._tag === "snapshot") return null;
  return (
    executions
      .filter(
        (execution) =>
          execution.result?.status === "succeeded" &&
          computeExecutionMayUpdateFigure(
            reference,
            session.projectId,
            session.languageId,
            execution,
          ),
      )
      .toSorted(
        (left, right) =>
          right.request.submittedAt.localeCompare(left.request.submittedAt) ||
          right.request.executionId.localeCompare(left.request.executionId),
      )[0] ?? null
  );
}

/**
 * Pure monotonic reconciliation for one open figure surface. Failed runs keep
 * the last good revision. A successful saved-file run without a matching
 * runtime display marks that revision as previous instead of hiding it.
 */
export function reconcileComputeFigureTarget(input: {
  readonly appliedRevision: ComputeFigureRevision | null;
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly cwd: string;
  readonly reference: ComputeFigureReference;
  readonly candidate: ComputeFigureFollowCandidate;
}): ComputeFigureFollowDecision {
  if (input.reference._tag === "snapshot") return { _tag: "unchanged" };
  const { session, execution, outputs } = input.candidate;
  if (
    execution.result?.status !== "succeeded" ||
    !computeExecutionMayUpdateFigure(
      input.reference,
      session.projectId,
      session.languageId,
      execution,
    )
  ) {
    return { _tag: "unchanged" };
  }
  const revision = computeFigureRevision(session, execution);
  if (
    input.appliedRevision !== null &&
    compareComputeFigureRevisions(revision, input.appliedRevision) <= 0
  ) {
    return { _tag: "unchanged" };
  }

  if (input.reference._tag === "project-file") {
    const match = outputs === null ? null : matchComputeFigureOutput(input.reference, outputs);
    const { statusLabel: _statusLabel, ...artifactWithoutStatus } = input.artifact;
    const descriptor =
      match === null
        ? {
            ...artifactWithoutStatus,
            resource: {
              _tag: "workspace-file" as const,
              cwd: input.cwd,
              relativePath: input.reference.path,
            },
            reloadKey: computeFigureRevisionKey(revision),
          }
        : computeFigureDescriptorForRevision({
            cwd: input.cwd,
            reference: input.reference,
            session,
            executionId: execution.request.executionId,
            output: match,
          });
    return { _tag: "apply", descriptor, revision };
  }

  if (outputs === null) return { _tag: "unchanged" };
  const match = matchComputeFigureOutput(input.reference, outputs);
  const descriptor =
    match === null
      ? { ...input.artifact, statusLabel: "Previous figure" }
      : computeFigureDescriptorForRevision({
          cwd: input.cwd,
          reference: input.reference,
          session,
          executionId: execution.request.executionId,
          output: match,
        });
  return { _tag: "apply", descriptor, revision };
}
