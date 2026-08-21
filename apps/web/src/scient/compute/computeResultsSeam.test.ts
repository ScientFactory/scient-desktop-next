// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const panelSource = NodeFS.readFileSync(NodePath.join(here, "ComputePanel.tsx"), "utf8");
const outputSource = NodeFS.readFileSync(NodePath.join(here, "ComputeOutputView.tsx"), "utf8");
const pythonActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "PythonFileComputeActions.tsx"),
  "utf8",
);

describe("compute result surface seam", () => {
  it("keeps editing in the file surface and results focused on outputs", () => {
    const resultSource = `${panelSource}\n${outputSource}`;
    expect(resultSource).not.toContain("Submitted code");
    expect(resultSource).not.toContain("Code that ran");
    expect(resultSource).not.toContain("Run code in this session");
    expect(resultSource).not.toContain("<textarea");
  });

  it("keeps text, errors, figures and live variables in one progressive result surface", () => {
    expect(outputSource).toContain('case "stream"');
    expect(outputSource).toContain('case "diagnostic"');
    expect(outputSource).toContain('case "image"');
    expect(panelSource).toContain("Variables");
    expect(panelSource).toContain("not saved in run history");
    expect(outputSource).toContain("diagnostic.frames");
    expect(outputSource).not.toContain("traceback.match");
    expect(outputSource).not.toContain("File \\\\s+");
  });

  it("keeps Python setup contextual to the file toolbar", () => {
    expect(pythonActionsSource).toContain("resolvePythonRuntimeToolbarState");
    expect(pythonActionsSource).toContain('title="Open Scientific Computing settings"');
    expect(pythonActionsSource).not.toContain("Settings2");
    expect(panelSource).toContain("!props.embedded && allSessions.length > 0");
  });
});
