import { ComputeLanguageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PYTHON_COMPUTE_SPLIT,
  DEFAULT_PYTHON_COMPUTE_SPLIT_LAYOUT,
  MIN_PYTHON_COMPUTE_SPLIT,
  clampPythonComputeSplit,
  normalizePythonComputeSplit,
  normalizePythonComputeSplitLayout,
  normalizePythonComputeView,
  nudgePythonComputeSplit,
  pythonComputeSplitFromPointer,
  resolvePythonRuntimeToolbarState,
} from "./pythonComputeSurfaceModel";

describe("python compute surface model", () => {
  it("normalizes persisted modes and split ratios", () => {
    expect(normalizePythonComputeView("results")).toBe("results");
    expect(normalizePythonComputeView("console")).toBe("code");
    expect(normalizePythonComputeSplit(null)).toBe(DEFAULT_PYTHON_COMPUTE_SPLIT);
    expect(clampPythonComputeSplit(0.01)).toBe(MIN_PYTHON_COMPUTE_SPLIT);
    expect(clampPythonComputeSplit(0.99)).toBe(1 - MIN_PYTHON_COMPUTE_SPLIT);
    expect(normalizePythonComputeSplitLayout("stacked")).toBe("stacked");
    expect(normalizePythonComputeSplitLayout("horizontal")).toBe("side-by-side");
    expect(normalizePythonComputeSplitLayout("vertical")).toBe("stacked");
    expect(normalizePythonComputeSplitLayout("invalid")).toBe(DEFAULT_PYTHON_COMPUTE_SPLIT_LAYOUT);
  });

  it("maps pointer and keyboard movement into accessible divider bounds", () => {
    expect(pythonComputeSplitFromPointer({ pointerX: 500, left: 0, width: 1000 })).toBe(0.5);
    expect(pythonComputeSplitFromPointer({ pointerX: 0, left: 0, width: 0 })).toBe(
      DEFAULT_PYTHON_COMPUTE_SPLIT,
    );
    expect(nudgePythonComputeSplit(0.5, "ArrowLeft")).toBe(0.48);
    expect(nudgePythonComputeSplit(0.5, "ArrowRight")).toBe(0.52);
    expect(nudgePythonComputeSplit(0.5, "ArrowUp")).toBeNull();
    expect(nudgePythonComputeSplit(0.5, "ArrowUp", "y")).toBe(0.48);
    expect(nudgePythonComputeSplit(0.5, "ArrowDown", "y")).toBe(0.52);
    expect(nudgePythonComputeSplit(0.5, "Home")).toBe(MIN_PYTHON_COMPUTE_SPLIT);
    expect(nudgePythonComputeSplit(0.5, "End")).toBe(1 - MIN_PYTHON_COMPUTE_SPLIT);
    expect(nudgePythonComputeSplit(0.5, "Enter")).toBeNull();
  });

  it("keeps runtime readiness in one quiet contextual status", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: true,
        readyPythonAvailable: false,
      }),
    ).toEqual({ kind: "status", label: "Checking Python…", canRun: false });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
      }),
    ).toEqual({ kind: "status", label: "Python ready", canRun: true });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyPythonAvailable: false,
      }),
    ).toEqual({ kind: "setup", label: "Set up Python", canRun: false });
  });

  it("uses the active session as authority for Python run availability", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "busy",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: false,
      }),
    ).toEqual({ kind: "status", label: "Python running", canRun: true });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "R",
          languageId: ComputeLanguageId.make("r"),
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
      }),
    ).toEqual({ kind: "status", label: "R active", canRun: false });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          status: "starting",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
      }),
    ).toEqual({ kind: "status", label: "Python starting", canRun: false });
  });
});
