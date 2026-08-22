"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { CopyIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { copyStaticImage, downloadStaticImage } from "./staticImageActions";

interface StaticImageActionButtonBaseProps {
  readonly assetUrl: string | null;
  readonly disabled?: boolean;
  readonly threadRef: ScopedThreadRef;
}

type StaticImageActionButtonProps = StaticImageActionButtonBaseProps &
  ({ readonly action: "copy" } | { readonly action: "download"; readonly fileName: string });

function addThreadToast(
  threadRef: ScopedThreadRef,
  toast: Omit<Parameters<typeof stackedThreadToast>[0], "data">,
) {
  toastManager.add(stackedThreadToast({ ...toast, data: { threadRef } }));
}

function StaticImageActionButton(props: StaticImageActionButtonProps) {
  const [running, setRunning] = useState(false);
  const isCopy = props.action === "copy";
  const idleLabel = isCopy ? "Copy image" : "Download original";
  const runningLabel = isCopy ? "Copying image…" : "Preparing download…";

  const runAction = async () => {
    if (running || props.assetUrl === null) return;
    setRunning(true);
    try {
      if (props.action === "copy") {
        await copyStaticImage(props.assetUrl);
        addThreadToast(props.threadRef, {
          type: "success",
          title: "Image copied",
          timeout: 1_800,
        });
      } else {
        await downloadStaticImage(props.assetUrl, props.fileName);
      }
    } catch (cause) {
      console.error(`[preview] ${idleLabel} failed`, cause);
      addThreadToast(props.threadRef, {
        type: "error",
        title: isCopy ? "Unable to copy image" : "Unable to download image",
        description: cause instanceof Error ? cause.message : "The image action failed.",
      });
    } finally {
      setRunning(false);
    }
  };

  const isDisabled = props.disabled || props.assetUrl === null || running;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={running ? runningLabel : idleLabel}
            disabled={isDisabled}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void runAction();
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {running ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : isCopy ? (
          <CopyIcon />
        ) : (
          <DownloadIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{running ? runningLabel : idleLabel}</TooltipPopup>
    </Tooltip>
  );
}

export function StaticImageCopyButton(props: StaticImageActionButtonBaseProps) {
  return <StaticImageActionButton {...props} action="copy" />;
}

export function StaticImageDownloadButton(
  props: StaticImageActionButtonBaseProps & { readonly fileName: string },
) {
  return <StaticImageActionButton {...props} action="download" />;
}
