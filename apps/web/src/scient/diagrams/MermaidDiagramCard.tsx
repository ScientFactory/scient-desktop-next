import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  Maximize2Icon,
  FileImageIcon,
  ImageIcon,
  RefreshCwIcon,
  MessageSquareIcon,
} from "lucide-react";
import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useComposerHandleContext } from "~/composerHandleContext";
import { AssistantCitationContext } from "~/components/chat/assistantCitationContext";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { MarkdownCodeBlock } from "../presentation/MarkdownCodeBlock";
import {
  RichFenceSourceMenuItem,
  RichFenceSourcePreview,
  type ScientRichFenceAuthoringActions,
  type ScientRichFenceSourceEditor,
  useRichFenceContextMenu,
} from "../presentation/RichFenceSourceActions";

import {
  copyMermaidPng,
  downloadMermaidPng,
  downloadMermaidSvg,
  mermaidMarkdownCopySource,
} from "./mermaidExport";
import { MermaidDiagramDialog } from "./MermaidDiagramDialog";
import {
  renderMermaidDiagram,
  MermaidRenderError,
  type MermaidTheme,
  type RenderedMermaidDiagram,
} from "./mermaidRuntime";
import {
  addMermaidRepairToComposer,
  buildMermaidRepairRequest,
  createMermaidRepairCitation,
} from "./mermaidRepair";
import { useNearViewport } from "../presentation/useNearViewport";
import {
  VisualCardDetails,
  VisualCardToolbar,
  VisualCardMenuPopup,
  VisualCardToolbarMenuItems,
} from "../presentation/VisualCardToolbar";

import "./scient-diagrams.css";

interface MermaidDiagramCardProps {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly sourceEditor?: ScientRichFenceSourceEditor | undefined;
  readonly source: string;
  readonly language: string;
  readonly fenceMeta?: string | undefined;
  readonly title: string | null;
  readonly theme: MermaidTheme;
}

type DiagramState =
  | { readonly status: "idle" | "loading" }
  | ({ readonly source: string; readonly theme: MermaidTheme; readonly retryVersion: number } & (
      | { readonly status: "ready"; readonly result: RenderedMermaidDiagram }
      | { readonly status: "error"; readonly message: string; readonly diagnostic: string }
    ));

type DiagramAction =
  | "copy-source"
  | "copy-recovered-source"
  | "copy-repair"
  | "copy-png"
  | "download-png"
  | null;

function diagramErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "This Mermaid source could not be rendered.";
}

function DiagramActionButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="chat-markdown-chrome-action"
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function MermaidDiagramCard({
  authoringActions,
  sourceEditor,
  fenceMeta,
  language,
  source,
  theme,
  title,
}: MermaidDiagramCardProps) {
  const { ref, isNearViewport } = useNearViewport();
  const composerRef = useComposerHandleContext();
  const citationSource = use(AssistantCitationContext);
  const errorElementRef = useRef<HTMLSpanElement>(null);
  const [diagramState, setDiagramState] = useState<DiagramState>({ status: "idle" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [sourceVisible, setSourceVisible] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [activeAction, setActiveAction] = useState<DiagramAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const renderGenerationRef = useRef(0);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayTitle = title || "Mermaid diagram";
  const markdownCopy = useMemo(
    () => mermaidMarkdownCopySource(source, language, fenceMeta),
    [fenceMeta, language, source],
  );
  const resultIsCurrent =
    "source" in diagramState &&
    diagramState.source === source &&
    diagramState.theme === theme &&
    diagramState.retryVersion === retryVersion;
  const readyResult =
    diagramState.status === "ready" && resultIsCurrent ? diagramState.result : null;
  const recovery = readyResult?.recovery;

  useEffect(() => {
    if (!isNearViewport) return;
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    // Keep an error's geometry while its source is corrected or retried.
    setDiagramState((current) => (current.status === "error" ? current : { status: "loading" }));

    void renderMermaidDiagram(source, theme).then(
      (result) => {
        if (renderGenerationRef.current === generation) {
          setDiagramState({ status: "ready", result, source, theme, retryVersion });
        }
      },
      (cause) => {
        if (renderGenerationRef.current === generation) {
          setDiagramState({
            status: "error",
            message: diagramErrorMessage(cause),
            diagnostic:
              cause instanceof MermaidRenderError ? cause.details : diagramErrorMessage(cause),
            source,
            theme,
            retryVersion,
          });
        }
      },
    );

    return () => {
      if (renderGenerationRef.current === generation) {
        renderGenerationRef.current += 1;
      }
    };
  }, [isNearViewport, retryVersion, source, theme]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current != null) clearTimeout(copyResetTimerRef.current);
    },
    [],
  );

  const showTransientMessage = useCallback((message: string) => {
    if (copyResetTimerRef.current != null) clearTimeout(copyResetTimerRef.current);
    setActionMessage(message);
    copyResetTimerRef.current = setTimeout(() => {
      setActionMessage(null);
      copyResetTimerRef.current = null;
    }, 1_500);
  }, []);

  const showActionError = useCallback((message: string) => {
    toastManager.add({ type: "error", title: message, data: { hideCopyButton: true } });
  }, []);

  const copySource = useCallback(
    (text: string, recovered = false) => {
      if (activeAction != null) return;
      if (navigator.clipboard?.writeText == null) {
        showActionError("Clipboard access is unavailable.");
        return;
      }
      setActiveAction(recovered ? "copy-recovered-source" : "copy-source");
      void navigator.clipboard.writeText(text).then(
        () => {
          setActiveAction(null);
          showTransientMessage(recovered ? "Recovered source copied" : "Source copied");
        },
        (cause) => {
          console.error("[scient-diagrams] Failed to copy Mermaid source", cause);
          setActiveAction(null);
          showActionError("Unable to copy the diagram source.");
        },
      );
    },
    [activeAction, showActionError, showTransientMessage],
  );
  const handleCopySource = useCallback(() => copySource(source), [copySource, source]);
  const handleCopyRecoveredSource = recovery ? () => copySource(recovery.source, true) : undefined;

  const handleContextMenu = useRichFenceContextMenu(authoringActions, handleCopySource);
  const sourceIsVisible =
    diagramState.status === "error" || sourceVisible === true || sourceEditor?.open === true;
  const handleToggleSource = () => setSourceVisible(!sourceIsVisible);

  const repairRequest =
    diagramState.status === "error" && resultIsCurrent
      ? buildMermaidRepairRequest(source, diagramState.diagnostic)
      : null;

  const handleAskToFix = () => {
    if (
      !resultIsCurrent ||
      diagramState.status !== "error" ||
      !citationSource ||
      !errorElementRef.current
    )
      return;
    const citation = createMermaidRepairCitation(
      citationSource,
      errorElementRef.current,
      source,
      diagramState.diagnostic,
    );
    if (!citation) {
      showActionError("Unable to cite this diagram. Use Copy error and source.");
      return;
    }
    if (!addMermaidRepairToComposer(composerRef?.current, citation)) {
      showActionError("The composer is unavailable right now.");
    }
  };

  const handleCopyRepair = () => {
    if (repairRequest === null || activeAction !== null) return;
    if (!navigator.clipboard?.writeText) {
      showActionError("Clipboard access is unavailable.");
      return;
    }
    setActiveAction("copy-repair");
    void navigator.clipboard.writeText(repairRequest).then(
      () => {
        setActiveAction(null);
        showTransientMessage("Error and source copied");
      },
      () => {
        setActiveAction(null);
        showActionError("Unable to copy the error and source.");
      },
    );
  };

  const handleCopyPng = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    setActiveAction("copy-png");
    void copyMermaidPng(readyResult.svg, theme).then(
      () => {
        setActiveAction(null);
        showTransientMessage("Image copied");
      },
      (cause) => {
        console.error("[scient-diagrams] Failed to copy Mermaid PNG", cause);
        setActiveAction(null);
        showActionError("Unable to copy the diagram image.");
      },
    );
  }, [activeAction, readyResult, showActionError, showTransientMessage, theme]);

  const handleDownloadPng = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    setActiveAction("download-png");
    void downloadMermaidPng(readyResult.svg, title, theme).then(
      () => setActiveAction(null),
      (cause) => {
        console.error("[scient-diagrams] Failed to download Mermaid PNG", cause);
        setActiveAction(null);
        showActionError("Unable to create the PNG image.");
      },
    );
  }, [activeAction, readyResult, showActionError, theme, title]);

  const handleDownloadSvg = useCallback(() => {
    if (readyResult == null || activeAction != null) return;
    try {
      downloadMermaidSvg(readyResult.svg, title, theme);
    } catch (cause) {
      console.error("[scient-diagrams] Failed to download Mermaid SVG", cause);
      showActionError("Unable to download the SVG image.");
    }
  }, [activeAction, readyResult, showActionError, theme, title]);

  return (
    <div
      ref={ref}
      aria-label={displayTitle}
      className="scient-mermaid-card my-3 overflow-hidden rounded-lg bg-background leading-normal"
      data-markdown-copy={markdownCopy}
      data-scient-visual-card
      dir="ltr"
      onContextMenu={handleContextMenu}
      role="figure"
    >
      {diagramState.status !== "error" ? (
        <div className="flex flex-wrap items-center justify-end gap-2 px-2 pt-2">
          {title ? (
            <span className="min-w-0 flex-1 basis-40 wrap-anywhere text-xs font-medium" dir="auto">
              {title}
            </span>
          ) : null}
          <VisualCardToolbar label="Diagram actions">
            {readyResult != null ? (
              <DiagramActionButton
                disabled={activeAction != null}
                label="Expand diagram"
                onClick={() => setExpanded(true)}
              >
                <Maximize2Icon className="size-3" strokeWidth={1.5} />
              </DiagramActionButton>
            ) : null}

            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="More diagram actions"
                          className="chat-markdown-chrome-action"
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">More diagram actions</TooltipPopup>
              </Tooltip>
              <VisualCardMenuPopup align="end" className="min-w-52 max-w-[calc(100vw-2rem)]">
                <VisualCardDetails
                  title={displayTitle}
                  detail={
                    recovery ? `${readyResult?.diagramType} · Recovered` : readyResult?.diagramType
                  }
                />
                {recovery ? (
                  <MenuItem disabled={activeAction != null} onClick={handleCopyRecoveredSource}>
                    {actionMessage === "Recovered source copied" ? <CheckIcon /> : <CopyIcon />}
                    Copy recovered source
                  </MenuItem>
                ) : null}
                <MenuItem disabled={activeAction != null} onClick={handleCopySource}>
                  {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                  {recovery ? "Copy original source" : "Copy source"}
                </MenuItem>
                <RichFenceSourceMenuItem
                  authoringActions={authoringActions}
                  onToggleSource={handleToggleSource}
                  sourceVisible={sourceIsVisible}
                />
                <MenuItem
                  disabled={readyResult == null || activeAction != null}
                  onClick={handleDownloadSvg}
                >
                  <DownloadIcon />
                  Download SVG
                </MenuItem>
                <MenuItem
                  disabled={readyResult == null || activeAction != null}
                  onClick={handleCopyPng}
                >
                  {actionMessage === "Image copied" ? <CheckIcon /> : <ImageIcon />}
                  {activeAction === "copy-png" ? "Copying image…" : "Copy image"}
                </MenuItem>
                <MenuItem
                  disabled={readyResult == null || activeAction != null}
                  onClick={handleDownloadPng}
                >
                  <FileImageIcon />
                  {activeAction === "download-png" ? "Creating PNG…" : "Download PNG"}
                </MenuItem>
                <VisualCardToolbarMenuItems />
              </VisualCardMenuPopup>
            </Menu>
          </VisualCardToolbar>
        </div>
      ) : null}

      <span aria-live="polite" className="sr-only">
        {!expanded || readyResult === null ? actionMessage : null}
      </span>

      {diagramState.status === "idle" ||
      diagramState.status === "loading" ||
      (diagramState.status === "ready" && !resultIsCurrent) ? (
        <div className="flex min-h-44 items-center justify-center px-4 py-8 text-muted-foreground text-sm">
          {diagramState.status === "idle"
            ? "Diagram will render when visible"
            : "Rendering diagram…"}
        </div>
      ) : diagramState.status === "error" ? (
        <div
          aria-busy={!resultIsCurrent}
          aria-label="Diagram error"
          className="flex min-w-0 items-center gap-1.5 px-3 pb-1"
          role="group"
        >
          <Tooltip disabled={!resultIsCurrent}>
            <TooltipTrigger
              render={
                <span
                  ref={errorElementRef}
                  className="min-w-0 truncate text-xs text-muted-foreground"
                  tabIndex={0}
                />
              }
            >
              {resultIsCurrent ? diagramState.message : "Rendering diagram…"}
            </TooltipTrigger>
            <TooltipPopup className="max-h-48 max-w-sm overflow-y-auto whitespace-pre-wrap wrap-anywhere">
              {resultIsCurrent ? diagramState.diagnostic : null}
            </TooltipPopup>
          </Tooltip>
          <div
            className="flex shrink-0 items-center gap-0.5"
            role="group"
            aria-label="Diagram recovery"
          >
            {composerRef !== null && citationSource !== null ? (
              <DiagramActionButton
                onClick={handleAskToFix}
                disabled={repairRequest === null}
                label="Ask agent to fix"
              >
                <MessageSquareIcon className="size-3" strokeWidth={1.5} />
              </DiagramActionButton>
            ) : null}
            <DiagramActionButton
              onClick={handleCopyRepair}
              disabled={repairRequest === null || activeAction !== null}
              label="Copy error and source"
            >
              {actionMessage === "Error and source copied" ? (
                <CheckIcon className="size-3" strokeWidth={1.5} />
              ) : (
                <CopyIcon className="size-3" strokeWidth={1.5} />
              )}
            </DiagramActionButton>
            <DiagramActionButton
              onClick={() => setRetryVersion((version) => version + 1)}
              disabled={!resultIsCurrent}
              label="Retry diagram"
            >
              <RefreshCwIcon className="size-3" strokeWidth={1.5} />
            </DiagramActionButton>
          </div>
        </div>
      ) : readyResult !== null ? (
        <div className="scient-mermaid-inline overflow-auto p-2">
          <div
            // Mermaid's strict renderer sanitizes generated SVG. We deliberately
            // do not call bindFunctions, so diagram-authored click handlers do not run.
            dangerouslySetInnerHTML={{ __html: readyResult.svg }}
          />
        </div>
      ) : null}

      {diagramState.status === "error" && !sourceEditor ? (
        <MarkdownCodeBlock
          code={source}
          language={language}
          fenceTitle={title}
          theme={theme}
          className="my-0"
          onCopyFailure={() => showActionError("Unable to copy the diagram source.")}
        />
      ) : (
        <RichFenceSourcePreview
          editor={sourceEditor}
          visible={sourceIsVisible}
          source={source}
          className={
            sourceEditor || diagramState.status === "error"
              ? "px-4 pb-4"
              : "border-t border-border/60 bg-background/45 p-3"
          }
        />
      )}

      {readyResult != null ? (
        <MermaidDiagramDialog
          actionMessage={actionMessage}
          activeAction={activeAction === "copy-repair" ? null : activeAction}
          onCopyPng={handleCopyPng}
          onCopySource={handleCopySource}
          onCopyRecoveredSource={handleCopyRecoveredSource}
          onDownloadPng={handleDownloadPng}
          onDownloadSvg={handleDownloadSvg}
          onOpenChange={setExpanded}
          open={expanded}
          svg={readyResult.svg}
          title={displayTitle}
        />
      ) : null}
    </div>
  );
}
