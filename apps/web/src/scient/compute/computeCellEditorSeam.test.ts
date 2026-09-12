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
  NodePath.join(here, "ScientComputeFileSurface.tsx"),
  "utf8",
);

describe("Python active-cell editor seam", () => {
  it("derives the active cell from the shared run-target model", () => {
    expect(pythonSurfaceSource).toContain(
      "computeActiveCell(props.contents, editorSelection, props.language.cellMarker)",
    );
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
    expect(fileEditorSource).toContain("FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS");
    expect(fileEditorSource).toContain("[data-gutter-utility-slot]");
    expect(fileEditorSource).toContain("justify-content: flex-start");
    expect(fileEditorSource).toContain("opacity: 0");
    expect(fileEditorSource).toContain("[data-line]:hover [data-gutter-utility-slot]");
    expect(pythonSurfaceSource).toContain("renderEditorGutterAction: (");
    expect(pythonSurfaceSource).toContain("const hoveredLine = getHoveredLine();");
    expect(pythonSurfaceSource).not.toContain("onEditorGutterAction:");
    expect(pythonSurfaceSource).toContain("enableFileComments={false}");
    expect(pythonSurfaceSource).toContain("hasExplicitCells");
    expect(pythonSurfaceSource).toContain("props.language.cellMarker.test(line)");
    expect(fileEditorSource).toContain("enableFileComments = true");
    expect(fileEditorSource).toContain("enableFileComments &&");
    expect(fileEditorSource).toContain("enableFileComments ? lineAnnotations : []");
  });
});
