import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { copyInlineImage, downloadInlineImage } from "~/scient/images/inlineImageActions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [activeAction, setActiveAction] = useState<"copy" | "download" | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[index];
  useEffect(() => {
    setActionMessage(null);
  }, [item?.src]);
  if (!item) return null;

  const runImageAction = async (action: "copy" | "download") => {
    setActiveAction(action);
    setActionMessage(null);
    try {
      if (action === "copy") {
        await copyInlineImage(item.src);
        setActionMessage("Image copied");
      } else {
        await downloadInlineImage(item.src, item.name);
        setActionMessage("Download started");
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : `Unable to ${action} the image.`);
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md bg-background/85 p-1 shadow-sm backdrop-blur-sm">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Copy image"
                  disabled={activeAction !== null}
                  onClick={() => void runImageAction("copy")}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <CopyIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {activeAction === "copy" ? "Copying image…" : "Copy image"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Download image"
                  disabled={activeAction !== null}
                  onClick={() => void runImageAction("download")}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {activeAction === "download" ? "Preparing download…" : "Download image"}
            </TooltipPopup>
          </Tooltip>
          <Button
            aria-label="Close image preview"
            onClick={onClose}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          crossOrigin="anonymous"
          draggable={false}
        />
        <div className="mt-2 max-w-[92vw] text-center text-xs text-white/80">
          <p className="truncate">
            {item.name}
            {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
          </p>
          {actionMessage ? (
            <p aria-live="polite" className="mt-1 text-white/70">
              {actionMessage}
            </p>
          ) : null}
        </div>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
