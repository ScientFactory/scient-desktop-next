import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ExpandIcon,
  FileImageIcon,
  FolderOpenIcon,
  PaletteIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useAssetUrlState } from "~/assets/assetUrls";
import { PreviewImageSurface } from "~/components/preview/PreviewImageSurface";
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
import { ScientTooltip } from "../presentation/ScientTooltip";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

import { copyStaticImage, downloadStaticImage } from "../artifacts/staticImageActions";
import {
  inlineImageFormatLabel,
  inlineWorkspaceImageResource,
  type InlineWorkspaceImageDescriptor,
} from "./inlineWorkspaceImage";

export type InlineImageBackground = "automatic" | "light" | "dark";

type ImageAction = "copy-image" | "copy-path" | "download" | null;

const BACKGROUND_CLASS: Record<InlineImageBackground, string> = {
  automatic: "bg-background",
  light: "bg-white",
  dark: "bg-neutral-950",
};

export function nextInlineImageBackground(
  background: InlineImageBackground,
): InlineImageBackground {
  if (background === "automatic") return "light";
  if (background === "light") return "dark";
  return "automatic";
}

export function ScientPendingWorkspaceImage(props: {
  readonly image: InlineWorkspaceImageDescriptor;
  readonly markdownSource: string;
  readonly reason: "streaming" | "unavailable";
}) {
  return (
    <span
      aria-label={props.image.alt}
      className="my-3 block overflow-hidden rounded-lg border border-border/70 bg-secondary/30 leading-normal"
      data-markdown-copy={props.markdownSource}
      data-scient-inline-workspace-image-pending={props.reason}
      dir="ltr"
      role="figure"
    >
      <span className="flex min-h-9 select-none items-center gap-2 border-b border-border/60 bg-secondary/60 px-2">
        <FileImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" dir="auto">
          {props.image.alt}
        </span>
        <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {inlineImageFormatLabel(props.image.fileName)}
        </span>
      </span>
      <span className="flex min-h-28 items-center justify-center px-5 py-8 text-center text-muted-foreground text-sm">
        {props.reason === "streaming"
          ? "Image preview will appear when this response finishes."
          : "Image preview is unavailable without an active workspace."}
      </span>
      <ScientTooltip content={props.image.displayPath}>
        <span
          className="block truncate border-t border-border/50 bg-secondary/40 px-3 py-1.5 font-mono text-[10px] text-muted-foreground"
          dir="auto"
        >
          {props.image.displayPath}
        </span>
      </ScientTooltip>
    </span>
  );
}

function backgroundLabel(background: InlineImageBackground): string {
  return background === "automatic" ? "automatic" : background;
}

