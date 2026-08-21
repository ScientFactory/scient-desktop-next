export interface PythonCodeSlice {
  readonly code: string;
  readonly range: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
}

export interface PythonTextRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export type PythonRunTarget =
  | { readonly kind: "selection"; readonly label: "Run selection"; readonly slice: PythonCodeSlice }
  | { readonly kind: "cell"; readonly label: "Run cell"; readonly slice: PythonCodeSlice }
  | { readonly kind: "file"; readonly label: "Run file"; readonly slice: PythonCodeSlice | null };

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function sourceLines(contents: string): ReadonlyArray<SourceLine> {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= contents.length; index += 1) {
    if (index !== contents.length && contents[index] !== "\n") continue;
    const rawEnd = index;
    const end = rawEnd > start && contents[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ start, end, text: contents.slice(start, end) });
    start = index + 1;
  }
  return lines;
}

function sliceLines(
  contents: string,
  lines: ReadonlyArray<SourceLine>,
  firstLine: number,
  lastLine: number,
): PythonCodeSlice | null {
  if (lines.length === 0) return null;
  const startIndex = Math.max(0, Math.min(lines.length - 1, firstLine));
  const endIndex = Math.max(startIndex, Math.min(lines.length - 1, lastLine));
  const first = lines[startIndex];
  const last = lines[endIndex];
  if (!first || !last) return null;
  const code = contents.slice(first.start, last.end);
  if (code.trim().length === 0) return null;
  return {
    code,
    range: {
      startLine: startIndex,
      startColumn: 0,
      endLine: endIndex,
      endColumn: last.text.length,
    },
  };
}

function comparePosition(left: PythonTextRange["start"], right: PythonTextRange["start"]): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

/** Selects exact UTF-16 editor bytes, preserving partial-line selections. */
export function pythonTextSelection(
  contents: string,
  selection: PythonTextRange,
): PythonCodeSlice | null {
  const lines = sourceLines(contents);
  const [start, end] =
    comparePosition(selection.start, selection.end) <= 0
      ? [selection.start, selection.end]
      : [selection.end, selection.start];
  if (start.line === end.line && start.character === end.character) return null;
  const first = lines[start.line];
  const last = lines[end.line];
  if (
    first === undefined ||
    last === undefined ||
    start.character < 0 ||
    end.character < 0 ||
    start.character > first.text.length ||
    end.character > last.text.length
  ) {
    return null;
  }
  const code = contents.slice(first.start + start.character, last.start + end.character);
  if (code.trim().length === 0) return null;
  return {
    code,
    range: {
      startLine: start.line,
      startColumn: start.character,
      endLine: end.line,
      endColumn: end.character,
    },
  };
}

/** Selects exact editor bytes for a one-based inclusive line selection. */
export function pythonSelection(
  contents: string,
  selection: { readonly start: number; readonly end: number },
): PythonCodeSlice | null {
  const lines = sourceLines(contents);
  const first = Math.min(selection.start, selection.end) - 1;
  const last = Math.max(selection.start, selection.end) - 1;
  return sliceLines(contents, lines, first, last);
}

/**
 * Resolves the `# %%` cell containing a one-based editor line. Marker lines
 * delimit cells and are never submitted to the runtime.
 */
export function pythonCell(contents: string, line: number): PythonCodeSlice | null {
  const lines = sourceLines(contents);
  if (lines.length === 0) return null;
  const anchor = Math.max(0, Math.min(lines.length - 1, line - 1));
  const marker = /^\s*#\s*%%(?:\s|$)/;
  let markerLine: number | null = null;
  let last = lines.length - 1;
  for (let index = anchor; index >= 0; index -= 1) {
    if (!marker.test(lines[index]?.text ?? "")) continue;
    markerLine = index;
    break;
  }
  if (markerLine === null) return null;
  const first = markerLine + 1;
  for (let index = first; index < lines.length; index += 1) {
    if (!marker.test(lines[index]?.text ?? "")) continue;
    last = index - 1;
    break;
  }
  return first > last ? null : sliceLines(contents, lines, first, last);
}

/** The explicit cell implied by a caret, never by a non-collapsed text selection. */
export function pythonActiveCell(
  contents: string,
  selection: PythonTextRange | null,
): PythonCodeSlice | null {
  if (selection === null || comparePosition(selection.start, selection.end) !== 0) return null;
  return pythonCell(contents, selection.end.line + 1);
}

export function pythonFile(contents: string): PythonCodeSlice | null {
  const lines = sourceLines(contents);
  return sliceLines(contents, lines, 0, lines.length - 1);
}

/**
 * Resolves the one primary action exposed by the Python editor. Exact text is
 * strongest, an explicit `# %%` cell is next, and the whole current buffer is
 * the unambiguous fallback. A line-range selection remains supported for the
 * editor's existing gutter selection interaction.
 */
export function resolvePythonRunTarget(
  contents: string,
  lineSelection: { readonly start: number; readonly end: number } | null,
  editorSelection: PythonTextRange | null,
): PythonRunTarget {
  const exactSelection =
    editorSelection === null ? null : pythonTextSelection(contents, editorSelection);
  const selectedLines = lineSelection === null ? null : pythonSelection(contents, lineSelection);
  const selection = exactSelection ?? selectedLines;
  if (selection !== null) {
    return { kind: "selection", label: "Run selection", slice: selection };
  }

  const cell = pythonActiveCell(contents, editorSelection);
  if (cell !== null) return { kind: "cell", label: "Run cell", slice: cell };

  return { kind: "file", label: "Run file", slice: pythonFile(contents) };
}
