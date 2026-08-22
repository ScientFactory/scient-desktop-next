import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import {
  previewStaticImageDescriptorKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "./previewStaticImageSurface";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export interface PreviewMiniPlayerRect {
  readonly position: PreviewMiniPlayerPosition;
  readonly size: PreviewMiniPlayerSize;
}

export type PreviewMiniPlayerContent =
  | { readonly kind: "browser"; readonly id: string; readonly tabId: string }
  | {
      readonly kind: "static-artifact";
      readonly id: string;
      readonly artifact: PreviewStaticImageSurfaceDescriptor;
    };

export interface PreviewMiniPlayerState {
  readonly content: PreviewMiniPlayerContent;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly size: PreviewMiniPlayerSize | null;
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (
    ref: ScopedThreadRef,
    tabId: string,
    position?: PreviewMiniPlayerPosition,
  ) => void;
  readonly openArtifact: (
    ref: ScopedThreadRef,
    artifact: PreviewStaticImageSurfaceDescriptor,
    position?: PreviewMiniPlayerPosition,
  ) => void;
  readonly updateArtifact: (
    ref: ScopedThreadRef,
    artifact: PreviewStaticImageSurfaceDescriptor,
  ) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly move: (
    ref: ScopedThreadRef,
    contentId: string,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (ref: ScopedThreadRef, contentId: string, size: PreviewMiniPlayerSize) => void;
  readonly setRect: (ref: ScopedThreadRef, contentId: string, rect: PreviewMiniPlayerRect) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

function artifactContent(artifact: PreviewStaticImageSurfaceDescriptor): PreviewMiniPlayerContent {
  return { kind: "static-artifact", id: artifact.surfaceId, artifact };
}

function artifactEquals(
  left: PreviewStaticImageSurfaceDescriptor,
  right: PreviewStaticImageSurfaceDescriptor,
): boolean {
  return previewStaticImageDescriptorKey(left) === previewStaticImageDescriptorKey(right);
}

function openContent(
  current: PreviewMiniPlayerState | undefined,
  content: PreviewMiniPlayerContent,
  position: PreviewMiniPlayerPosition | undefined,
): PreviewMiniPlayerState {
  return {
    content,
    position: position ?? current?.position ?? null,
    size: current?.size ?? null,
  };
}

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  open: (ref, tabId, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      const nextPosition = position ?? current?.position ?? null;
      if (
        current?.content.kind === "browser" &&
        current.content.tabId === tabId &&
        current.position?.x === nextPosition?.x &&
        current.position?.y === nextPosition?.y
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: openContent(current, { kind: "browser", id: tabId, tabId }, position),
        },
      };
    }),
  openArtifact: (ref, artifact, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      const nextPosition = position ?? current?.position ?? null;
      if (
        current?.content.kind === "static-artifact" &&
        artifactEquals(current.content.artifact, artifact) &&
        current.position?.x === nextPosition?.x &&
        current.position?.y === nextPosition?.y
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: openContent(current, artifactContent(artifact), position),
        },
      };
    }),
  updateArtifact: (ref, artifact) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (
        current?.content.kind !== "static-artifact" ||
        current.content.artifact.surfaceId !== artifact.surfaceId ||
        artifactEquals(current.content.artifact, artifact)
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, content: artifactContent(artifact) },
        },
      };
    }),
  close: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  move: (ref, contentId, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.content.id !== contentId) return state;
      if (current.position?.x === position.x && current.position.y === position.y) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position },
        },
      };
    }),
  resize: (ref, contentId, size) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.content.id !== contentId) return state;
      if (current.size?.width === size.width && current.size.height === size.height) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, size },
        },
      };
    }),
  setRect: (ref, contentId, rect) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.content.id !== contentId) return state;
      if (
        current.position?.x === rect.position.x &&
        current.position.y === rect.position.y &&
        current.size?.width === rect.size.width &&
        current.size.height === rect.size.height
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position: rect.position, size: rect.size },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}
