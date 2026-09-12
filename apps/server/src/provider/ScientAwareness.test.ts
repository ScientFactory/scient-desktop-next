import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildScientAwareness,
  SCIENT_AWARENESS_DELIVERY,
  SCIENT_CORE_AWARENESS,
  SCIENT_COMPUTE_AWARENESS,
  SCIENT_DOCUMENT_BUILD_AWARENESS,
  SCIENT_PREVIEW_AWARENESS,
  SCIENT_SKILLS_AWARENESS,
} from "./ScientAwareness.ts";
import { CLAUDE_SCIENT_TOOL_PROJECTION } from "./ScientToolProjection.ts";

const wordCount = (value: string): number => value.trim().split(/\s+/u).length;

describe("Scient awareness", () => {
  it("keeps the always-on identity compact and product-level", () => {
    expect(wordCount(SCIENT_CORE_AWARENESS)).toBeLessThanOrEqual(120);
    expect(SCIENT_CORE_AWARENESS).toContain("project workspace");
    expect(SCIENT_CORE_AWARENESS).toContain("inspect and edit workspace files");
    expect(SCIENT_CORE_AWARENESS).toContain("Scient's Markdown chat");
    expect(SCIENT_CORE_AWARENESS).toContain("Project `.tex` files open");
    expect(SCIENT_CORE_AWARENESS).toContain("editable LaTeX source/PDF workspace");
    expect(SCIENT_CORE_AWARENESS).not.toContain("project-relative Markdown link");
    expect(SCIENT_CORE_AWARENESS).not.toContain("When LaTeX fits");
    expect(SCIENT_CORE_AWARENESS).toContain("diagram declaration before its contents");
    expect(SCIENT_CORE_AWARENESS).toContain("self-contained Plotly figure JSON");
    expect(SCIENT_CORE_AWARENESS).toContain(
      "Use these formats directly, without HTML or JavaScript wrappers",
    );
    expect(SCIENT_CORE_AWARENESS).toContain("Create workspace files");
    expect(SCIENT_CORE_AWARENESS).toContain("standalone deliverable");
    expect(SCIENT_CORE_AWARENESS).not.toContain("sources_");
  });

  it("mentions Scient skills only when exact skill access is granted", () => {
    expect(wordCount(SCIENT_SKILLS_AWARENESS)).toBeLessThanOrEqual(50);
    expect(SCIENT_SKILLS_AWARENESS).toContain("private turn-scoped index");
    expect(SCIENT_SKILLS_AWARENESS).toContain("provide guidance and grant no tools or authority");
    expect(SCIENT_SKILLS_AWARENESS).not.toContain("automatic skill");
    expect(SCIENT_SKILLS_AWARENESS).not.toContain("user-selected");
    expect(buildScientAwareness(new Set(["skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
    expect(buildScientAwareness(new Set(["preview", "skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_PREVIEW_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
  });

  it("adds compact browser awareness only for an actually granted preview capability", () => {
    expect(wordCount(SCIENT_PREVIEW_AWARENESS)).toBeLessThanOrEqual(50);
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["sources:read"]))).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["preview"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_PREVIEW_AWARENESS}`,
    );
  });

  it("recommends read-only Compute inventory only with compute authority", () => {
    expect(wordCount(SCIENT_COMPUTE_AWARENESS)).toBeLessThanOrEqual(90);
    expect(SCIENT_COMPUTE_AWARENESS).toContain("`scient_compute_inventory`");
    expect(SCIENT_COMPUTE_AWARENESS).toContain("configured settings");
    expect(SCIENT_COMPUTE_AWARENESS).toContain("managed-runtime status");
    expect(SCIENT_COMPUTE_AWARENESS).toContain("existing candidates");
    expect(SCIENT_COMPUTE_AWARENESS).toContain("readiness is unknown");
    expect(SCIENT_COMPUTE_AWARENESS).toContain("does not install, run, execute, or attach");
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["sources:read"]))).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["compute:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_COMPUTE_AWARENESS}`,
    );
  });

  it("projects the Compute inventory name for Claude's MCP namespace", () => {
    const awareness = buildScientAwareness(
      new Set(["compute:read"]),
      CLAUDE_SCIENT_TOOL_PROJECTION,
    );

    expect(awareness).toContain("`mcp__t3-code__scient_compute_inventory`");
    expect(awareness).not.toContain("`scient_compute_inventory`");
  });

  it("adds compact, truthful PDF build guidance only with document authority", () => {
    expect(wordCount(SCIENT_DOCUMENT_BUILD_AWARENESS)).toBeLessThanOrEqual(50);
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("`scient_pdf_build`");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("`scient_latex_build`");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("requested PDF deliverable");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("existing project HTML source");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("existing project LaTeX source");
    for (const skillWorkflowDetail of [
      "retryAfterMs",
      "pageCount",
      "sourcePath",
      "outputPath",
      "rootSourcePath",
      "visual review",
    ]) {
      expect(SCIENT_DOCUMENT_BUILD_AWARENESS).not.toContain(skillWorkflowDetail);
    }
    expect(buildScientAwareness(new Set(["documents:build"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_DOCUMENT_BUILD_AWARENESS}`,
    );
  });

  it("projects exact provider tool names without changing capability gating", () => {
    const awareness = buildScientAwareness(
      new Set(["documents:build", "skills:read"]),
      CLAUDE_SCIENT_TOOL_PROJECTION,
    );

    expect(awareness).toContain("`mcp__t3-code__scient_pdf_build`");
    expect(awareness).toContain("`mcp__t3-code__scient_latex_build`");
    expect(awareness).not.toContain("`ToolSearch`");
    expect(awareness).not.toContain("use `scient_pdf_build`");
    expect(awareness).toContain(SCIENT_SKILLS_AWARENESS);
    expect(buildScientAwareness(new Set(), CLAUDE_SCIENT_TOOL_PROJECTION)).toBe(
      SCIENT_CORE_AWARENESS,
    );
  });

  it("requires an explicit delivery decision for every built-in provider", () => {
    const builtInKinds = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).toSorted();
    expect(Object.keys(SCIENT_AWARENESS_DELIVERY).toSorted()).toEqual(builtInKinds);
    expect(SCIENT_AWARENESS_DELIVERY.antigravity).toBe("unsupported-no-private-system-seam");
    expect(SCIENT_AWARENESS_DELIVERY.cursor).toBe("unsupported-no-private-system-seam");
  });
});
