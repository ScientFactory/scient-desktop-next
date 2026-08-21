import type { EditorSelection, FileOptions, SelectedLineRange } from "@pierre/diffs/react";
import type { ComputeExecutionId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Play } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { EditableFileSurface } from "~/components/files/FilePreviewPanel";
import type { DraftId } from "~/composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import type { FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { useScientHorizontalSplit } from "~/scient/layout/useScientHorizontalSplit";
import { ResizeSeparator } from "~/scient/layout/ResizeSeparator";

import { ComputePanel } from "./ComputePanel";
import {
  PythonFileComputeActions,
  type PythonFileComputeActionsHandle,
} from "./PythonFileComputeActions";
import { pythonActiveCell } from "./pythonCells";
import {
  DEFAULT_PYTHON_COMPUTE_SPLIT,
  MIN_PYTHON_COMPUTE_SPLIT,
  PYTHON_COMPUTE_SPLIT_KEYBOARD_STEP,
  PYTHON_COMPUTE_SPLIT_STORAGE_KEY,
  PYTHON_COMPUTE_VIEW_LABELS,
  PYTHON_COMPUTE_VIEW_STORAGE_KEY,
  PYTHON_COMPUTE_VIEWS,
  normalizePythonComputeSplit,
  normalizePythonComputeView,
  type PythonComputeView,
} from "./pythonComputeSurfaceModel";

type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

interface ScientPythonComputeSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly contents: string;
  readonly revision: string;
  readonly resolvedTheme: "light" | "dark";
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
  readonly sourcePending: boolean;
  readonly onPostRender: FilePostRender;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onSaveFailure: (relativePath: string, error: unknown) => void;
  readonly onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  readonly onSaveResolutionApplied: () => void;
  readonly saveResolution: FileSaveResolution | null;
}

function initialView(): PythonComputeView {
  try {
    return normalizePythonComputeView(
      getLocalStorageItem(PYTHON_COMPUTE_VIEW_STORAGE_KEY, Schema.String),
    );
  } catch (error) {
    console.error(error);
    return normalizePythonComputeView(null);
  }
}

function initialSplit(): number {
  try {
    return normalizePythonComputeSplit(
      getLocalStorageItem(PYTHON_COMPUTE_SPLIT_STORAGE_KEY, Schema.Number),
    );
  } catch (error) {
    console.error(error);
    return DEFAULT_PYTHON_COMPUTE_SPLIT;
  }
}

function persist<T, E>(key: string, value: T, schema: Schema.Codec<T, E>): void {
  try {
    setLocalStorageItem(key, value, schema);
  } catch (error) {
    console.error(error);
  }
}

