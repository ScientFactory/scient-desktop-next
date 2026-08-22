// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fileEditorSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/files/FilePreviewPanel.tsx"),
  "utf8",
);
const pythonSurfaceSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientPythonComputeSurface.tsx"),
  "utf8",
);

describe("Python active-cell editor seam", () => {
  it("derives the active cell from the shared run-target model", () => {
    expect(pythonSurfaceSource).toContain("pythonActiveCell(props.contents, editorSelection)");
    expect(pythonSurfaceSource).toContain("activeLineRange={activeCellRange}");
  });

  it("uses the editor's supported whole-line selection path without pointer hover", () => {
    expect(fileEditorSource).toContain('activeLineSide: "additions"');
    expect(fileEditorSource).toContain("FILE_ACTIVE_RANGE_ATTRIBUTE");
    expect(fileEditorSource).toContain("color-mix(in srgb, var(--primary) 8%, transparent)");
    expect(fileEditorSource).not.toContain(
      "lineNumberOnly: selectedRange === null && activeLineRange != null",
    );
  });

  it("uses one Pierre gutter utility API for the run-cell action", () => {
    expect(fileEditorSource).toContain("renderEditorGutterAction === undefined");
    expect(fileEditorSource).toContain("{ onGutterUtilityClick: handleGutterUtilityClick }");
    expect(pythonSurfaceSource).toContain("renderEditorGutterAction: (");
    expect(pythonSurfaceSource).toContain("const hoveredLine = getHoveredLine();");
    expect(pythonSurfaceSource).not.toContain("onEditorGutterAction:");
  });
});
