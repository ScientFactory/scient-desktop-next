"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ImageIcon,
  LoaderCircleIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import { copyStaticImage, downloadStaticImage } from "./staticImageActions";
import {
  openStaticArtifactInPanel,
  toggleStaticArtifactFloating,
} from "./staticArtifactViewerActions";

export function StaticArtifactPresentationMenu(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly triggerClassName?: string;
}) {
  const floated = usePreviewMiniPlayerStore((state) => {
    const player = selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef);
    return (
      player?.content.kind === "static-artifact" &&
      player.content.artifact.surfaceId === props.artifact.surfaceId
    );
  });

  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <button
            aria-label={`Choose how to view ${props.artifact.label}`}
            className={props.triggerClassName}
            data-static-artifact-presentation-trigger
            disabled={props.disabled}
            type="button"
          >
            {props.children}
          </button>
        }
      />
      <MenuPopup align="center" className="min-w-44">
        <MenuItem onClick={() => openStaticArtifactInPanel(props.threadRef, props.artifact)}>
          <ImageIcon />
          Open in viewer
        </MenuItem>
        <MenuItem onClick={() => toggleStaticArtifactFloating(props.threadRef, props.artifact)}>
          <PictureInPicture2Icon />
          {floated ? "Close floating card" : "Floating card"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

type StaticArtifactFileAction = "copy" | "download" | null;

export function StaticArtifactFileActionsMenu(props: {
  readonly assetUrl: string | null;
  readonly fileName: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const [activeAction, setActiveAction] = useState<StaticArtifactFileAction>(null);

  const reportFailure = (action: Exclude<StaticArtifactFileAction, null>, cause: unknown) => {
    console.error("[scient-artifacts] Static image action failed", action, cause);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: action === "copy" ? "Unable to copy image" : "Unable to download image",
        description: cause instanceof Error ? cause.message : "The image action failed.",
        data: { threadRef: props.threadRef },
      }),
    );
  };

  const runAction = async (action: Exclude<StaticArtifactFileAction, null>) => {
    if (activeAction !== null || props.assetUrl === null) return;
    setActiveAction(action);
    try {
      if (action === "copy") {
        await copyStaticImage(props.assetUrl);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Image copied",
            timeout: 1_800,
            data: { threadRef: props.threadRef },
          }),
        );
      } else {
        await downloadStaticImage(props.assetUrl, props.fileName);
      }
    } catch (cause) {
      reportFailure(action, cause);
    } finally {
      setActiveAction(null);
    }
  };

  const actionLabel =
    activeAction === "copy"
      ? "Copying image…"
      : activeAction === "download"
        ? "Preparing download…"
        : "More figure actions";

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={props.assetUrl === null || activeAction !== null}
              render={
                <Button
                  aria-label={actionLabel}
                  data-static-artifact-file-actions
                  disabled={props.assetUrl === null || activeAction !== null}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          {activeAction === null ? <EllipsisIcon /> : <LoaderCircleIcon className="animate-spin" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{actionLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem
          disabled={props.assetUrl === null || activeAction !== null}
          onClick={() => void runAction("copy")}
        >
          <CopyIcon />
          Copy image
        </MenuItem>
        <MenuItem
          disabled={props.assetUrl === null || activeAction !== null}
          onClick={() => void runAction("download")}
        >
          <DownloadIcon />
          Download original
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
