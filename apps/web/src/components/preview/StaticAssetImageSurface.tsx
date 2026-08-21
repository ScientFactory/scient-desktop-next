"use client";

import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  previewStaticImageContentKey,
  previewStaticImageReloadKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";

import { PreviewImageSurface } from "./PreviewImageSurface";

interface ResolvedPreviewImage {
  readonly surfaceId: string;
  readonly source: {
    readonly url: string;
    readonly alt: string;
    readonly revisionKey: string;
    readonly loadKey: string;
  };
}

export function StaticAssetImageSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly image: PreviewStaticImageSurfaceDescriptor;
  readonly className?: string;
  readonly refreshToken?: number;
}) {
  // The shared asset atom renews signed URLs every 30 minutes (before the
  // server's 60-minute expiry); this surface only owns revision/error retries.
  const asset = useAssetUrlState(props.environmentId, props.image.resource);
  const autoRetriedRevisionRef = useRef<string | null>(null);
  const previousRefreshTokenRef = useRef(props.refreshToken);
  const contentKey = previewStaticImageContentKey(props.image);
  const reloadKey = previewStaticImageReloadKey(props.image);
  const refreshAsset = asset.refresh;
  const previousReloadKeyRef = useRef(reloadKey);
  const [resolvedImage, setResolvedImage] = useState<ResolvedPreviewImage | null>(null);
  const [retrySequence, setRetrySequence] = useState(0);
  const assetUrl = asset._tag === "Success" ? asset.url : null;
  const loadKey = JSON.stringify([reloadKey, props.refreshToken ?? null, retrySequence]);

  useEffect(() => {
    if (previousRefreshTokenRef.current === props.refreshToken) return;
    previousRefreshTokenRef.current = props.refreshToken;
    autoRetriedRevisionRef.current = null;
    refreshAsset();
  }, [props.refreshToken, refreshAsset]);

  useEffect(() => {
    if (previousReloadKeyRef.current === reloadKey) return;
    previousReloadKeyRef.current = reloadKey;
    autoRetriedRevisionRef.current = null;
    refreshAsset();
  }, [refreshAsset, reloadKey]);

  useEffect(() => {
    if (assetUrl === null) return;
    setResolvedImage((current) => {
      const next: ResolvedPreviewImage = {
        surfaceId: props.image.surfaceId,
        source: {
          url: assetUrl,
          alt: props.image.label,
          revisionKey: contentKey,
          loadKey,
        },
      };
      return current?.surfaceId === next.surfaceId &&
        current.source.url === next.source.url &&
        current.source.alt === next.source.alt &&
        current.source.revisionKey === next.source.revisionKey &&
        current.source.loadKey === next.source.loadKey
        ? current
        : next;
    });
  }, [assetUrl, contentKey, loadKey, props.image.label, props.image.surfaceId]);

  const visibleImage =
    resolvedImage?.surfaceId === props.image.surfaceId ? resolvedImage.source : null;

  if (visibleImage === null) {
    return (
      <div
        className={cn(
          "flex min-h-0 items-center justify-center bg-background text-xs text-muted-foreground",
          props.className,
        )}
      >
        {asset._tag !== "Failure" ? (
          "Loading figure…"
        ) : (
          <div className="flex items-center gap-2">
            <span>Unable to load figure</span>
            <Button size="xs" variant="outline" onClick={refreshAsset}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <PreviewImageSurface
      source={visibleImage}
      {...(props.className === undefined ? {} : { className: props.className })}
      {...(props.image.statusLabel === undefined
        ? asset._tag === "Failure"
          ? { statusLabel: "Unable to refresh" }
          : {}
        : { statusLabel: props.image.statusLabel })}
      onLoadError={() => {
        if (autoRetriedRevisionRef.current === reloadKey) return;
        autoRetriedRevisionRef.current = reloadKey;
        setRetrySequence((value) => value + 1);
        refreshAsset();
      }}
    />
  );
}
