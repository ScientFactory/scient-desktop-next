import type { McpCapability } from "../mcp/McpInvocationContext.ts";

import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user can inspect and edit workspace files and sees replies in Scient's Markdown chat.

Project \`.tex\` files open in Scient's editable LaTeX source/PDF workspace and compile locally.

Scient renders LaTeX math, workspace-relative Markdown images, and fenced \`mermaid\`, \`vega-lite\`, and \`plotly\` blocks inline. Put Mermaid's diagram declaration before its contents. Use Vega-Lite JSON or self-contained Plotly figure JSON. Use these formats directly, without HTML or JavaScript wrappers. Avoid embedded base64 images. Explain visuals nearby when useful. Create workspace files when the user needs a standalone deliverable.`;

/** Included only when the session credential actually grants preview access. */
export const SCIENT_PREVIEW_AWARENESS = `## Scient browser
The \`preview_*\` tools control Scient's browser shared with the user. Prefer them for browser work. Start with \`preview_status\`; call \`preview_open\` if no automation-capable tab is attached. Use another browser system only when these tools are unavailable, explicitly unsupported, or the user requests it.`;

/** Included only when the session may build project documents. */
const buildScientDocumentAwareness = (tools: ScientToolProjection): string => `## Scient PDF builds
For a requested PDF deliverable, use \`${tools.pdfBuild}\` to build an existing project HTML source and \`${tools.latexBuild}\` to build an existing project LaTeX source.${tools.deferred ? ` If either is deferred, load its exact name through \`ToolSearch\` first.` : ""}`;

export const SCIENT_DOCUMENT_BUILD_AWARENESS = buildScientDocumentAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included when this provider can receive turn-scoped Scient skills. */
export const SCIENT_SKILLS_AWARENESS = `## Scient skills
Scient may provide a private turn-scoped index of available skills. Follow that index. Skills provide guidance and grant no tools or authority.`;

const buildScientComputeAwareness = (tools: ScientToolProjection): string => `## Scient Compute
When you need to know which Scient runtimes are configured or already present, call \`${tools.computeInventory}\`. It is a bounded, read-only inventory of configured settings, managed-runtime status, and existing candidates. Inventory is discovery only: readiness is unknown unless a separate verified result says otherwise. It does not install, run, execute, or attach to runtimes or project sessions.`;

export const SCIENT_COMPUTE_AWARENESS = buildScientComputeAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Compose only the blocks supported by this exact provider session. */
export function buildScientAwareness(
  capabilities?: ReadonlySet<McpCapability>,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): string {
  return [
    SCIENT_CORE_AWARENESS,
    ...(capabilities?.has("preview") ? [SCIENT_PREVIEW_AWARENESS] : []),
    ...(capabilities?.has("compute:read") ? [buildScientComputeAwareness(tools)] : []),
    ...(capabilities?.has("documents:build") ? [buildScientDocumentAwareness(tools)] : []),
    ...(capabilities?.has("skills:read") ? [SCIENT_SKILLS_AWARENESS] : []),
  ].join("\n\n");
}

/**
 * Every built-in provider must make an explicit delivery decision. The
 * coverage test compares these keys with the authoritative driver registry so
 * adding a provider cannot silently omit Scient awareness.
 */
export const SCIENT_AWARENESS_DELIVERY = {
  antigravity: "unsupported-no-private-system-seam",
  claudeAgent: "system-preset-append",
  codex: "developer-instructions",
  cursor: "unsupported-no-private-system-seam",
  droid: "system-prompt-append",
  grok: "rules-append",
  opencode: "per-message-system",
  pi: "before-agent-start-system-append",
} as const;

export type ScientAwarenessProvider = keyof typeof SCIENT_AWARENESS_DELIVERY;
export type ScientAwarenessDelivery = (typeof SCIENT_AWARENESS_DELIVERY)[ScientAwarenessProvider];
