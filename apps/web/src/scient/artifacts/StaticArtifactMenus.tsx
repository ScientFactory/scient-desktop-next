"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { EyeIcon, ImageIcon, PictureInPicture2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import {
  openStaticArtifactInPanel,
  toggleStaticArtifactFloating,
} from "./staticArtifactViewerActions";

function useStaticArtifactFloating(
  threadRef: ScopedThreadRef,
  artifact: PreviewStaticImageSurfaceDescriptor,
): boolean {
  return usePreviewMiniPlayerStore((state) => {
    const player = selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef);
    return (
      player?.content.kind === "static-artifact" &&
      player.content.artifact.surfaceId === artifact.surfaceId
    );
  });
}

function StaticArtifactPresentationItems(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly floated: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  return (
    <>
      <MenuItem onClick={() => openStaticArtifactInPanel(props.threadRef, props.artifact)}>
        <ImageIcon />
        Open in viewer
      </MenuItem>
      <MenuItem onClick={() => toggleStaticArtifactFloating(props.threadRef, props.artifact)}>
        <PictureInPicture2Icon />
        {props.floated ? "Close floating card" : "Floating card"}
      </MenuItem>
    </>
  );
}

export function StaticArtifactPresentationMenu(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly triggerClassName?: string;
}) {
  const floated = useStaticArtifactFloating(props.threadRef, props.artifact);

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
        <StaticArtifactPresentationItems {...props} floated={floated} />
      </MenuPopup>
    </Menu>
  );
}

export function StaticArtifactPresentationActionMenu(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly disabled?: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  const floated = useStaticArtifactFloating(props.threadRef, props.artifact);

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={props.disabled}
              render={
                <Button
                  aria-label={`Choose how to view ${props.artifact.label}`}
                  data-static-artifact-presentation-action
                  disabled={props.disabled}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          <EyeIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">View options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-44">
        <StaticArtifactPresentationItems {...props} floated={floated} />
      </MenuPopup>
    </Menu>
  );
}
