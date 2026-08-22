import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, EnvironmentFilePath, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { scientArtifactSurfaceId } from "~/scient/rightPanel/surfaces";

import {
  openStaticArtifactInPanel,
  toggleStaticArtifactFloating,
} from "./staticArtifactViewerActions";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const artifact: PreviewStaticImageSurfaceDescriptor = {
  surfaceId: "figure:stable",
  label: "Figure 1",
  fileName: "figure-1.svg",
  mediaType: "image/svg+xml",
  sourcePath: "analysis.py",
  resource: {
    _tag: "environment-file",
    path: EnvironmentFilePath.make("/project/figure-1.svg"),
    access: "exact",
  },
};

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("static artifact viewer actions", () => {
  it("moves one artifact from the full panel into the floating viewer", () => {
    useRightPanelStore.getState().openScientArtifact(threadRef, artifact);

    toggleStaticArtifactFloating(threadRef, artifact);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ content: { kind: "static-artifact", artifact } });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).not.toContainEqual(expect.objectContaining({ id: scientArtifactSurfaceId(artifact) }));
  });

  it("moves one artifact back to the full panel without leaving a duplicate", () => {
    usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);

    openStaticArtifactInPanel(threadRef, artifact);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toBeNull();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toContainEqual(expect.objectContaining({ id: scientArtifactSurfaceId(artifact) }));
  });

  it("closes an already floating artifact without disturbing panel state", () => {
    useRightPanelStore.getState().open(threadRef, "files");
    usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);

    toggleStaticArtifactFloating(threadRef, artifact);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toBeNull();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([{ id: "files", kind: "files" }]);
  });
});
