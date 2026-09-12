import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileImageIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

type DiagramZoom = "fit" | number;
type DiagramAction = "copy-source" | "copy-recovered-source" | "copy-png" | "download-png" | null;

interface MermaidDiagramDialogProps {
  readonly actionMessage: string | null;
  readonly activeAction: DiagramAction;
  readonly onCopyPng: () => void;
  readonly onCopySource: () => void;
  readonly onCopyRecoveredSource?: (() => void) | undefined;
  readonly onDownloadPng: () => void;
  readonly onDownloadSvg: () => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly svg: string;
  readonly title: string;
}

function intrinsicSvgWidth(svg: string): number {
  const match = /\bviewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
    svg,
  );
  const width = Number.parseFloat(match?.[1] ?? "");
  return Number.isFinite(width) && width > 0 ? width : 960;
}

export function MermaidDiagramDialog({
  actionMessage,
  activeAction,
  onCopyPng,
  onCopySource,
  onCopyRecoveredSource,
  onDownloadPng,
  onDownloadSvg,
  onOpenChange,
  open,
  svg,
  title,
}: MermaidDiagramDialogProps) {
  const [zoom, setZoom] = useState<DiagramZoom>("fit");
  const naturalWidth = useMemo(() => intrinsicSvgWidth(svg), [svg]);
  const numericZoom = zoom === "fit" ? 100 : zoom;
  const diagramWidth = zoom === "fit" ? "100%" : `${Math.round(naturalWidth * (zoom / 100))}px`;

  const changeZoom = (delta: number) => {
    setZoom((current) => {
      const value = current === "fit" ? 100 : current;
      return Math.min(400, Math.max(25, value + delta));
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="scient-visual-dialog flex max-w-none flex-col overflow-hidden"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pe-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              Expanded view of the Mermaid diagram with zoom and export controls.
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1" role="toolbar" aria-label="Diagram zoom">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Zoom out"
                    disabled={numericZoom <= 25}
                    onClick={() => changeZoom(-25)}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <MinusIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Zoom out</TooltipPopup>
            </Tooltip>
            <span className="w-12 text-center text-muted-foreground text-xs tabular-nums">
              {zoom === "fit" ? "Fit" : `${zoom}%`}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Zoom in"
                    disabled={numericZoom >= 400}
                    onClick={() => changeZoom(25)}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Zoom in</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Fit diagram to window"
                    onClick={() => setZoom("fit")}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <ScanIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Fit to window</TooltipPopup>
            </Tooltip>
            <Button onClick={() => setZoom(100)} size="sm" variant="ghost">
              Actual size
            </Button>
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="More diagram actions"
                          disabled={activeAction != null}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">More diagram actions</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" className="min-w-48">
                {onCopyRecoveredSource ? (
                  <MenuItem disabled={activeAction != null} onClick={onCopyRecoveredSource}>
                    {actionMessage === "Recovered source copied" ? <CheckIcon /> : <CopyIcon />}
                    Copy recovered source
                  </MenuItem>
                ) : null}
                <MenuItem disabled={activeAction != null} onClick={onCopySource}>
                  {actionMessage === "Source copied" ? <CheckIcon /> : <CopyIcon />}
                  {activeAction === "copy-source"
                    ? "Copying source…"
                    : onCopyRecoveredSource
                      ? "Copy original source"
                      : "Copy source"}
                </MenuItem>
                <MenuItem disabled={activeAction != null} onClick={onDownloadSvg}>
                  <DownloadIcon />
                  Download SVG
                </MenuItem>
                <MenuItem disabled={activeAction != null} onClick={onCopyPng}>
                  {actionMessage === "Image copied" ? <CheckIcon /> : <ImageIcon />}
                  {activeAction === "copy-png" ? "Copying image…" : "Copy image"}
                </MenuItem>
                <MenuItem disabled={activeAction != null} onClick={onDownloadPng}>
                  <FileImageIcon />
                  {activeAction === "download-png" ? "Creating PNG…" : "Download PNG"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </DialogHeader>
        <span aria-live="polite" className="sr-only">
          {actionMessage}
        </span>
        <div
          aria-label="Scrollable diagram canvas"
          className="scient-mermaid-dialog-stage min-h-0 flex-1 overflow-auto bg-secondary/30 p-6"
          tabIndex={0}
        >
          <div
            className="scient-mermaid-dialog-diagram mx-auto"
            style={{ width: diagramWidth }}
            // Mermaid renders in strict mode and sanitizes its generated SVG.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
