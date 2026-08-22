// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited viewer seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient file surface seams", () => {
  it("keeps additive Scient behavior mounted without leaking runtime logic into the viewer", () => {
    const source = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ScientFileAuxiliarySurface");
    expect(source.match(/<ScientFileAuxiliarySurface/gu)).toHaveLength(1);
    expect(source).toContain("ScientPythonComputeSurface");
    expect(source.match(/<ScientPythonComputeSurface/gu)).toHaveLength(1);
    expect(source.match(/useWorkspaceFileRefresh\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/matlab|-batch|AnalysisRunFilePanel/iu);
  });

  it("keeps Python execution controls in the Scient-owned file surface", () => {
    const surface = NodeFS.readFileSync(
      new URL("../compute/ScientPythonComputeSurface.tsx", import.meta.url),
      "utf8",
    );
    const results = NodeFS.readFileSync(
      new URL("../compute/ComputePanel.tsx", import.meta.url),
      "utf8",
    );
    const output = NodeFS.readFileSync(
      new URL("../compute/ComputeOutputView.tsx", import.meta.url),
      "utf8",
    );
    const artifactActions = NodeFS.readFileSync(
      new URL("../artifacts/staticArtifactViewerActions.ts", import.meta.url),
      "utf8",
    );
    const artifactMenus = NodeFS.readFileSync(
      new URL("../artifacts/StaticArtifactMenus.tsx", import.meta.url),
      "utf8",
    );

    expect(surface).toContain("PythonFileComputeActions");
    expect(surface).toContain("PYTHON_COMPUTE_VIEWS");
    expect(surface).toContain("ComputePanel");
    expect(results).not.toMatch(/<Textarea|Run code in this session/gu);
    expect(results).not.toMatch(/Code that ran|request\.code|revision\.slice/gu);
    expect(results).toContain("mergeComputeOutputs");
    expect(results).toContain("Interrupt running code and keep session state");
    expect(results).toContain("Restart session");
    expect(results).toContain("Stop session");
    expect(results).not.toContain("<Pause");
    expect(results).toContain('aria-label="Compute session history"');
    expect(results).toContain("MenuRadioGroup");
    expect(output).toContain("useAssetUrlState");
    expect(output).toContain("<img");
    expect(output).toContain("StaticArtifactPresentationMenu");
    expect(output).toContain("StaticArtifactPresentationActionMenu");
    expect(output).toContain("StaticImageCopyButton");
    expect(output).toContain("StaticImageDownloadButton");
    expect(artifactMenus).toContain("openStaticArtifactInPanel");
    expect(artifactMenus).toContain("toggleStaticArtifactFloating");
    expect(artifactActions).toContain("openScientArtifact");
  });
});
