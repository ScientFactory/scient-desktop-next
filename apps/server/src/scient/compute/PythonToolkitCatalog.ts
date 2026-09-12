import {
  ComputeToolkitId,
  type ComputeToolkitAssessment,
  type ComputeToolkitDescriptor,
  type ComputeRuntimeVerification,
} from "@scientfactory/compute";

import { PYTHON_LANGUAGE_ID, meetsPythonMinimumVersion } from "./PythonRuntimeAdapter.ts";

/**
 * The first reviewed user-facing scientific Toolkit candidate.
 *
 * Presence is assessed today, while the exact versions and hashes used for a
 * Scient-managed installation belong to the separate managed-environment lock
 * that must be qualified per supported platform before installation is wired.
 */
export const PYTHON_DATA_AND_FIGURES_TOOLKIT: ComputeToolkitDescriptor = {
  toolkitId: ComputeToolkitId.make("python-data-and-figures"),
  languageId: PYTHON_LANGUAGE_ID,
  displayName: "Data analysis and figures",
  summary: "Work with numerical data, tables, scientific analysis, and figures in Python.",
  packageRequirements: [
    { name: "numpy", displayName: "NumPy", minimumVersion: null },
    { name: "pandas", displayName: "pandas", minimumVersion: null },
    { name: "scipy", displayName: "SciPy", minimumVersion: null },
    { name: "matplotlib", displayName: "Matplotlib", minimumVersion: null },
  ],
};

export const PYTHON_TOOLKIT_CATALOG: ReadonlyArray<ComputeToolkitDescriptor> = [
  PYTHON_DATA_AND_FIGURES_TOOLKIT,
];

/**
 * Assesses a Toolkit against the same exact runtime candidate compute verified.
 * It never combines bridge readiness from one Python with packages found in a
 * different environment.
 */
export function assessPythonToolkit(
  descriptor: ComputeToolkitDescriptor,
  verification: ComputeRuntimeVerification,
): ComputeToolkitAssessment {
  if (descriptor.languageId !== PYTHON_LANGUAGE_ID) {
    return {
      toolkitId: descriptor.toolkitId,
      runtime: verification.profile,
      readiness: "runtime-unavailable",
      missingRequirements: ["This Toolkit does not belong to Python."],
    };
  }

  if (verification.readiness !== "ready") {
    return {
      toolkitId: descriptor.toolkitId,
      runtime: verification.profile,
      readiness: "runtime-unavailable",
      missingRequirements:
        verification.missingRequirements.length > 0
          ? verification.missingRequirements
          : [verification.message ?? "This Python runtime is not usable."],
    };
  }

  const packages = new Map(verification.packages.map(({ name, version }) => [name, version]));
  const missingRequirements = descriptor.packageRequirements.flatMap((requirement) => {
    const installed = packages.get(requirement.name) ?? null;
    if (installed === null) return [requirement.displayName];
    if (
      requirement.minimumVersion !== null &&
      !meetsPythonMinimumVersion(installed, requirement.minimumVersion)
    ) {
      return [`${requirement.displayName} >= ${requirement.minimumVersion} (found ${installed})`];
    }
    return [];
  });

  return {
    toolkitId: descriptor.toolkitId,
    runtime: verification.profile,
    readiness: missingRequirements.length === 0 ? "ready" : "missing-requirement",
    missingRequirements,
  };
}

export function assessPythonToolkits(
  verification: ComputeRuntimeVerification,
): ReadonlyArray<ComputeToolkitAssessment> {
  return PYTHON_TOOLKIT_CATALOG.map((descriptor) => assessPythonToolkit(descriptor, verification));
}
