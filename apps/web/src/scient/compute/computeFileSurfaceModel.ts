import type { ComputeSessionRecord, ComputeLanguageRuntimeInspection } from "@t3tools/contracts";

/** Discovery order is the server's preference, not a list to skip until something runs. */
export function defaultComputeRuntime(languages: ReadonlyArray<ComputeLanguageRuntimeInspection>) {
  const language = languages.find((candidate) => candidate.enabled);
  const candidate = language?.runtimes[0];
  return candidate?.verification.readiness === "ready" ? candidate : null;
}

import {
  clampScientSplitFraction,
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
  type ScientSplitAxis,
} from "~/scient/layout/scientSplitFraction";

// Keep the existing key for compatibility. It now remembers only the layout to
// reveal after Run; opening a source file itself always starts in Code.
export const COMPUTE_FILE_RESULTS_VIEW_STORAGE_KEY = "scient.pythonComputeView";
export const COMPUTE_FILE_SPLIT_STORAGE_KEY = "scient.pythonComputeSplitRatio";
export const COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY = "scient.pythonComputeSplitLayout";

export const COMPUTE_FILE_VIEWS = ["code", "split", "results"] as const;
export type ComputeFileView = (typeof COMPUTE_FILE_VIEWS)[number];
export type ComputeFileResultsView = Exclude<ComputeFileView, "code">;

const COMPUTE_FILE_SPLIT_LAYOUTS = ["side-by-side", "stacked"] as const;
export type ComputeFileSplitLayout = (typeof COMPUTE_FILE_SPLIT_LAYOUTS)[number];

export const COMPUTE_FILE_VIEW_LABELS: Readonly<Record<ComputeFileView, string>> = {
  code: "Code",
  split: "Split",
  results: "Results",
};

export const DEFAULT_COMPUTE_FILE_RESULTS_VIEW: ComputeFileResultsView = "results";
export const DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT: ComputeFileSplitLayout = "side-by-side";
export const DEFAULT_COMPUTE_FILE_SPLIT = 0.5;
export const MIN_COMPUTE_FILE_SPLIT = 0.3;
export const COMPUTE_FILE_SPLIT_KEYBOARD_STEP = 0.02;

type ComputeRuntimeToolbarSession = Pick<
  ComputeSessionRecord,
  "activity" | "label" | "languageId" | "runtime" | "status"
>;

export type ComputeRuntimeToolbarState =
  | {
      readonly kind: "setup";
      readonly label: string;
      readonly canRun: false;
    }
  | {
      readonly kind: "status";
      readonly label: string;
      readonly canRun: boolean;
      readonly note?: string;
    }
  | {
      readonly kind: "switch";
      readonly label: string;
      readonly canRun: true;
    };

export function computeRuntimeSetupActionLabel(languageId: string, languageName: string): string {
  return languageId === "matlab" ? `Connect ${languageName}` : `Set up ${languageName}`;
}

/** One-line file-header failure. The full text belongs behind copy / details. */
export function computeRuntimeFailureHeadline(languageId: string, failure: string): string {
  const trimmed = failure.trim();
  if (trimmed.length === 0)
    return languageId === "matlab" ? "Connection setup failed" : "Setup failed";
  if (languageId === "matlab") return "Connection setup failed";
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "Setup failed";
  if (
    firstLine.length <= 40 &&
    !firstLine.includes("/") &&
    !/ENOENT|uv\.lock|pyproject/iu.test(firstLine)
  ) {
    return firstLine;
  }
  return "Python setup failed";
}

const SCIENTIFIC_PACKAGES_NOTE = "Figures libraries are not in this environment";

export function isComputeCapacityReachedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "capacity-reached"
  );
}

const COMPUTE_FILE_SPLIT_BOUNDS = {
  minimum: MIN_COMPUTE_FILE_SPLIT,
  fallback: DEFAULT_COMPUTE_FILE_SPLIT,
} as const;

export function normalizeComputeFileResultsView(
  value: string | null | undefined,
): ComputeFileResultsView {
  return value === "split" ? "split" : DEFAULT_COMPUTE_FILE_RESULTS_VIEW;
}

export function computeFileViewAfterRun(
  current: ComputeFileView,
  preferredResultsView: ComputeFileResultsView,
): ComputeFileView {
  return current === "code" ? preferredResultsView : current;
}

export function normalizeComputeFileSplitLayout(
  value: string | null | undefined,
): ComputeFileSplitLayout {
  if (value === "horizontal") return "side-by-side";
  if (value === "vertical") return "stacked";
  return (
    COMPUTE_FILE_SPLIT_LAYOUTS.find((candidate) => candidate === value) ??
    DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT
  );
}

