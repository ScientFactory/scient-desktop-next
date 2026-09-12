import { describe, expect, it } from "vite-plus/test";

import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  CLAUDE_SCIENT_TOOL_PROJECTION,
  scientToolProjectionForProvider,
} from "./ScientToolProjection.ts";

describe("Scient tool projection", () => {
  it("keeps canonical names for providers that expose canonical tools", () => {
    expect(scientToolProjectionForProvider("codex")).toBe(CANONICAL_SCIENT_TOOL_PROJECTION);
    expect(scientToolProjectionForProvider("opencode")).toBe(CANONICAL_SCIENT_TOOL_PROJECTION);
  });

  it("uses Claude's exact qualified MCP names", () => {
    expect(scientToolProjectionForProvider("claudeAgent")).toBe(CLAUDE_SCIENT_TOOL_PROJECTION);
    expect(CLAUDE_SCIENT_TOOL_PROJECTION).toMatchObject({
      skillLoad: "mcp__t3-code__scient_skill_load",
      pdfBuild: "mcp__t3-code__scient_pdf_build",
      latexBuild: "mcp__t3-code__scient_latex_build",
      computeInventory: "mcp__t3-code__scient_compute_inventory",
      providerNativeSkillTool: true,
      deferred: false,
    });
  });

  it("keeps the canonical Compute inventory name explicit", () => {
    expect(CANONICAL_SCIENT_TOOL_PROJECTION.computeInventory).toBe("scient_compute_inventory");
  });
});
