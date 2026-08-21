// @effect-diagnostics nodeBuiltinImport:off -- static audit for inherited UI seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string): string =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("Scient split seams", () => {
  it("keeps inherited UI independent while aligning separator chrome", () => {
    const separator = readSource("./ResizeSeparator.tsx");
    const rightPanelHandle = readSource("../../components/preview/RightPanelResizeHandle.tsx");

    expect(separator).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toContain("ResizeSeparator");
    for (const visualToken of [
      "w-2 cursor-col-resize",
      "inset-y-0 left-1/2 w-px -translate-x-1/2",
      "group-hover:bg-border",
      "group-active:bg-primary/60",
    ]) {
      expect(separator).toContain(visualToken);
      expect(rightPanelHandle).toContain(visualToken);
    }
  });

  it("keeps the LaTeX split on the shared Scient-owned behavior", () => {
    const surface = readSource("../latex/ScientLatexSurface.tsx");

    expect(surface).toContain("useScientSplit");
    expect(surface).toContain("ResizeSeparator");
    expect(surface).toContain("LATEX_SPLIT_RATIO_STORAGE_KEY");
    expect(surface).not.toContain("RightPanelResizeHandle");
    expect(surface).not.toContain("scient-latex-divider");
  });

  it("shares fractional behavior between Python and LaTeX without sharing their storage", () => {
    const python = readSource("../compute/ScientPythonComputeSurface.tsx");
    const latex = readSource("../latex/ScientLatexSurface.tsx");

    expect(python).toContain("useScientSplit");
    expect(latex).toContain("useScientSplit");
    expect(python).toContain("PYTHON_COMPUTE_SPLIT_STORAGE_KEY");
    expect(latex).toContain("LATEX_SPLIT_RATIO_STORAGE_KEY");
    expect(python).not.toContain("RightPanelResizeHandle");
    expect(latex).not.toContain("scient-latex-divider");
  });

  it("wires the Python stacked layout through the shared split behavior", () => {
    const python = readSource("../compute/ScientPythonComputeSurface.tsx");

    expect(python).toContain('splitLayout === "stacked" ? "y" : "x"');
    expect(python).toContain('isStacked ? "flex-col" : "flex-row"');
    expect(python).toContain('orientation={isStacked ? "horizontal" : "vertical"}');
    expect(python).toContain('isStacked ? "border-t border-border" : "border-l border-border"');
    expect(python).toContain('isStacked ? "inset-x-0 -top-1" : "inset-y-0 -left-1"');
    expect(python).toContain("PYTHON_COMPUTE_SPLIT_LAYOUT_STORAGE_KEY");
  });

  it("keeps the Python and LaTeX view controls on the same outer radius", () => {
    const python = readSource("../compute/ScientPythonComputeSurface.tsx");
    const latexStyles = readSource("../latex/scient-latex.css");

    expect(python).toContain("gap-px rounded-[6px] border");
    expect(latexStyles).toMatch(/\.scient-latex-modes\s*\{[^}]*border-radius:\s*6px;/su);
  });
});
