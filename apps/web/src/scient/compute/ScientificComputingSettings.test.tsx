import { type ComputeManagedRuntimeStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { managedRuntimeOperationLabel } from "./ComputeManagedRuntimeControls";

describe("scientific computing installation presentation", () => {
  it("shows bounded truthful lifecycle progress", () => {
    const status = (
      phase: NonNullable<ComputeManagedRuntimeStatus["operation"]>["phase"],
    ): ComputeManagedRuntimeStatus => ({
      installed: false,
      selection: "existing",
      updateAvailable: false,
      runtimeVersion: null,
      toolkitRevision: null,
      operation: {
        operationId: "operation-1",
        action: "install",
        phase,
        startedAt: "2026-08-30T00:00:00.000Z",
        downloadedBytes: phase === "downloading" ? 5 * 1024 * 1024 : null,
        totalBytes: phase === "downloading" ? 20 * 1024 * 1024 : null,
      },
      failureMessage: null,
    });

    expect(managedRuntimeOperationLabel(status("downloading"))).toBe(
      "Downloading the verified installer · 5.0 of 20.0 MB",
    );
    expect(managedRuntimeOperationLabel(status("installing-python"))).toBe(
      "Installing private Python…",
    );
    expect(managedRuntimeOperationLabel(status("installing-packages"))).toContain(
      "locked scientific packages",
    );
    expect(managedRuntimeOperationLabel(status("verifying"))).toContain("Verifying Python");
  });
});
