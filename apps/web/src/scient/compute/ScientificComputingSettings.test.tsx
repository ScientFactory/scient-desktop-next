import { type ComputeManagedRuntimeStatus } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { managedRuntimeOperationLabel } from "./ComputeManagedRuntimeControls";
import { ComputeInstallationRow } from "./ComputeInstallationRow";

describe("scientific computing installation presentation", () => {
  it.each(["Python", "MATLAB"])(
    "shows %s once per row without implying an untested connection works",
    (languageName) => {
      const markup = renderToStaticMarkup(
        <ComputeInstallationRow
          installation={{
            executable: "/system/runtime",
            source: "path",
            version: "1.0",
            problem: null,
          }}
          languageName={languageName}
          selected={false}
          enabled
          disabled={false}
          verificationKey="initial"
          onTest={async () => {
            throw new Error("Mounting must not test a runtime");
          }}
          onUse={() => undefined}
        />,
      );
      expect(markup).toContain("System installation");
      expect(markup).toContain(">Use<");
      expect(markup).toContain(">Test<");
      expect(markup).toContain("Details");
      expect(markup).not.toContain("Test passed");
      expect(markup).not.toContain("<code");
    },
  );

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
