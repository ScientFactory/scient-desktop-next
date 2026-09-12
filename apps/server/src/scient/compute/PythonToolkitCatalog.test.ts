import { describe, expect, it } from "vite-plus/test";

import {
  ComputeLanguageId,
  type ComputeRuntimeVerification,
  ComputeToolkitId,
} from "@scientfactory/compute";

import { PYTHON_LANGUAGE_ID } from "./PythonRuntimeAdapter.ts";
import { PYTHON_DATA_AND_FIGURES_TOOLKIT, assessPythonToolkit } from "./PythonToolkitCatalog.ts";

const verification = (
  input: Partial<ComputeRuntimeVerification> = {},
): ComputeRuntimeVerification => ({
  profile: {
    languageId: PYTHON_LANGUAGE_ID,
    source: "project",
    executable: "/project/.venv/bin/python",
    languageVersion: "3.12.4",
    architecture: "arm64",
    displayName: "Python 3.12.4 (project)",
  },
  readiness: "ready",
  missingRequirements: [],
  message: null,
  packages: [
    { name: "ipykernel", version: "6.29.5" },
    { name: "jupyter_client", version: "8.6.3" },
    { name: "matplotlib", version: "3.9.1" },
    { name: "numpy", version: "2.0.1" },
    { name: "pandas", version: "2.2.2" },
    { name: "scipy", version: "1.14.0" },
  ],
  ...input,
});

describe("Python Toolkit catalog", () => {
  it("marks the Toolkit ready only when the exact verified runtime has every package", () => {
    expect(assessPythonToolkit(PYTHON_DATA_AND_FIGURES_TOOLKIT, verification())).toMatchObject({
      toolkitId: "python-data-and-figures",
      readiness: "ready",
      missingRequirements: [],
      runtime: { executable: "/project/.venv/bin/python" },
    });
  });

  it("reports missing scientific packages without confusing them with bridge readiness", () => {
    const result = assessPythonToolkit(
      PYTHON_DATA_AND_FIGURES_TOOLKIT,
      verification({
        packages: verification().packages.map((candidate) =>
          candidate.name === "scipy" ? { ...candidate, version: null } : candidate,
        ),
      }),
    );

    expect(result.readiness).toBe("missing-requirement");
    expect(result.missingRequirements).toEqual(["SciPy"]);
  });

  it("does not call a Toolkit ready when the runtime itself cannot start compute", () => {
    const result = assessPythonToolkit(
      PYTHON_DATA_AND_FIGURES_TOOLKIT,
      verification({
        readiness: "missing-requirement",
        missingRequirements: ["ipykernel"],
        message: "Create or select a ready Python environment.",
      }),
    );

    expect(result.readiness).toBe("runtime-unavailable");
    expect(result.missingRequirements).toEqual(["ipykernel"]);
  });

  it("refuses to assess a Toolkit against a runtime from another language", () => {
    const descriptor = {
      ...PYTHON_DATA_AND_FIGURES_TOOLKIT,
      toolkitId: ComputeToolkitId.make("r-data-and-figures"),
      languageId: ComputeLanguageId.make("r"),
    };
    const result = assessPythonToolkit(descriptor, verification());

    expect(result.readiness).toBe("runtime-unavailable");
    expect(result.missingRequirements).toEqual(["This Toolkit does not belong to Python."]);
  });

  it("applies a minimum version only when a reviewed requirement declares one", () => {
    const descriptor = {
      ...PYTHON_DATA_AND_FIGURES_TOOLKIT,
      packageRequirements: [{ name: "numpy", displayName: "NumPy", minimumVersion: "2.1" }],
    };
    const result = assessPythonToolkit(descriptor, verification());

    expect(result.readiness).toBe("missing-requirement");
    expect(result.missingRequirements).toEqual(["NumPy >= 2.1 (found 2.0.1)"]);
  });
});