export function clampComputeFileSplit(value: number): number {
  return clampScientSplitFraction(value, COMPUTE_FILE_SPLIT_BOUNDS);
}

export function normalizeComputeFileSplit(value: number | null | undefined): number {
  return value === null || value === undefined
    ? DEFAULT_COMPUTE_FILE_SPLIT
    : clampComputeFileSplit(value);
}

export function computeFileSplitFromPointer(input: {
  readonly pointerX: number;
  readonly left: number;
  readonly width: number;
}): number {
  return scientSplitFractionFromPointer(input, COMPUTE_FILE_SPLIT_BOUNDS);
}

export function nudgeComputeFileSplit(
  current: number,
  key: string,
  axis: ScientSplitAxis = "x",
): number | null {
  return nudgeScientSplitFraction(
    current,
    key,
    COMPUTE_FILE_SPLIT_BOUNDS,
    COMPUTE_FILE_SPLIT_KEYBOARD_STEP,
    axis,
  );
}

function computeRuntimePresenceLabel(
  languageName: string,
  version: string | null | undefined,
): string {
  const trimmed = version?.trim();
  if (trimmed && trimmed !== "unknown") return `${languageName} ${trimmed}`;
  return languageName;
}

export function resolveComputeRuntimeToolbarState(input: {
  readonly languageId?: string;
  readonly languageName?: string;
  readonly runtimeVersion?: string | null;
  readonly liveSession: ComputeRuntimeToolbarSession | null;
  readonly runtimeInspectionPending: boolean;
  readonly readyRuntimeAvailable: boolean;
  readonly preferredRuntimeExecutable: string | null;
  readonly scientificPackagesMissing: boolean;
  readonly capacityRecoveryAvailable?: boolean;
  readonly startingRetryAvailable?: boolean;
  readonly contextLifecycle?:
    | "unbound"
    | "starting"
    | "live"
    | "closing"
    | "close-failed"
    | "terminal";
  /** Helper/setup failure is not ready. Do not pair it with a ready chip. */
  readonly connectionSetupFailed?: boolean;
}): ComputeRuntimeToolbarState {
  const languageId = input.languageId ?? "python";
  const languageName = input.languageName ?? "Python";
  const session = input.liveSession;
  const presenceLabel = computeRuntimePresenceLabel(languageName, input.runtimeVersion);
  if (input.connectionSetupFailed) {
    return {
      kind: "setup",
      label: computeRuntimeSetupActionLabel(languageId, languageName),
      canRun: false,
    };
  }
  if (input.contextLifecycle === "starting") {
    if (input.capacityRecoveryAvailable) {
      return { kind: "status", label: `${languageName} capacity reached`, canRun: true };
    }
    if (input.startingRetryAvailable) {
      return { kind: "status", label: `${languageName} retry start`, canRun: true };
    }
    return { kind: "status", label: `${languageName} starting`, canRun: false };
  }
  if (input.contextLifecycle === "closing") {
    return { kind: "status", label: `${languageName} closing`, canRun: false };
  }
  if (input.contextLifecycle === "close-failed") {
    return { kind: "status", label: `${languageName} close needs retry`, canRun: false };
  }
  if (session !== null) {
    if (session.languageId !== languageId) {
      return { kind: "status", label: `${session.label} active`, canRun: false };
    }
    if (session.status !== "ready") {
      return { kind: "status", label: `${languageName} ${session.status}`, canRun: false };
    }
    if (session.activity === "busy") {
      return { kind: "status", label: `${languageName} running`, canRun: true };
    }
    if (
      !input.runtimeInspectionPending &&
      session.runtime !== null &&
      input.preferredRuntimeExecutable !== null &&
      session.runtime.executable !== input.preferredRuntimeExecutable
    ) {
      return { kind: "switch", label: `Switch ${languageName}`, canRun: true };
    }
    return {
      kind: "status",
      label: `${languageName} ready`,
      canRun: true,
      ...(input.scientificPackagesMissing ? { note: SCIENTIFIC_PACKAGES_NOTE } : {}),
    };
  }
  // Inspect is a package-metadata probe. Do not call that "ready"; Run still
  // starts a real session. "Python ready" is reserved for a live session above.
  if (input.readyRuntimeAvailable) {
    return {
      kind: "status",
      label: presenceLabel,
      canRun: true,
      ...(input.scientificPackagesMissing ? { note: SCIENTIFIC_PACKAGES_NOTE } : {}),
    };
  }
  if (input.runtimeInspectionPending) {
    return { kind: "status", label: `Checking ${languageName}…`, canRun: false };
  }
  return {
    kind: "setup",
    label: computeRuntimeSetupActionLabel(languageId, languageName),
    canRun: false,
  };
}
