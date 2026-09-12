/**
 * Canonical Scient tool names stay provider-independent. Adapters may project
 * them into the exact name their runtime exposes to the model.
 */
export interface ScientToolProjection {
  readonly skillLoad: string;
  readonly pdfBuild: string;
  readonly latexBuild: string;
  readonly computeInventory: string;
  readonly providerNativeSkillTool: boolean;
  readonly deferred: boolean;
}

export const CANONICAL_SCIENT_TOOL_PROJECTION: ScientToolProjection = {
  skillLoad: "scient_skill_load",
  pdfBuild: "scient_pdf_build",
  latexBuild: "scient_latex_build",
  computeInventory: "scient_compute_inventory",
  providerNativeSkillTool: false,
  deferred: false,
};

export const CLAUDE_SCIENT_TOOL_PROJECTION: ScientToolProjection = {
  skillLoad: "mcp__t3-code__scient_skill_load",
  pdfBuild: "mcp__t3-code__scient_pdf_build",
  latexBuild: "mcp__t3-code__scient_latex_build",
  computeInventory: "mcp__t3-code__scient_compute_inventory",
  providerNativeSkillTool: true,
  deferred: false,
};

export function scientToolProjectionForProvider(provider: string): ScientToolProjection {
  return provider === "claudeAgent"
    ? CLAUDE_SCIENT_TOOL_PROJECTION
    : CANONICAL_SCIENT_TOOL_PROJECTION;
}
