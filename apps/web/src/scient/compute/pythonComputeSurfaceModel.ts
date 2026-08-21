import type { ComputeSessionRecord } from "@t3tools/contracts";

import {
  clampScientSplitFraction,
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
} from "~/scient/layout/scientSplitFraction";

export const PYTHON_COMPUTE_VIEW_STORAGE_KEY = "scient.pythonComputeView";
export const PYTHON_COMPUTE_SPLIT_STORAGE_KEY = "scient.pythonComputeSplitRatio";

export const PYTHON_COMPUTE_VIEWS = ["code", "split", "results"] as const;
export type PythonComputeView = (typeof PYTHON_COMPUTE_VIEWS)[number];

export const PYTHON_COMPUTE_VIEW_LABELS: Readonly<Record<PythonComputeView, string>> = {
  code: "Code",
  split: "Split",
  results: "Results",
};

export const DEFAULT_PYTHON_COMPUTE_VIEW: PythonComputeView = "code";
export const DEFAULT_PYTHON_COMPUTE_SPLIT = 0.5;
export const MIN_PYTHON_COMPUTE_SPLIT = 0.2;
export const PYTHON_COMPUTE_SPLIT_KEYBOARD_STEP = 0.02;

type PythonRuntimeToolbarSession = Pick<
  ComputeSessionRecord,
  "activity" | "label" | "languageId" | "status"
>;

export type PythonRuntimeToolbarState =
  | {
      readonly kind: "setup";
      readonly label: "Set up Python";
      readonly canRun: false;
    }
  | {
      readonly kind: "status";
      readonly label: string;
      readonly canRun: boolean;
    };

const PYTHON_COMPUTE_SPLIT_BOUNDS = {
  minimum: MIN_PYTHON_COMPUTE_SPLIT,
  fallback: DEFAULT_PYTHON_COMPUTE_SPLIT,
} as const;

export function normalizePythonComputeView(value: string | null | undefined): PythonComputeView {
  return (
    PYTHON_COMPUTE_VIEWS.find((candidate) => candidate === value) ?? DEFAULT_PYTHON_COMPUTE_VIEW
  );
}

export function clampPythonComputeSplit(value: number): number {
  return clampScientSplitFraction(value, PYTHON_COMPUTE_SPLIT_BOUNDS);
}

export function normalizePythonComputeSplit(value: number | null | undefined): number {
  return value === null || value === undefined
    ? DEFAULT_PYTHON_COMPUTE_SPLIT
    : clampPythonComputeSplit(value);
}

export function pythonComputeSplitFromPointer(input: {
  readonly pointerX: number;
  readonly left: number;
  readonly width: number;
}): number {
  return scientSplitFractionFromPointer(input, PYTHON_COMPUTE_SPLIT_BOUNDS);
}

export function nudgePythonComputeSplit(current: number, key: string): number | null {
  return nudgeScientSplitFraction(
    current,
    key,
    PYTHON_COMPUTE_SPLIT_BOUNDS,
    PYTHON_COMPUTE_SPLIT_KEYBOARD_STEP,
  );
}

export function resolvePythonRuntimeToolbarState(input: {
  readonly liveSession: PythonRuntimeToolbarSession | null;
  readonly runtimeInspectionPending: boolean;
  readonly readyPythonAvailable: boolean;
}): PythonRuntimeToolbarState {
  const session = input.liveSession;
  if (session !== null) {
    if (session.languageId !== "python") {
      return { kind: "status", label: `${session.label} active`, canRun: false };
    }
    if (session.status !== "ready") {
      return { kind: "status", label: `Python ${session.status}`, canRun: false };
    }
    return {
      kind: "status",
      label: session.activity === "busy" ? "Python running" : "Python ready",
      canRun: true,
    };
  }
  if (input.readyPythonAvailable) {
    return { kind: "status", label: "Python ready", canRun: true };
  }
  if (input.runtimeInspectionPending) {
    return { kind: "status", label: "Checking Python…", canRun: false };
  }
  return { kind: "setup", label: "Set up Python", canRun: false };
}