function ImageActionButton({
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

function InlineImageActionsMenu(props: {
  readonly actionMessage: string | null;
  readonly activeAction: ImageAction;
  readonly background: InlineImageBackground;
  readonly compact?: boolean;
  readonly hasImage: boolean;
  readonly onCopyImage: () => void;
  readonly onCopyPath: () => void;
  readonly onCycleBackground: () => void;
  readonly onDownload: () => void;
  readonly onRefresh: () => void;
}) {
  const compact = props.compact ?? false;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="More image actions"
                  className={compact ? "chat-markdown-chrome-action" : undefined}
                  disabled={props.activeAction != null}
                  size={compact ? "icon-xs" : "icon-sm"}
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          <EllipsisIcon className={compact ? "size-3" : undefined} />
        </TooltipTrigger>
        <TooltipPopup side={compact ? "top" : "bottom"}>More image actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem
          disabled={!props.hasImage || props.activeAction != null}
          onClick={props.onCopyImage}
        >
          <CopyIcon />
          {props.activeAction === "copy-image" ? "Copying image…" : "Copy image"}
        </MenuItem>
        <MenuItem
          disabled={!props.hasImage || props.activeAction != null}
          onClick={props.onDownload}
        >
          <DownloadIcon />
          {props.activeAction === "download" ? "Preparing download…" : "Download original"}
        </MenuItem>
        <MenuItem disabled={props.activeAction != null} onClick={props.onCopyPath}>
          {props.actionMessage === "Path copied" ? <CheckIcon /> : <CopyIcon />}
          Copy relative path
        </MenuItem>
        <MenuItem onClick={props.onCycleBackground}>
          <PaletteIcon />
          Background: {backgroundLabel(props.background)}
        </MenuItem>
        <MenuItem onClick={props.onRefresh}>
          <RefreshCwIcon />
          Refresh from file
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function InlineImageDialog(props: {
  readonly actionMessage: string | null;
  readonly activeAction: ImageAction;
  readonly alt: string;
  readonly background: InlineImageBackground;
  readonly fileName: string;
  readonly onCopyImage: () => void;
  readonly onCopyPath: () => void;
  readonly onCycleBackground: () => void;
  readonly onDownload: () => void;
  readonly onLoadError: () => void;
  readonly onOpenFile: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => void;
  readonly open: boolean;
  readonly revisionKey: string;
  readonly url: string;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="flex h-[min(92vh,64rem)] w-[min(94vw,96rem)] max-w-none flex-col overflow-hidden"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pe-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base" dir="auto">
              {props.alt}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Expanded preview of {props.fileName}. Pinch or Control-scroll to zoom.
            </DialogDescription>
          </div>
          <div
            className="flex items-center gap-1"
            role="toolbar"
            aria-label="Expanded image actions"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open image file"
                    disabled={props.activeAction != null}
                    onClick={() => {
                      props.onOpenChange(false);
                      props.onOpenFile();
                    }}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <FolderOpenIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open image file</TooltipPopup>
            </Tooltip>
            <InlineImageActionsMenu
              actionMessage={props.actionMessage}
              activeAction={props.activeAction}
              background={props.background}
              hasImage
              onCopyImage={props.onCopyImage}
              onCopyPath={props.onCopyPath}
              onCycleBackground={props.onCycleBackground}
              onDownload={props.onDownload}
              onRefresh={props.onRefresh}
            />
          </div>
        </DialogHeader>
        {props.actionMessage != null ? (
          <div
            aria-live="polite"
            className="border-b border-border/60 bg-background/70 px-4 py-2 text-muted-foreground text-xs"
          >
            {props.actionMessage}
          </div>
        ) : null}
        <PreviewImageSurface
          className={cn("min-h-0 flex-1", BACKGROUND_CLASS[props.background])}
          onLoadError={props.onLoadError}
          source={{ url: props.url, alt: props.alt, revisionKey: props.revisionKey }}
        />
      </DialogPopup>
    </Dialog>
  );
}

export function ScientInlineWorkspaceImage(props: {
  readonly image: InlineWorkspaceImageDescriptor;
  readonly markdownSource: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const resource = useMemo(
    () => inlineWorkspaceImageResource(props.image, props.threadRef),
    [props.image, props.threadRef],
  );
  const asset = useAssetUrlState(props.threadRef.environmentId, resource);
  const retryKey = `${props.image.workspaceRoot}\u0000${props.image.relativePath}`;
  const autoRetriedRef = useRef<string | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeAction, setActiveAction] = useState<ImageAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [background, setBackground] = useState<InlineImageBackground>("automatic");
  const [expanded, setExpanded] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = asset._tag === "Success" ? asset.url : null;
  const loadFailed = asset._tag === "Failure" || (url != null && failedUrl === url);
  const loaded = url != null && loadedUrl === url && !loadFailed;
  const revisionKey = `${props.threadRef.environmentId}:${retryKey}`;

  useEffect(
    () => () => {
      if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setLoadedUrl(null);
    setFailedUrl(null);
  }, [url]);

  const showTransientMessage = useCallback((message: string) => {
    if (messageTimerRef.current != null) clearTimeout(messageTimerRef.current);
    setActionMessage(message);
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null;
      setActionMessage(null);
    }, 1_500);
  }, []);

  const showPersistentMessage = useCallback((message: string) => {
    if (messageTimerRef.current != null) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setActionMessage(message);
  }, []);

  const handleImageError = useCallback(() => {
    if (url == null) return;
    setLoadedUrl(null);
    if (autoRetriedRef.current !== retryKey) {
      autoRetriedRef.current = retryKey;
      asset.refresh();
      return;
    }
    setFailedUrl(url);
    setExpanded(false);
  }, [asset, retryKey, url]);

  const handleRetry = useCallback(() => {
    autoRetriedRef.current = null;
    setFailedUrl(null);
    setLoadedUrl(null);
    setActionMessage(null);
    asset.refresh();
  }, [asset]);

  const runAction = useCallback(
    (
      action: Exclude<ImageAction, null>,
      operation: () => Promise<void>,
      successMessage: string | null,
      failureMessage: string,
    ) => {
      if (activeAction != null) return;
      setActiveAction(action);
      void operation().then(
        () => {
          setActiveAction(null);
          if (successMessage) showTransientMessage(successMessage);
        },
        (cause: unknown) => {
          console.error("[scient-images] Inline image action failed", action, cause);
          setActiveAction(null);
          showPersistentMessage(failureMessage);
        },
      );
    },
    [activeAction, showPersistentMessage, showTransientMessage],
  );

  const handleCopyPath = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      showPersistentMessage("Clipboard access is unavailable.");
      return;
    }
    runAction(
      "copy-path",
      () => navigator.clipboard.writeText(props.image.relativePath),
      "Path copied",
      "Unable to copy the image path.",
    );
  }, [props.image.relativePath, runAction, showPersistentMessage]);

  const handleOpenFile = useCallback(() => {
    useRightPanelStore.getState().openFile(props.threadRef, props.image.relativePath);
  }, [props.image.relativePath, props.threadRef]);

  const handleCopyImage = useCallback(() => {
    if (url == null) return;
    runAction(
      "copy-image",
      () => copyStaticImage(url),
      "Image copied",
      "Unable to copy the image.",
    );
  }, [runAction, url]);

  const handleDownload = useCallback(() => {
    if (url == null) return;
    runAction(
      "download",
      () => downloadStaticImage(url, props.image.fileName),
      null,
      "Unable to download the image.",
    );
  }, [props.image.fileName, runAction, url]);

  const handleCycleBackground = useCallback(() => {
    setBackground((current) => nextInlineImageBackground(current));
  }, []);

  return (
    <span
      aria-label={props.image.alt}
      className="my-3 block overflow-hidden rounded-lg border border-border/70 bg-secondary/30 leading-normal"
      data-markdown-copy={props.markdownSource}
      data-scient-inline-workspace-image
      dir="ltr"
      role="figure"
    >
      <span className="flex min-h-9 select-none items-center gap-2 border-b border-border/60 bg-secondary/60 px-2">
        <FileImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" dir="auto">
          {props.image.alt}
        </span>
        <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {inlineImageFormatLabel(props.image.fileName)}
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Image actions">
          {loaded ? (
            <ImageActionButton label="Expand image" onClick={() => setExpanded(true)}>
              <ExpandIcon className="size-3" />
            </ImageActionButton>
          ) : null}
          <ImageActionButton label="Open image file" onClick={handleOpenFile}>
            <FolderOpenIcon className="size-3" />
          </ImageActionButton>
          <InlineImageActionsMenu
            actionMessage={actionMessage}
            activeAction={activeAction}
            background={background}
            compact
            hasImage={url != null}
            onCopyImage={handleCopyImage}
            onCopyPath={handleCopyPath}
            onCycleBackground={handleCycleBackground}
            onDownload={handleDownload}
            onRefresh={handleRetry}
          />
        </span>
      </span>

      {actionMessage != null && !expanded ? (
        <span
          aria-live="polite"
          className="block border-b border-border/40 bg-background/45 px-3 py-1.5 text-muted-foreground text-xs"
        >
          {actionMessage}
        </span>
      ) : null}

      <span
        className={cn(
          "relative flex min-h-52 items-center justify-center overflow-hidden p-3 sm:p-4",
          BACKGROUND_CLASS[background],
        )}
      >
        {loadFailed ? (
          <span className="flex flex-col items-center gap-3 px-5 py-8 text-center">
            <span className="font-medium text-sm">Unable to display this image</span>
            <span className="max-w-lg text-muted-foreground text-xs" dir="auto">
              The file may be missing, incomplete, or in an image format the browser cannot decode.
            </span>
            <span className="flex flex-wrap justify-center gap-2">
              <Button onClick={handleRetry} size="xs" type="button" variant="outline">
                <RefreshCwIcon />
                Try again
              </Button>
              <Button onClick={handleOpenFile} size="xs" type="button" variant="outline">
                <FolderOpenIcon />
                Open file
              </Button>
            </span>
          </span>
        ) : url == null ? (
          <span className="text-muted-foreground text-sm">Loading image…</span>
        ) : (
          <button
            aria-label={`Expand ${props.image.alt}`}
            className={cn(
              "flex w-full min-w-0 max-h-[32rem] cursor-zoom-in items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              loaded ? "opacity-100" : "opacity-0",
            )}
            onClick={() => setExpanded(true)}
            type="button"
          >
            <img
              alt={props.image.alt}
              className="block max-h-[32rem] max-w-full object-contain"
              crossOrigin="anonymous"
              decoding="async"
              draggable={false}
              loading="lazy"
              onError={handleImageError}
              onLoad={() => {
                autoRetriedRef.current = null;
                setFailedUrl(null);
                setLoadedUrl(url);
              }}
              src={url}
            />
          </button>
        )}
        {url != null && !loaded && !loadFailed ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Loading image…
          </span>
        ) : null}
      </span>

      <ScientTooltip content={props.image.displayPath}>
        <span
          className="block truncate border-t border-border/50 bg-secondary/40 px-3 py-1.5 font-mono text-[10px] text-muted-foreground"
          dir="auto"
        >
          {props.image.displayPath}
        </span>
      </ScientTooltip>

      {url != null ? (
        <InlineImageDialog
          actionMessage={actionMessage}
          activeAction={activeAction}
          alt={props.image.alt}
          background={background}
          fileName={props.image.fileName}
          onCopyImage={handleCopyImage}
          onCopyPath={handleCopyPath}
          onCycleBackground={handleCycleBackground}
          onDownload={handleDownload}
          onLoadError={handleImageError}
          onOpenFile={handleOpenFile}
          onOpenChange={setExpanded}
          onRefresh={handleRetry}
          open={expanded}
          revisionKey={revisionKey}
          url={url}
        />
      ) : null}
    </span>
  );
}
