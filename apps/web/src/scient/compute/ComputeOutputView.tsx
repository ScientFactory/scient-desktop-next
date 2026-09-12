import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeProjectedOutput,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { selectComputeRepresentation } from "@t3tools/contracts";
import { CircleAlert, Image as ImageIcon, Info, LoaderCircle, RotateCcw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import {
  StaticImageCopyButton,
  StaticImageDownloadButton,
} from "~/components/preview/StaticImageActionButtons";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  StaticArtifactPresentationActionMenu,
  StaticArtifactPresentationMenu,
} from "~/scient/artifacts/StaticArtifactMenus";

import {
  computeFigurePresentation,
  type ComputeFigurePresentation,
  type ComputeFigureNativeDownload,
} from "./computeFigurePresentation";
import {
  computeProjectedStaticImage,
  computeSystemEventLabel,
  projectComputeFigureOutputs,
} from "./computeResultPresentation";
import { downloadComputeNativeFigure } from "./ComputeOutputViewDownload";
import { computeRichRepresentation } from "./computeRichRepresentation";
import { ComputeRichOutput } from "./ComputeRichOutput";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

function outputKey(output: ComputeProjectedOutput, index: number): string {
  return `${output.sequence}:${output._tag}:${index}`;
}

function ComputeRepresentationFallback(props: {
  readonly output: Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>;
}) {
  const selection = selectComputeRepresentation(props.output.bundle, ["text/plain"]);
  if (selection._tag === "supported" && selection.representation.data._tag === "text") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {selection.representation.data.text}
      </pre>
    );
  }
  return (
    <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 size-3 shrink-0" />
      <span>
        No available renderer for{" "}
        {props.output.bundle.representations.map((item) => item.mediaType).join(", ")}.
      </span>
    </div>
  );
}

function ComputeFigure(props: {
  readonly presentation: ComputeFigurePresentation;
  readonly environmentId: EnvironmentId;
  readonly dimensions: string;
  readonly observedProjectFile: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, props.presentation.inline.resource);
  const isObservedProjectFile =
    props.observedProjectFile || props.presentation.reference._tag === "project-file";

  return (
    <figure className="overflow-hidden rounded-md border border-border/70 bg-card">
      <StaticArtifactPresentationMenu
        artifact={props.presentation.viewer}
        disabled={asset._tag !== "Success"}
        threadRef={props.threadRef}
        triggerClassName="flex min-h-44 w-full cursor-pointer items-center justify-center bg-white p-3 outline-none transition hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {asset._tag === "Success" ? (
          <img
            src={asset.url}
            alt={props.presentation.inline.label}
            loading="lazy"
            className="max-h-[min(60vh,42rem)] max-w-full object-contain"
          />
        ) : asset._tag === "Loading" ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading figure…
          </span>
        ) : (
          <span className="flex items-center gap-2 text-xs text-destructive">
            <ImageIcon className="size-4" /> Figure preview unavailable
          </span>
        )}
      </StaticArtifactPresentationMenu>
      <figcaption className="flex min-h-9 items-center gap-2 border-t border-border/60 px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {props.presentation.inline.label}
        </span>
        {isObservedProjectFile ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="shrink-0 text-[10px] text-muted-foreground"
                  aria-label="Observed project file; this execution is not proven to have created it."
                >
                  Observed project file
                </span>
              }
            />
            <TooltipPopup side="top">
              Observed project file; this execution is not proven to have created it.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">{props.dimensions}</span>
        {asset._tag === "Failure" ? (
          <Button size="icon-xs" variant="ghost" onClick={asset.refresh} aria-label="Retry figure">
            <RotateCcw />
          </Button>
        ) : null}
        <StaticArtifactPresentationActionMenu
          artifact={props.presentation.viewer}
          disabled={asset._tag !== "Success"}
          threadRef={props.threadRef}
        />
        <StaticImageCopyButton
          assetUrl={asset._tag === "Success" ? asset.url : null}
          threadRef={props.threadRef}
        />
        <StaticImageDownloadButton
          assetUrl={asset._tag === "Success" ? asset.url : null}
          fileName={props.presentation.inline.fileName}
          threadRef={props.threadRef}
        />
        {props.presentation.nativeDownload === null ? null : (
          <ComputeNativeFigureDownload
            figure={props.presentation.nativeDownload}
            environmentId={props.environmentId}
            threadRef={props.threadRef}
          />
        )}
      </figcaption>
    </figure>
  );
}

function ComputeNativeFigureDownload(props: {
  readonly figure: ComputeFigureNativeDownload;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, props.figure.resource);
  const [running, setRunning] = useState(false);
  const label = asset._tag === "Failure" ? "Retry FIG download" : "Download MATLAB FIG";
  const download = async () => {
    if (running) return;
    if (asset._tag === "Failure") {
      asset.refresh();
      return;
    }
    if (asset._tag !== "Success") return;
    setRunning(true);
    try {
      await downloadComputeNativeFigure(asset.url, props.figure);
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to download FIG",
          description: cause instanceof Error ? cause.message : "The FIG file is unavailable.",
          data: { threadRef: props.threadRef },
        }),
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={label}
            disabled={running || asset._tag === "Loading"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void download();
            }}
          >
            {running ? <LoaderCircle className="size-3 animate-spin" /> : "FIG"}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

type DiagnosticFrame = Extract<
  ComputeOutput,
  { readonly _tag: "diagnostic" }
>["diagnostic"]["frames"][number];

