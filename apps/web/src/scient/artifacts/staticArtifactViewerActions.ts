import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { useRightPanelStore } from "~/rightPanelStore";
import { scientArtifactSurfaceId } from "~/scient/rightPanel/surfaces";

export function openStaticArtifactInPanel(
  threadRef: ScopedThreadRef,
  artifact: PreviewStaticImageSurfaceDescriptor,
): void {
  const miniPlayerStore = usePreviewMiniPlayerStore.getState();
  const miniPlayer = selectThreadPreviewMiniPlayer(miniPlayerStore.byThreadKey, threadRef);
  if (
    miniPlayer?.content.kind === "static-artifact" &&
    miniPlayer.content.artifact.surfaceId === artifact.surfaceId
  ) {
    miniPlayerStore.close(threadRef);
  }
  useRightPanelStore.getState().openScientArtifact(threadRef, artifact);
}

/** Keep one large presentation of a static artifact: full panel or floating. */
export function toggleStaticArtifactFloating(
  threadRef: ScopedThreadRef,
  artifact: PreviewStaticImageSurfaceDescriptor,
): void {
  const miniPlayerStore = usePreviewMiniPlayerStore.getState();
  const miniPlayer = selectThreadPreviewMiniPlayer(miniPlayerStore.byThreadKey, threadRef);
  if (
    miniPlayer?.content.kind === "static-artifact" &&
    miniPlayer.content.artifact.surfaceId === artifact.surfaceId
  ) {
    miniPlayerStore.close(threadRef);
    return;
  }

  miniPlayerStore.openArtifact(threadRef, artifact);
  useRightPanelStore.getState().closeSurface(threadRef, scientArtifactSurfaceId(artifact));
}
