"use client";

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { PictureInPicture2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { StaticAssetImageSurface } from "~/components/preview/StaticAssetImageSurface";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { scientArtifactSurfaceId } from "~/scient/rightPanel/surfaces";

export function ScientArtifactPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef),
  );
  const floated =
    miniPlayer?.content.kind === "static-artifact" &&
    miniPlayer.content.artifact.surfaceId === props.artifact.surfaceId;

  const toggleFloating = () => {
    if (floated) {
      usePreviewMiniPlayerStore.getState().close(props.threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().openArtifact(props.threadRef, props.artifact);
    useRightPanelStore
      .getState()
      .closeSurface(props.threadRef, scientArtifactSurfaceId(props.artifact));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="surface-subheader gap-1 px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {props.artifact.fileName}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setRefreshToken((value) => value + 1)}
                aria-label="Refresh figure"
              />
            }
          >
            <RefreshCw />
          </TooltipTrigger>
          <TooltipPopup>Refresh figure</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={floated ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={toggleFloating}
                aria-label={floated ? "Close floating figure" : "Float figure over chat"}
                aria-pressed={floated ? "true" : "false"}
              />
            }
          >
            <PictureInPicture2 className={floated ? "text-primary" : undefined} />
          </TooltipTrigger>
          <TooltipPopup>{floated ? "Close floating figure" : "Float over chat"}</TooltipPopup>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <StaticAssetImageSurface
          environmentId={props.environmentId}
          image={props.artifact}
          refreshToken={refreshToken}
          className="absolute inset-0"
        />
      </div>
    </div>
  );
}
