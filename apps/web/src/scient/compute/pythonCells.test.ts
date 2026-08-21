import { describe, expect, it } from "vite-plus/test";

import {
  pythonActiveCell,
  pythonCell,
  pythonFile,
  pythonSelection,
  pythonTextSelection,
  resolvePythonRunTarget,
} from "./pythonCells";

describe("Python editor execution slices", () => {
  const source = [
    "# %% imports",
    "import math",
    "",
    "# %% calculation",
    "value = math.sqrt(9)",
    "print(value)",
    "",
    "# %% empty",
  ].join("\n");

  it("submits the exact selected lines and normalizes a reverse selection", () => {
    expect(pythonSelection(source, { start: 6, end: 5 })).toEqual({
      code: "value = math.sqrt(9)\nprint(value)",
      range: { startLine: 4, startColumn: 0, endLine: 5, endColumn: 12 },
    });
  });

  it("submits the current cell without its # %% markers", () => {
    expect(pythonCell(source, 5)).toEqual({
      code: "value = math.sqrt(9)\nprint(value)\n",
      range: { startLine: 4, startColumn: 0, endLine: 6, endColumn: 0 },
    });
    expect(pythonCell(source, 8)).toBeNull();
  });

  it("treats only a caret as the active cell visual target", () => {
    expect(
      pythonActiveCell(source, {
        start: { line: 5, character: 2 },
        end: { line: 5, character: 2 },
      }),
    ).toMatchObject({
      code: "value = math.sqrt(9)\nprint(value)\n",
      range: { startLine: 4, endLine: 6 },
    });
    expect(
      pythonActiveCell(source, {
        start: { line: 4, character: 0 },
        end: { line: 5, character: 3 },
      }),
    ).toBeNull();
  });

  it("requires an explicit marker before offering a cell", () => {
    expect(pythonCell("value = 1\nprint(value)", 2)).toBeNull();
    expect(pythonCell(["preamble = 1", "# %%", "value = 2"].join("\n"), 1)).toBeNull();
    expect(pythonCell(["preamble = 1", "# %%", "value = 2"].join("\n"), 2)).toEqual({
      code: "value = 2",
      range: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 9 },
    });
  });

  it("preserves exact partial-line editor selections", () => {
    expect(
      pythonTextSelection("prefix = value + 1\nprint(prefix)", {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 18 },
      }),
    ).toEqual({
      code: "value + 1",
      range: { startLine: 0, startColumn: 9, endLine: 0, endColumn: 18 },
    });
    expect(
      pythonTextSelection("one\ntwo\nthree", {
        start: { line: 2, character: 2 },
        end: { line: 0, character: 1 },
      }),
    ).toEqual({
      code: "ne\ntwo\nth",
      range: { startLine: 0, startColumn: 1, endLine: 2, endColumn: 2 },
    });
  });

  it("preserves current file bytes while reporting a zero-based source range", () => {
    expect(pythonFile("x = 1\r\nprint(x)")).toEqual({
      code: "x = 1\r\nprint(x)",
      range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 8 },
    });
  });

  it("chooses exact text, then an explicit cell, then the whole file", () => {
    expect(
      resolvePythonRunTarget(
        source,
        { start: 5, end: 6 },
        {
          start: { line: 4, character: 8 },
          end: { line: 4, character: 12 },
        },
      ),
    ).toMatchObject({ kind: "selection", slice: { code: "math" } });
    expect(
      resolvePythonRunTarget(source, null, {
        start: { line: 5, character: 2 },
        end: { line: 5, character: 2 },
      }),
    ).toMatchObject({
      kind: "cell",
      slice: { code: "value = math.sqrt(9)\nprint(value)\n" },
    });
    expect(
      resolvePythonRunTarget("value = 1\nprint(value)", null, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      }),
    ).toMatchObject({ kind: "file", slice: { code: "value = 1\nprint(value)" } });
  });

  it("keeps Unicode and CRLF bytes aligned with UTF-16 editor columns", () => {
    expect(pythonSelection('α = "🧪"\r\nprint(α)\r\n', { start: 1, end: 2 })).toEqual({
      code: 'α = "🧪"\r\nprint(α)',
      range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 8 },
    });
  });

  it("refuses empty selections and empty files", () => {
    expect(pythonSelection("\n\n", { start: 1, end: 2 })).toBeNull();
    expect(pythonFile("  \n")).toBeNull();
  });
});
