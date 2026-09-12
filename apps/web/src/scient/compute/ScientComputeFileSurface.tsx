import type { EditorSelection, FileOptions, SelectedLineRange } from "@pierre/diffs/react";
import type {
  ComputeExecutionId,
  ComputeSessionId,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Columns2, Play, Rows2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { EditableFileSurface } from "~/components/files/FilePreviewPanel";
import type { DraftId } from "~/composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import type { FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { ResizeSeparator } from "~/scient/layout/ResizeSeparator";
import { useScientSplit } from "~/scient/layout/useScientSplit";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import { ComputePanel } from "./ComputePanel";
import type { ComputeSourceLanguage } from "./computeSourceLanguage";
import { ComputeFileActions, type ComputeFileActionsHandle } from "./ComputeFileActions";
import type { ComputeContextId } from "./computeContextStore";
import { computeActiveCell } from "./computeSourceSlices";
import {
  DEFAULT_COMPUTE_FILE_SPLIT,
  DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT,
  DEFAULT_COMPUTE_FILE_RESULTS_VIEW,
  MIN_COMPUTE_FILE_SPLIT,
  COMPUTE_FILE_SPLIT_KEYBOARD_STEP,
  COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY,
  COMPUTE_FILE_SPLIT_STORAGE_KEY,
  COMPUTE_FILE_VIEW_LABELS,
  COMPUTE_FILE_RESULTS_VIEW_STORAGE_KEY,
  COMPUTE_FILE_VIEWS,
  computeFileViewAfterRun,
  normalizeComputeFileSplit,
  normalizeComputeFileSplitLayout,
  normalizeComputeFileResultsView,
  type ComputeFileSplitLayout,
  type ComputeFileResultsView,
  type ComputeFileView,
} from "./computeFileSurfaceModel";

type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

const SEGMENT_BUTTON_CLASS =
  "flex h-5.5 cursor-pointer items-center justify-center rounded-[5px] text-[11px] leading-[18px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

interface ScientComputeFileSurfaceProps {
  readonly language: ComputeSourceLanguage;
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
  readonly contextId: ComputeContextId;
}

function initialResultsView(): ComputeFileResultsView {
  try {
    return normalizeComputeFileResultsView(
      getLocalStorageItem(COMPUTE_FILE_RESULTS_VIEW_STORAGE_KEY, Schema.String),
    );
  } catch (error) {
    console.error(error);
    return DEFAULT_COMPUTE_FILE_RESULTS_VIEW;
  }
}

function initialSplit(): number {
  try {
    return normalizeComputeFileSplit(
      getLocalStorageItem(COMPUTE_FILE_SPLIT_STORAGE_KEY, Schema.Number),
    );
  } catch (error) {
    console.error(error);
    return DEFAULT_COMPUTE_FILE_SPLIT;
  }
}

function initialSplitLayout(): ComputeFileSplitLayout {
  try {
    return normalizeComputeFileSplitLayout(
      getLocalStorageItem(COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY, Schema.String),
    );
  } catch (error) {
    console.error(error);
    return DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT;
  }
}

function persist<T, E>(key: string, value: T, schema: Schema.Codec<T, E>): void {
  try {
    setLocalStorageItem(key, value, schema);
  } catch (error) {
    console.error(error);
  }
}

export function ScientComputeFileSurface(props: ScientComputeFileSurfaceProps) {
  const [view, setView] = useState<ComputeFileView>("code");
  const [preferredResultsView, setPreferredResultsView] =
    useState<ComputeFileResultsView>(initialResultsView);
  const [split, setSplit] = useState(initialSplit);
  const [splitLayout, setSplitLayout] = useState<ComputeFileSplitLayout>(initialSplitLayout);
  const [selection, setSelection] = useState<{
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null);
  const [focusExecution, setFocusExecution] = useState<{
    readonly sessionId: ComputeSessionId;
    readonly executionId: ComputeExecutionId;
  } | null>(null);
  const actionsRef = useRef<ComputeFileActionsHandle>(null);

  const activeCellRange = useMemo<SelectedLineRange | null>(() => {
    const cell = computeActiveCell(props.contents, editorSelection, props.language.cellMarker);
    return cell === null ? null : { start: cell.range.startLine + 1, end: cell.range.endLine + 1 };
  }, [editorSelection, props.contents, props.language.cellMarker]);
  const hasExplicitCells = useMemo(
    () => props.contents.split(/\r?\n/).some((line) => props.language.cellMarker.test(line)),
    [props.contents, props.language.cellMarker],
  );

  const selectView = useCallback((next: ComputeFileView) => {
    setView(next);
    if (next === "code") return;
    setPreferredResultsView(next);
    persist(COMPUTE_FILE_RESULTS_VIEW_STORAGE_KEY, next, Schema.String);
  }, []);
  const selectSplitLayout = useCallback((next: ComputeFileSplitLayout) => {
    setSplitLayout(next);
    persist(COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY, next, Schema.String);
  }, []);
  const commitSplit = useCallback((next: number) => {
    setSplit(next);
    persist(COMPUTE_FILE_SPLIT_STORAGE_KEY, next, Schema.Number);
  }, []);
  const isStacked = view === "split" && splitLayout === "stacked";
  const { containerRef, primaryPaneRef, separatorHandlers } = useScientSplit({
    active: view === "split",
    axis: splitLayout === "stacked" ? "y" : "x",
    fraction: split,
    minimum: MIN_COMPUTE_FILE_SPLIT,
    fallback: DEFAULT_COMPUTE_FILE_SPLIT,
    keyboardStep: COMPUTE_FILE_SPLIT_KEYBOARD_STEP,
    onCommit: commitSplit,
  });
  const handleRunRequested = useCallback(() => {
    setView((current) => computeFileViewAfterRun(current, preferredResultsView));
  }, [preferredResultsView]);
  const handleEmptyResultsRun = useCallback(() => {
    actionsRef.current?.runPrimary();
  }, []);
  const handleExecutionSubmitted = useCallback(
    (sessionId: ComputeSessionId, executionId: ComputeExecutionId) => {
      setFocusExecution({ sessionId, executionId });
    },
    [],
  );
  const handleFocusConsumed = useCallback((executionId: string) => {
    setFocusExecution((current) => (current?.executionId === executionId ? null : current));
  }, []);

  const showEditor = view !== "results";
  const showResults = view !== "code";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" dir="ltr">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/20 px-2 py-1">
        <div
          className="flex shrink-0 items-center gap-px rounded-[6px] border border-border p-px"
          role="group"
          aria-label={`${props.language.displayName} view layout`}
        >
          {COMPUTE_FILE_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={cn(
                SEGMENT_BUTTON_CLASS,
                "px-2",
                view === candidate && "bg-accent text-accent-foreground",
              )}
              aria-pressed={view === candidate}
              onClick={() => selectView(candidate)}
            >
              {COMPUTE_FILE_VIEW_LABELS[candidate]}
            </button>
          ))}
        </div>
        {view === "split" ? (
          <div
            className="flex shrink-0 items-center gap-px rounded-[6px] border border-border p-px"
            role="group"
            aria-label="Split layout orientation"
          >
            <ScientTooltip content="Side by side">
              <button
                type="button"
                className={cn(
                  SEGMENT_BUTTON_CLASS,
                  "w-5.5",
                  splitLayout === "side-by-side" && "bg-accent text-accent-foreground",
                )}
                aria-pressed={splitLayout === "side-by-side"}
                aria-label="Arrange code and results side by side"
                onClick={() => selectSplitLayout("side-by-side")}
              >
                <Columns2 className="size-3" />
              </button>
            </ScientTooltip>
            <ScientTooltip content="Stacked">
              <button
                type="button"
                className={cn(
                  SEGMENT_BUTTON_CLASS,
                  "w-5.5",
                  splitLayout === "stacked" && "bg-accent text-accent-foreground",
                )}
                aria-pressed={splitLayout === "stacked"}
                aria-label="Stack code above results"
                onClick={() => selectSplitLayout("stacked")}
              >
                <Rows2 className="size-3" />
              </button>
            </ScientTooltip>
          </div>
        ) : null}
        <div className="min-w-22 flex-1">
          <ComputeFileActions
            ref={actionsRef}
            language={props.language}
            environmentId={props.environmentId}
            cwd={props.cwd}
            relativePath={props.relativePath}
            contents={props.contents}
            sourceRevision={props.revision}
            sourcePending={props.sourcePending}
            selection={selection}
            editorSelection={editorSelection}
            contextId={props.contextId}
            onRunRequested={handleRunRequested}
            onExecutionSubmitted={handleExecutionSubmitted}
          />
        </div>
      </div>

      <div
        ref={containerRef}
        className={cn("flex min-h-0 flex-1 overflow-hidden", isStacked ? "flex-col" : "flex-row")}
      >
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
              enableFileComments={false}
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
              showEditor && (isStacked ? "border-t border-border" : "border-l border-border"),
            )}
          >
            {showEditor ? (
              <ResizeSeparator
                orientation={isStacked ? "horizontal" : "vertical"}
                className={cn("absolute", isStacked ? "inset-x-0 -top-1" : "inset-y-0 -left-1")}
                tabIndex={0}
                aria-label={`Resize ${props.language.displayName} results`}
                aria-valuemin={Math.round(MIN_COMPUTE_FILE_SPLIT * 100)}
                aria-valuemax={Math.round((1 - MIN_COMPUTE_FILE_SPLIT) * 100)}
                aria-valuenow={Math.round(split * 100)}
                {...separatorHandlers}
              />
            ) : null}
            <ComputePanel
              environmentId={props.environmentId}
              cwd={props.cwd}
              threadRef={props.threadRef}
              sourcePath={props.relativePath}
              sourceLanguageId={props.language.languageId}
              sourceRevision={props.revision}
              sourcePending={props.sourcePending}
              contextId={props.contextId}
              focusSessionId={focusExecution?.sessionId ?? null}
              focusExecutionId={focusExecution?.executionId ?? null}
              onFocusConsumed={handleFocusConsumed}
              onRunSource={handleEmptyResultsRun}
              embedded
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
