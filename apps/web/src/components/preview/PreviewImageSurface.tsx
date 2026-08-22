"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { nextPreviewImageZoom } from "./previewImageZoom";
import {
  initialPreviewImageTransitionState,
  previewImageSourceToken,
  reducePreviewImageTransition,
  type PreviewImageSource,
} from "./previewImageTransition";

export type { PreviewImageSource } from "./previewImageTransition";

interface ImageZoomAnchor {
  readonly contentX: number;
  readonly contentY: number;
  readonly localX: number;
  readonly localY: number;
}

const ZOOM_HINT_DURATION_MS = 1_800;

export function previewImageSourceIdentity(source: PreviewImageSource): string {
  return source.revisionKey ?? source.url;
}

/** Shared static-image viewer used by both the right panel and floating preview. */
export function PreviewImageSurface({
  source,
  className,
  onLoadError,
  statusLabel,
}: {
  readonly source: PreviewImageSource;
  readonly className?: string;
  readonly onLoadError?: () => void;
  readonly statusLabel?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomHintTimerRef = useRef<number | null>(null);
  const zoomHintShownRef = useRef(false);
  const pendingZoomDeltaRef = useRef(0);
  const pendingZoomPointRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const pendingZoomAnchorRef = useRef<ImageZoomAnchor | null>(null);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [showZoomHint, setShowZoomHint] = useState(false);
  const [imageState, dispatchImage] = useReducer(
    reducePreviewImageTransition,
    source,
    initialPreviewImageTransitionState,
  );
  const displayedIdentity = imageState.displayed
    ? previewImageSourceIdentity(imageState.displayed)
    : null;

  const dismissZoomHint = () => {
    if (zoomHintTimerRef.current !== null) {
      window.clearTimeout(zoomHintTimerRef.current);
      zoomHintTimerRef.current = null;
    }
    setShowZoomHint(false);
  };

  useEffect(
    () => () => {
      if (zoomFrameRef.current !== null) window.cancelAnimationFrame(zoomFrameRef.current);
      if (zoomHintTimerRef.current !== null) window.clearTimeout(zoomHintTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (zoomFrameRef.current !== null) {
      window.cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
    }
    pendingZoomDeltaRef.current = 0;
    pendingZoomPointRef.current = null;
    pendingZoomAnchorRef.current = null;
    zoomRef.current = 1;
    setZoom(1);
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  }, [displayedIdentity]);

  useEffect(() => {
    dispatchImage({ _tag: "source", source });
  }, [source]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      dismissZoomHint();
      const rect = viewport.getBoundingClientRect();
      pendingZoomDeltaRef.current += event.deltaY;
      pendingZoomPointRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      if (zoomFrameRef.current !== null) return;
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        const point = pendingZoomPointRef.current;
        const delta = pendingZoomDeltaRef.current;
        pendingZoomPointRef.current = null;
        pendingZoomDeltaRef.current = 0;
        if (!point) return;
        const current = zoomRef.current;
        const next = nextPreviewImageZoom(current, delta);
        if (Math.abs(next - current) < 0.001) return;
        pendingZoomAnchorRef.current = {
          contentX: (viewport.scrollLeft + point.x) / current,
          contentY: (viewport.scrollTop + point.y) / current,
          localX: point.x,
          localY: point.y,
        };
        zoomRef.current = next;
        setZoom(next);
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!viewport || !anchor) return;
    pendingZoomAnchorRef.current = null;
    viewport.scrollLeft = anchor.contentX * zoom - anchor.localX;
    viewport.scrollTop = anchor.contentY * zoom - anchor.localY;
  }, [zoom]);

  const handleLoad = (loaded: PreviewImageSource) => {
    dispatchImage({ _tag: "loaded", token: previewImageSourceToken(loaded) });
    if (zoomHintShownRef.current) return;
    zoomHintShownRef.current = true;
    setShowZoomHint(true);
    zoomHintTimerRef.current = window.setTimeout(() => {
      zoomHintTimerRef.current = null;
      setShowZoomHint(false);
    }, ZOOM_HINT_DURATION_MS);
  };

  return (
    <div
      ref={viewportRef}
      className={cn(
        "pointer-events-auto relative overflow-auto overscroll-contain bg-background",
        className,
      )}
      data-preview-image-surface
    >
      <div
        className="relative shrink-0 bg-background"
        style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
      >
        {imageState.displayed ? (
          <img
            key={previewImageSourceToken(imageState.displayed)}
            src={imageState.displayed.url}
            alt={imageState.displayed.alt}
            crossOrigin="anonymous"
            draggable={false}
            className="absolute inset-0 size-full select-none object-contain"
          />
        ) : null}
        {imageState.pending ? (
          <img
            key={previewImageSourceToken(imageState.pending)}
            src={imageState.pending.url}
            alt=""
            aria-hidden="true"
            crossOrigin="anonymous"
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full select-none object-contain opacity-0"
            onLoad={() => {
              if (imageState.pending) handleLoad(imageState.pending);
            }}
            onError={() => {
              if (!imageState.pending) return;
              dismissZoomHint();
              dispatchImage({
                _tag: "failed",
                token: previewImageSourceToken(imageState.pending),
              });
              onLoadError?.();
            }}
          />
        ) : null}
      </div>
      {!imageState.displayed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground">
          {imageState.failed ? "Unable to load figure" : "Loading figure…"}
        </div>
      ) : null}
      {statusLabel ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border/70 bg-popover/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          {statusLabel}
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/70 bg-popover/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm transition-opacity duration-200",
          showZoomHint ? "opacity-100" : "opacity-0",
        )}
      >
        Pinch or Ctrl-scroll to zoom
      </div>
    </div>
  );
}