export function ScientPythonComputeSurface(props: ScientPythonComputeSurfaceProps) {
  const [view, setView] = useState(initialView);
  const [split, setSplit] = useState(initialSplit);
  const [selection, setSelection] = useState<{
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null);
  const [focusExecutionId, setFocusExecutionId] = useState<ComputeExecutionId | null>(null);
  const actionsRef = useRef<PythonFileComputeActionsHandle>(null);

  const activeCellRange = useMemo<SelectedLineRange | null>(() => {
    const cell = pythonActiveCell(props.contents, editorSelection);
    return cell === null ? null : { start: cell.range.startLine + 1, end: cell.range.endLine + 1 };
  }, [editorSelection, props.contents]);
  const hasExplicitCells = useMemo(
    () => /^\s*#\s*%%(?:\s|$)/m.test(props.contents),
    [props.contents],
  );

  const selectView = useCallback((next: PythonComputeView) => {
    setView(next);
    persist(PYTHON_COMPUTE_VIEW_STORAGE_KEY, next, Schema.String);
  }, []);
  const commitSplit = useCallback((next: number) => {
    setSplit(next);
    persist(PYTHON_COMPUTE_SPLIT_STORAGE_KEY, next, Schema.Number);
  }, []);
  const { containerRef, primaryPaneRef, separatorHandlers } = useScientHorizontalSplit({
    active: view === "split",
    fraction: split,
    minimum: MIN_PYTHON_COMPUTE_SPLIT,
    fallback: DEFAULT_PYTHON_COMPUTE_SPLIT,
    keyboardStep: PYTHON_COMPUTE_SPLIT_KEYBOARD_STEP,
    onCommit: commitSplit,
  });
  const handleExecutionSubmitted = useCallback(
    (executionId: ComputeExecutionId) => {
      setFocusExecutionId(executionId);
      selectView("split");
    },
    [selectView],
  );
  const handleFocusConsumed = useCallback((executionId: string) => {
    setFocusExecutionId((current) => (current === executionId ? null : current));
  }, []);

  const showEditor = view !== "results";
  const showResults = view !== "code";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" dir="ltr">
      <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-border/60 bg-muted/20 px-2 py-1">
        <div
          className="flex shrink-0 items-center gap-px rounded-[6px] border border-border p-px"
          role="group"
          aria-label="Python view layout"
        >
          {PYTHON_COMPUTE_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={cn(
                "cursor-pointer rounded-[5px] px-2 py-0.5 text-[11px] leading-[18px] text-muted-foreground hover:text-foreground",
                view === candidate && "bg-accent text-accent-foreground",
              )}
              aria-pressed={view === candidate}
              onClick={() => selectView(candidate)}
            >
              {PYTHON_COMPUTE_VIEW_LABELS[candidate]}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <PythonFileComputeActions
            ref={actionsRef}
            environmentId={props.environmentId}
            cwd={props.cwd}
            relativePath={props.relativePath}
            contents={props.contents}
            sourceRevision={props.revision}
            sourcePending={props.sourcePending}
            selection={selection}
            editorSelection={editorSelection}
            onExecutionSubmitted={handleExecutionSubmitted}
          />
        </div>
      </div>

      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        {showEditor ? (
          <div
            ref={primaryPaneRef}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view === "split" && "grow-0")}
          >
            <EditableFileSurface
              environmentId={props.environmentId}
              cwd={props.cwd}
              relativePath={props.relativePath}
              composerDraftTarget={props.composerDraftTarget}
              contents={props.contents}
              revision={props.revision}
              resolvedTheme={props.resolvedTheme}
              revealRequestId={props.revealRequestId}
              wordWrap={props.wordWrap}
              onPostRender={props.onPostRender}
              onPendingChange={props.onPendingChange}
              onSaveFailure={props.onSaveFailure}
              onSaveConfirmed={props.onSaveConfirmed}
              onSaveResolutionApplied={props.onSaveResolutionApplied}
              saveResolution={props.saveResolution}
              onSelectionChange={setSelection}
              activeLineRange={activeCellRange}
              onEditorSelectionChange={setEditorSelection}
              {...(hasExplicitCells
                ? {
                    renderEditorGutterAction: (
                      getHoveredLine: () => { lineNumber: number } | undefined,
                    ) => (
                      <button
                        type="button"
                        className="flex size-5 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label="Run cell"
                        onClick={() => {
                          const hoveredLine = getHoveredLine();
                          if (hoveredLine !== undefined) {
                            actionsRef.current?.runCellAtLine(hoveredLine.lineNumber);
                          }
                        }}
                      >
                        <Play className="size-3" />
                      </button>
                    ),
                  }
                : {})}
              onRunShortcut={(currentSelection) => actionsRef.current?.runPrimary(currentSelection)}
            />
          </div>
        ) : null}

        {showResults ? (
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col",
              showEditor && "border-l border-border",
            )}
          >
            {showEditor ? (
              <ResizeSeparator
                className="absolute inset-y-0 -left-1"
                tabIndex={0}
                aria-label="Resize Python results"
                aria-valuemin={Math.round(MIN_PYTHON_COMPUTE_SPLIT * 100)}
                aria-valuemax={Math.round((1 - MIN_PYTHON_COMPUTE_SPLIT) * 100)}
                aria-valuenow={Math.round(split * 100)}
                {...separatorHandlers}
              />
            ) : null}
            <ComputePanel
              environmentId={props.environmentId}
              cwd={props.cwd}
              threadRef={props.threadRef}
              sourcePath={props.relativePath}
              sourceRevision={props.revision}
              sourcePending={props.sourcePending}
              focusExecutionId={focusExecutionId}
              onFocusConsumed={handleFocusConsumed}
              embedded
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