function ComputeDiagnosticFrames(props: {
  readonly frames: ReadonlyArray<DiagnosticFrame>;
  readonly threadRef: ScopedThreadRef;
}) {
  if (props.frames.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {props.frames.slice(-6).map((frame) => (
        <button
          key={`${frame.relativePath}:${String(frame.line)}:${String(frame.column)}:${frame.functionName ?? ""}`}
          type="button"
          className="cursor-pointer rounded-[4px] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() =>
            useRightPanelStore
              .getState()
              .openFile(props.threadRef, frame.relativePath, frame.line ?? undefined)
          }
        >
          {frame.relativePath}
          {frame.line === null ? "" : `:${String(frame.line)}`}
          {frame.functionName === null ? "" : ` · ${frame.functionName}`}
        </button>
      ))}
    </div>
  );
}

export function ComputeOutputView(props: {
  readonly allowFigureFollowing?: boolean;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly session: ComputeSessionRecord;
  readonly executionId: ComputeExecutionId | null;
  readonly executionGeneration?: ComputeSessionRecord["generation"];
  readonly outputs: ReadonlyArray<ComputeOutput>;
  readonly emptyLabel?: string;
  readonly corruptLineCount?: number;
  readonly clipped?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly source?: ComputeExecutionSource | null;
}) {
  if (props.outputs.length === 0 && !props.corruptLineCount && !props.clipped) {
    return <p className="text-xs text-muted-foreground">{props.emptyLabel ?? "No output."}</p>;
  }

  let imageOrdinal = 0;
  let runtimeDisplayOrdinal = 0;
  return (
    <div className="space-y-2">
      {props.clipped ? (
        <p className="text-[11px] text-warning">
          Earlier live output is hidden. The complete result remains available in run history.
        </p>
      ) : null}
      {props.corruptLineCount ? (
        <p className="text-[11px] text-destructive">
          Part of this result could not be read ({props.corruptLineCount} line
          {props.corruptLineCount === 1 ? "" : "s"}).
        </p>
      ) : null}
      {projectComputeFigureOutputs(props.outputs).map((output, index) => {
        switch (output._tag) {
          case "stream":
            return (
              <pre
                key={outputKey(output, index)}
                className={
                  output.stream === "stderr"
                    ? "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive"
                    : "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
                }
              >
                {output.text}
              </pre>
            );
          case "diagnostic":
            return (
              <div
                key={outputKey(output, index)}
                className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs"
              >
                <div className="flex items-start gap-2">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="font-medium text-destructive">
                      {output.diagnostic.errorName}: {output.diagnostic.message}
                    </p>
                    {output.diagnostic.errorName === "ModuleNotFoundError" ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        className="mt-1"
                        render={
                          <Link
                            to="/settings/scientific-computing"
                            search={{ environmentId: props.environmentId }}
                          />
                        }
                      >
                        Scientific Computing
                      </Button>
                    ) : null}
                    <ComputeDiagnosticFrames
                      frames={output.diagnostic.frames}
                      threadRef={props.threadRef}
                    />
                    {output.diagnostic.traceback.length > 0 ? (
                      <details className="mt-1 text-muted-foreground">
                        <summary className="cursor-pointer">Traceback</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                          {output.diagnostic.traceback.join("\n")}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          case "image": {
            imageOrdinal += 1;
            if (output.origin?._tag === "runtime-display") runtimeDisplayOrdinal += 1;
            const presentation = computeFigurePresentation({
              allowFollowing: props.allowFigureFollowing ?? false,
              cwd: props.cwd,
              session: props.session,
              executionId: props.executionId,
              ...(props.executionGeneration === undefined
                ? {}
                : { executionGeneration: props.executionGeneration }),
              output,
              displayOrdinal: imageOrdinal,
              runtimeDisplayOrdinal,
              source: props.source ?? null,
            });
            return (
              <ComputeFigure
                key={outputKey(output, index)}
                presentation={presentation}
                environmentId={props.environmentId}
                observedProjectFile={output.origin?._tag === "project-file"}
                dimensions={
                  output.width && output.height
                    ? `${output.width} × ${output.height}`
                    : output.mediaType === "image/svg+xml"
                      ? "SVG"
                      : "PNG"
                }
                threadRef={props.threadRef}
              />
            );
          }
          case "system":
            return (
              <div
                key={outputKey(output, index)}
                className="flex items-start gap-2 text-[11px] text-muted-foreground"
              >
                <Info className="mt-0.5 size-3 shrink-0" />
                <span>
                  {computeSystemEventLabel(output.event)}
                  {output.detail ? ` · ${output.detail}` : ""}
                </span>
              </div>
            );
          case "representation": {
            const rich = computeRichRepresentation(output);
            if (rich !== null)
              return <ComputeRichOutput key={outputKey(output, index)} representation={rich} />;
            const image = computeProjectedStaticImage(output);
            if (image === null) {
              return (
                <ComputeRepresentationFallback key={outputKey(output, index)} output={output} />
              );
            }
            imageOrdinal += 1;
            runtimeDisplayOrdinal += 1;
            return (
              <ComputeFigure
                key={outputKey(output, index)}
                presentation={computeFigurePresentation({
                  allowFollowing: props.allowFigureFollowing ?? false,
                  cwd: props.cwd,
                  session: props.session,
                  executionId: props.executionId,
                  ...(props.executionGeneration === undefined
                    ? {}
                    : { executionGeneration: props.executionGeneration }),
                  output: image,
                  displayOrdinal: imageOrdinal,
                  runtimeDisplayOrdinal,
                  source: props.source ?? null,
                })}
                environmentId={props.environmentId}
                observedProjectFile={false}
                dimensions={image.mediaType === "image/svg+xml" ? "SVG" : "PNG"}
                threadRef={props.threadRef}
              />
            );
          }
        }
      })}
    </div>
  );
}
