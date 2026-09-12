import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { AnalysisRunFilePanel } from "~/scient/analysis/AnalysisRunFilePanel";
import { useMatlabOneShotSurface } from "~/scient/compute/matlabOneShotSurface";

interface ScientFileAuxiliarySurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly sourceRevision: string | null;
  readonly sourcePending: boolean;
  readonly truncated: boolean;
}

/**
 * Stable Scient-owned extension point beneath the inherited source viewer.
 * Format-specific surfaces belong here so upstream viewer updates stay isolated.
 */
export function ScientFileAuxiliarySurface(props: ScientFileAuxiliarySurfaceProps) {
  const oneShotVisible = useMatlabOneShotSurface(props.relativePath);
  if (
    props.relativePath === null ||
    props.sourceRevision === null ||
    props.truncated ||
    !props.relativePath.toLowerCase().endsWith(".m") ||
    !oneShotVisible
  ) {
    return null;
  }

  return (
    <details open className="shrink-0 border-t border-border/70">
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
        Fresh-process MATLAB runs
      </summary>
      <AnalysisRunFilePanel
        key={`${props.environmentId}:${props.cwd}:${props.relativePath}`}
        environmentId={props.environmentId}
        threadRef={props.threadRef}
        cwd={props.cwd}
        relativePath={props.relativePath}
        sourceRevision={props.sourceRevision}
        sourcePending={props.sourcePending}
        runtimeKind="matlab"
        runtimeLabel="MATLAB"
      />
    </details>
  );
}
